/**
 * 会话密码锁服务
 *
 * 封装 /_web/sessions/:id/lock 系列 API，并在 localStorage 缓存解锁 token。
 * token 有效期 7 天，读取时过期即删；请求失败由调用方按未锁定降级处理。
 */

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

export function cacheUnlockToken(sessionId: string, token: string, expiresAt: number): void {
  const cached: CachedUnlockToken = { token, expiresAt }
  localStorage.setItem(TOKEN_KEY_PREFIX + sessionId, JSON.stringify(cached))
}

export function clearUnlockToken(sessionId: string): void {
  localStorage.removeItem(TOKEN_KEY_PREFIX + sessionId)
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
  })
}

/** 移除密码锁。 */
export function removeSessionLock(sessionId: string, password: string): Promise<{ success: true }> {
  return requestLock<{ success: true }>(sessionId, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
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
