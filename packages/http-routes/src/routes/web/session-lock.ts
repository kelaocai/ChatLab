/**
 * Session password lock (personal feature).
 *
 * Access lock, not at-rest encryption: locked sessions require password
 * verification before any content route (Web UI, REST API, AI entry points)
 * can be used. A successful verification issues an HMAC-signed unlock token
 * valid for 7 days; clients send it via the `x-session-unlock` header.
 *
 * This module is self-contained on purpose: it registers its management
 * routes plus one global preHandler hook, so the only upstream touch point
 * is a single call in ../register.ts.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { RuntimeRouteContext } from '../../context/runtime'

export const SESSION_LOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_LOCK_HEADER = 'x-session-unlock'
export const SESSION_LOCK_ERROR_CODE = 'SESSION_LOCKED'
export const SESSION_LOCK_MIN_PASSWORD_LENGTH = 4

const SCRYPT_KEYLEN = 32

interface SessionLockRecord {
  salt: string
  hash: string
  createdAt: number
}

interface SessionLockFile {
  version: number
  /** Random HMAC secret for unlock tokens, generated on first use. */
  secret: string
  locks: Record<string, SessionLockRecord>
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Persistent store for per-session password locks. */
export class SessionLockStore {
  private filePath: string
  private data: SessionLockFile | null = null

  constructor(systemDir: string) {
    this.filePath = path.join(systemDir, 'session-locks.json')
  }

  private load(): SessionLockFile {
    if (this.data) return this.data
    let parsed: Partial<SessionLockFile> = {}
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch {
      // Missing or corrupt file starts fresh; the next save rewrites it.
    }
    this.data = {
      version: 1,
      secret: typeof parsed.secret === 'string' && parsed.secret ? parsed.secret : crypto.randomBytes(32).toString('hex'),
      locks: parsed.locks && typeof parsed.locks === 'object' ? parsed.locks : {},
    }
    return this.data
  }

  private save(): void {
    const data = this.load()
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.filePath)
  }

  isLocked(sessionId: string): boolean {
    return sessionId in this.load().locks
  }

  setLock(sessionId: string, password: string): void {
    const salt = crypto.randomBytes(16).toString('hex')
    this.load().locks[sessionId] = { salt, hash: hashPassword(password, salt), createdAt: Date.now() }
    this.save()
  }

  removeLock(sessionId: string): void {
    delete this.load().locks[sessionId]
    this.save()
  }

  verifyPassword(sessionId: string, password: string): boolean {
    const record = this.load().locks[sessionId]
    if (!record) return false
    return safeEqualHex(hashPassword(password, record.salt), record.hash)
  }

  issueUnlockToken(sessionId: string, now = Date.now()): { token: string; expiresAt: number } {
    const expiresAt = now + SESSION_LOCK_TTL_MS
    const payload = base64url(JSON.stringify({ sid: sessionId, exp: expiresAt }))
    const sig = crypto.createHmac('sha256', this.load().secret).update(payload).digest('base64url')
    return { token: `${payload}.${sig}`, expiresAt }
  }

  verifyUnlockToken(token: string, sessionId: string, now = Date.now()): boolean {
    const dot = token.lastIndexOf('.')
    if (dot <= 0) return false
    const payload = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const expected = crypto.createHmac('sha256', this.load().secret).update(payload).digest('base64url')
    const sigBuf = Buffer.from(sig)
    const expectedBuf = Buffer.from(expected)
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      return parsed.sid === sessionId && typeof parsed.exp === 'number' && parsed.exp > now
    } catch {
      return false
    }
  }
}

const LOCK_MANAGEMENT_PATH = /^\/_web\/sessions\/[^/]+\/lock(?:\/verify)?(?:\?|$)/
const SESSION_CONTENT_PATH = /^\/(?:_web|api\/v1)\/sessions\/([^/?]+)/
const AI_ENTRY_PATHS = ['/_web/ai/chats', '/_web/ai/agent/stream']

