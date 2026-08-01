import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerSessionLockRoutes, SessionLockStore, SESSION_LOCK_TTL_MS } from './session-lock'
import type { SessionLockRouteContext } from './session-lock'

function makeCtx(systemDir: string): SessionLockRouteContext {
  return { pathProvider: { getSystemDir: () => systemDir } } as unknown as SessionLockRouteContext
}

describe('SessionLockStore', () => {
  let dir: string
  let store: SessionLockStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lock-'))
    store = new SessionLockStore(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('locks, verifies and removes a session', () => {
    assert.equal(store.isLocked('s1'), false)
    store.setLock('s1', 'secret-pw')
    assert.equal(store.isLocked('s1'), true)
    assert.equal(store.verifyPassword('s1', 'secret-pw'), true)
    assert.equal(store.verifyPassword('s1', 'wrong'), false)
    store.removeLock('s1')
    assert.equal(store.isLocked('s1'), false)
  })

  it('persists locks across instances with 0600 permissions', () => {
    store.setLock('s1', 'secret-pw')
    const stat = fs.statSync(path.join(dir, 'session-locks.json'))
    assert.equal(stat.mode & 0o777, 0o600)
    const reloaded = new SessionLockStore(dir)
    assert.equal(reloaded.isLocked('s1'), true)
    assert.equal(reloaded.verifyPassword('s1', 'secret-pw'), true)
  })

  it('issues tokens that verify only for the same session within 7 days', () => {
    store.setLock('s1', 'secret-pw')
    const now = Date.now()
    const { token, expiresAt } = store.issueUnlockToken('s1', now)
    assert.equal(expiresAt, now + SESSION_LOCK_TTL_MS)
    assert.equal(store.verifyUnlockToken(token, 's1', now), true)
    // different session
    assert.equal(store.verifyUnlockToken(token, 's2', now), false)
    // expired
    assert.equal(store.verifyUnlockToken(token, 's1', now + SESSION_LOCK_TTL_MS + 1), false)
    // just before expiry still valid
    assert.equal(store.verifyUnlockToken(token, 's1', now + SESSION_LOCK_TTL_MS - 1000), true)
    // tampered payload
    assert.equal(store.verifyUnlockToken(`${token}x`, 's1', now), false)
    assert.equal(store.verifyUnlockToken('garbage', 's1', now), false)
  })

  it('rejects tokens signed with a different secret', () => {
    store.setLock('s1', 'secret-pw')
    const { token } = store.issueUnlockToken('s1')
    const other = new SessionLockStore(fs.mkdtempSync(path.join(os.tmpdir(), 'session-lock-other-')))
    assert.equal(other.verifyUnlockToken(token, 's1'), false)
  })
})

describe('session lock routes and enforcement hook', () => {
  let dir: string
  let server: FastifyInstance

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lock-route-'))
    server = Fastify()
    registerSessionLockRoutes(server, makeCtx(dir))
    // Dummy content routes registered AFTER the lock module, mirroring real
    // registration order; they stand in for the real session routes.
    server.get('/_web/sessions/:id/sql', async () => ({ ok: true }))
    server.get('/api/v1/sessions/:id/messages', async () => ({ ok: true }))
    server.post('/_web/ai/chats', async () => ({ ok: true }))
    server.post('/_web/ai/agent/stream', async () => ({ ok: true }))
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function lockSession(id = 's1', password = 'secret-pw') {
    const res = await server.inject({
      method: 'PUT',
      url: `/_web/sessions/${id}/lock`,
      payload: { password },
    })
    assert.equal(res.statusCode, 200)
  }

  async function verifySession(id = 's1', password = 'secret-pw') {
    return server.inject({ method: 'POST', url: `/_web/sessions/${id}/lock/verify`, payload: { password } })
  }

  it('lists locked session ids in bulk', async () => {
    assert.deepEqual((await server.inject({ method: 'GET', url: '/_web/session-locks' })).json(), { lockedIds: [] })
    await lockSession('s1')
    await lockSession('s2')
    const res = await server.inject({ method: 'GET', url: '/_web/session-locks' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().lockedIds.sort(), ['s1', 's2'])
  })

  it('enforces 423 on web and REST content routes for locked sessions', async () => {
    await lockSession()
    for (const url of ['/_web/sessions/s1/sql', '/api/v1/sessions/s1/messages']) {
      const res = await server.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 423, url)
      assert.equal(res.json().error.code, 'SESSION_LOCKED')
    }
  })

  it('does not block unlocked sessions', async () => {
    const res = await server.inject({ method: 'GET', url: '/_web/sessions/s2/sql' })
    assert.equal(res.statusCode, 200)
  })

  it('rejects wrong passwords and accepts the correct one', async () => {
    await lockSession()
    const wrong = await verifySession('s1', 'nope')
    assert.equal(wrong.statusCode, 401)
    const right = await verifySession()
    assert.equal(right.statusCode, 200)
    const body = right.json()
    assert.equal(body.locked, true)
    assert.ok(body.token)
    assert.ok(body.expiresAt > Date.now())
  })

  it('allows content access with a valid unlock token', async () => {
    await lockSession()
    const { token } = (await verifySession()).json()
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/sessions/s1/messages',
      headers: { 'x-session-unlock': token },
    })
    assert.equal(res.statusCode, 200)
  })

  it('accepts any matching token from a comma-separated header', async () => {
    await lockSession()
    const { token } = (await verifySession()).json()
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/sessions/s1/messages',
      headers: { 'x-session-unlock': `bogus.token, ${token}` },
    })
    assert.equal(res.statusCode, 200)
    const onlyBogus = await server.inject({
      method: 'GET',
      url: '/api/v1/sessions/s1/messages',
      headers: { 'x-session-unlock': 'bogus.token, another.one' },
    })
    assert.equal(onlyBogus.statusCode, 423)
  })

  it('blocks AI entry points carrying a locked sessionId', async () => {
    await lockSession()
    const create = await server.inject({ method: 'POST', url: '/_web/ai/chats', payload: { sessionId: 's1' } })
    assert.equal(create.statusCode, 423)
    assert.equal(create.json().error.sessionId, 's1')
    const stream = await server.inject({ method: 'POST', url: '/_web/ai/agent/stream', payload: { sessionId: 's1' } })
    assert.equal(stream.statusCode, 423)
    const { token } = (await verifySession()).json()
    const allowed = await server.inject({
      method: 'POST',
      url: '/_web/ai/chats',
      payload: { sessionId: 's1' },
      headers: { 'x-session-unlock': token },
    })
    assert.equal(allowed.statusCode, 200)
  })

  it('keeps lock management endpoints reachable while locked', async () => {
    await lockSession()
    const status = await server.inject({ method: 'GET', url: '/_web/sessions/s1/lock' })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(status.json(), { locked: true, unlocked: false })
  })

  it('requires the old password or a valid token to change the password', async () => {
    await lockSession()
    const denied = await server.inject({
      method: 'PUT',
      url: '/_web/sessions/s1/lock',
      payload: { password: 'new-pw' },
    })
    assert.equal(denied.statusCode, 401)
    const changed = await server.inject({
      method: 'PUT',
      url: '/_web/sessions/s1/lock',
      payload: { password: 'new-pw', oldPassword: 'secret-pw' },
    })
    assert.equal(changed.statusCode, 200)
    assert.equal((await verifySession('s1', 'new-pw')).statusCode, 200)
  })

  it('rejects too-short passwords', async () => {
    const res = await server.inject({ method: 'PUT', url: '/_web/sessions/s1/lock', payload: { password: 'abc' } })
    assert.equal(res.statusCode, 400)
  })

  it('removes the lock with the correct password', async () => {
    await lockSession()
    const denied = await server.inject({
      method: 'DELETE',
      url: '/_web/sessions/s1/lock',
      payload: { password: 'nope' },
    })
    assert.equal(denied.statusCode, 401)
    const removed = await server.inject({
      method: 'DELETE',
      url: '/_web/sessions/s1/lock',
      payload: { password: 'secret-pw' },
    })
    assert.equal(removed.statusCode, 200)
    assert.equal((await server.inject({ method: 'GET', url: '/_web/sessions/s1/sql' })).statusCode, 200)
  })
})
