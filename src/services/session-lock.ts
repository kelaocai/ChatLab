/**
 * 会话密码锁服务
 *
 * 封装 /_web/sessions/:id/lock 系列 API，并在 localStorage 缓存解锁 token。
 * token 有效期 7 天，读取时过期即删；请求失败由调用方按未锁定降级处理。
 *
 * 模块级 reactive 状态（lockedIds / unlockedIds）供侧边栏图标、路由守卫和对话框共享：
 * 挂载时通过 initSessionLockStates() 拉取一次批量锁定状态，之后由本模块的写操作本地同步。
 */

import { reactive } from 'vue'
import { fetchWithAuth } from './utils/http'

const TOKEN_KEY_PREFIX = 'chatlab_session_unlock_'

export interface SessionLockStatus {
  /** 会话是否已启用密码锁 */
  locked: boolean
  /** 本次请求是否携带了有效解锁 token */
  unlocked: boolean
}

interface CachedUnlockToken {
  token: string
  expiresAt: number
}

/** 会话锁共享状态：lockedIds 来自后端批量接口，unlockedIds 与本地 token 缓存同步。 */
const sessionLockState = reactive({
  lockedIds: new Set<string>(),
  unlockedIds: new Set<string>(),
})

/** 会话是否已启用密码锁（状态未拉取或拉取失败时按未锁处理）。 */
export function isSessionLocked(sessionId: string): boolean {
  return sessionLockState.lockedIds.has(sessionId)
}

/** 会话是否已锁且当前持有有效解锁 token。 */
export function isSessionUnlocked(sessionId: string): boolean {
  return sessionLockState.unlockedIds.has(sessionId)
}

/** 密码锁 API 错误，status 用于区分 400（密码太短）/ 401（密码错误）等。 */
export class SessionLockError extends Error {
  constructor(
    public readonly status: number,
    message?: string
  ) {
    super(message ?? `HTTP ${status}`)
    this.name = 'SessionLockError'
  }
}

/** 读取缓存的解锁 token；过期或数据损坏时删除并返回空串。 */
export function getCachedUnlockToken(sessionId: string): string {
  const raw = localStorage.getItem(TOKEN_KEY_PREFIX + sessionId)
  if (!raw) return ''
  try {
    const cached = JSON.parse(raw) as CachedUnlockToken
    if (!cached.token || typeof cached.expiresAt !== 'number' || cached.expiresAt <= Date.now()) {
      throw new Error('invalid or expired')
    }
    return cached.token
  } catch {
    clearUnlockToken(sessionId)
    return ''
  }
}

/**
 * 逗号拼接所有有效的缓存 token。服务端会接受其中任意匹配的一个——
 * 用于 URL 中无法解析 sessionId 的请求（如 /_web/ai/chats 的 body/query 携带 sessionId）。
 */
export function getAllValidUnlockTokens(): string {
  const tokens: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(TOKEN_KEY_PREFIX)) continue
    const token = getCachedUnlockToken(key.slice(TOKEN_KEY_PREFIX.length))
    if (token) tokens.push(token)
  }
  return tokens.join(',')
}

export function cacheUnlockToken(sessionId: string, token: string, expiresAt: number): void {
  const cached: CachedUnlockToken = { token, expiresAt }
  localStorage.setItem(TOKEN_KEY_PREFIX + sessionId, JSON.stringify(cached))
  sessionLockState.unlockedIds.add(sessionId)
}

export function clearUnlockToken(sessionId: string): void {
  localStorage.removeItem(TOKEN_KEY_PREFIX + sessionId)
  sessionLockState.unlockedIds.delete(sessionId)
}

/** 重新上锁：仅清除本地解锁 token，下次访问该会话需重新输入密码。 */
export function relockSession(sessionId: string): void {
  clearUnlockToken(sessionId)
}

/**
 * 初始化共享状态：扫描本地 token 缓存（过期即清），再拉取后端批量锁定状态。
 * 拉取失败（Web WASM 无此后端、网络错误等）按空集处理，不影响正常平台。
 */
export async function initSessionLockStates(): Promise<void> {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (!key?.startsWith(TOKEN_KEY_PREFIX)) continue
    const sessionId = key.slice(TOKEN_KEY_PREFIX.length)
    if (getCachedUnlockToken(sessionId)) sessionLockState.unlockedIds.add(sessionId)
  }
  try {
    const resp = await fetchWithAuth('/_web/session-locks')
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const body = (await resp.json()) as { lockedIds?: string[] }
    sessionLockState.lockedIds = new Set(body.lockedIds ?? [])
  } catch {
    sessionLockState.lockedIds = new Set()
  }
}

async function requestLock<T>(sessionId: string, init?: RequestInit): Promise<T> {
  const resp = await fetchWithAuth(`/_web/sessions/${encodeURIComponent(sessionId)}/lock`, init)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new SessionLockError(resp.status, text || `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

/** 查询会话锁定状态。 */
export function getSessionLockStatus(sessionId: string): Promise<SessionLockStatus> {
  return requestLock<SessionLockStatus>(sessionId)
}

/** 设置或修改密码；已锁定时修改需携带 oldPassword 或有效 token header（fetchWithAuth 自动附加）。 */
export function setSessionLock(sessionId: string, password: string, oldPassword?: string): Promise<{ success: true }> {
  return requestLock<{ success: true }>(sessionId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(oldPassword ? { password, oldPassword } : { password }),
  }).then((result) => {
    sessionLockState.lockedIds.add(sessionId)
    return result
  })
}

/** 移除密码锁。 */
export function removeSessionLock(sessionId: string, password: string): Promise<{ success: true }> {
  return requestLock<{ success: true }>(sessionId, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }).then((result) => {
    sessionLockState.lockedIds.delete(sessionId)
    sessionLockState.unlockedIds.delete(sessionId)
    localStorage.removeItem(TOKEN_KEY_PREFIX + sessionId)
    return result
  })
}

/** 校验密码并换取解锁 token（有效期 7 天）。 */
export async function verifySessionLock(
  sessionId: string,
  password: string
): Promise<{ locked: boolean; token: string; expiresAt: number }> {
  const resp = await fetchWithAuth(`/_web/sessions/${encodeURIComponent(sessionId)}/lock/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new SessionLockError(resp.status, text || `HTTP ${resp.status}`)
  }
  const result = (await resp.json()) as { locked: boolean; token: string; expiresAt: number }
  // expiresAt 可能是秒或毫秒时间戳，统一归一化为毫秒
  if (result.expiresAt < 1e12) result.expiresAt *= 1000
  return result
}