/** Extract the session id a request targets, or null when the request is not session-scoped. */
export function extractLockedSessionId(request: FastifyRequest): string | null {
  const url = request.url
  if (LOCK_MANAGEMENT_PATH.test(url)) return null
  const contentMatch = SESSION_CONTENT_PATH.exec(url)
  if (contentMatch) return decodeURIComponent(contentMatch[1])
  if (AI_ENTRY_PATHS.some((p) => url === p || url.startsWith(`${p}?`))) {
    const body = request.body as { sessionId?: unknown } | null | undefined
    if (body && typeof body.sessionId === 'string') return body.sessionId
    const query = request.query as { sessionId?: unknown } | undefined
    if (query && typeof query.sessionId === 'string') return query.sessionId
  }
  return null
}

function hasValidUnlockHeader(request: FastifyRequest, store: SessionLockStore, sessionId: string): boolean {
  const header = request.headers[SESSION_LOCK_HEADER]
  const token = Array.isArray(header) ? header[0] : header
  return typeof token === 'string' && store.verifyUnlockToken(token, sessionId)
}

export type SessionLockRouteContext = Pick<RuntimeRouteContext, 'pathProvider'>

/**
 * Register lock management routes and the global enforcement hook.
 * Must be called BEFORE any other route registration: Fastify hooks only
 * apply to routes registered after them.
 */
export function registerSessionLockRoutes(server: FastifyInstance, ctx: SessionLockRouteContext): SessionLockStore {
  const store = new SessionLockStore(ctx.pathProvider.getSystemDir())

  server.addHook('preHandler', async (request, reply) => {
    const sessionId = extractLockedSessionId(request)
    if (!sessionId || !store.isLocked(sessionId)) return
    if (hasValidUnlockHeader(request, store, sessionId)) return
    return reply.code(423).send({
      success: false,
      error: { code: SESSION_LOCK_ERROR_CODE, message: 'Session is locked. Password verification required.' },
    })
  })

  server.get<{ Params: { id: string } }>('/_web/sessions/:id/lock', async (request) => {
    const { id } = request.params
    return { locked: store.isLocked(id), unlocked: hasValidUnlockHeader(request, store, id) }
  })

  server.put<{ Params: { id: string }; Body: { password?: string; oldPassword?: string } }>(
    '/_web/sessions/:id/lock',
    async (request, reply) => {
      const { id } = request.params
      const password = request.body?.password
      if (typeof password !== 'string' || password.length < SESSION_LOCK_MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({
          success: false,
          error: { code: 'INVALID_PASSWORD', message: `Password must be at least ${SESSION_LOCK_MIN_PASSWORD_LENGTH} characters.` },
        })
      }
      if (store.isLocked(id)) {
        const oldPassword = request.body?.oldPassword
        const allowed =
          (typeof oldPassword === 'string' && store.verifyPassword(id, oldPassword)) ||
          hasValidUnlockHeader(request, store, id)
        if (!allowed) {
          return reply.code(401).send({
            success: false,
            error: { code: 'INVALID_PASSWORD', message: 'Current password is incorrect.' },
          })
        }
      }
      store.setLock(id, password)
      return { success: true }
    }
  )

  server.delete<{ Params: { id: string }; Body: { password?: string } }>(
    '/_web/sessions/:id/lock',
    async (request, reply) => {
      const { id } = request.params
      if (!store.isLocked(id)) return { success: true }
      const password = request.body?.password
      if (typeof password !== 'string' || !store.verifyPassword(id, password)) {
        return reply.code(401).send({
          success: false,
          error: { code: 'INVALID_PASSWORD', message: 'Password is incorrect.' },
        })
      }
      store.removeLock(id)
      return { success: true }
    }
  )

  server.post<{ Params: { id: string }; Body: { password?: string } }>(
    '/_web/sessions/:id/lock/verify',
    async (request, reply) => {
      const { id } = request.params
      const password = request.body?.password
      if (!store.isLocked(id)) {
        const { token, expiresAt } = store.issueUnlockToken(id)
        return { locked: false, token, expiresAt }
      }
      if (typeof password !== 'string' || !store.verifyPassword(id, password)) {
        return reply.code(401).send({
          success: false,
          error: { code: 'INVALID_PASSWORD', message: 'Password is incorrect.' },
        })
      }
      const { token, expiresAt } = store.issueUnlockToken(id)
      return { locked: true, token, expiresAt }
    }
  )

  return store
}
