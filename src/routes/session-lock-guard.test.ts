/**
 * Run: pnpm test -- src/routes/session-lock-guard.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSessionLockNavigation } from './session-lock-guard'

const baseContext = {
  routeName: 'group-chat',
  sessionId: 'session-1',
  fullPath: '/group-chat/session-1',
  hasUnlockToken: () => false,
  fetchLockStatus: async () => ({ locked: true, unlocked: false }),
}

test('redirects to the unlock page when the session is locked without a token', async () => {
  assert.deepEqual(await resolveSessionLockNavigation(baseContext), {
    name: 'session-lock',
    params: { id: 'session-1' },
    query: { redirect: '/group-chat/session-1' },
  })
})

test('lets non-chat routes pass through', async () => {
  assert.equal(await resolveSessionLockNavigation({ ...baseContext, routeName: 'home' }), null)
})

test('lets requests with a cached unlock token pass through without a network call', async () => {
  let called = false
  const target = await resolveSessionLockNavigation({
    ...baseContext,
    hasUnlockToken: () => true,
    fetchLockStatus: async () => {
      called = true
      return { locked: true, unlocked: false }
    },
  })
  assert.equal(target, null)
  assert.equal(called, false)
})

test('lets unlocked sessions pass through', async () => {
  const target = await resolveSessionLockNavigation({
    ...baseContext,
    fetchLockStatus: async () => ({ locked: false, unlocked: false }),
  })
  assert.equal(target, null)
})

test('lets requests pass through when the lock status request fails', async () => {
  const target = await resolveSessionLockNavigation({
    ...baseContext,
    fetchLockStatus: async () => {
      throw new Error('network error')
    },
  })
  assert.equal(target, null)
})
