import type { SessionLockStatus } from '@/services/session-lock'

export interface SessionLockNavigationContext {
  routeName: unknown
  sessionId: string | undefined
  fullPath: string
  hasUnlockToken: (sessionId: string) => boolean
  fetchLockStatus: (sessionId: string) => Promise<SessionLockStatus>
}

export type SessionLockNavigationTarget = {
  name: 'session-lock'
  params: { id: string }
  query: { redirect: string }
} | null

/**
 * 会话密码锁导航决策：进入聊天页前，若会话已锁且本地无有效解锁 token，跳转解锁页。
 *
 * 请求失败（Web WASM 无此后端、网络错误等）一律按未锁定放行，不阻塞正常平台。
 */
export async function resolveSessionLockNavigation(
  context: SessionLockNavigationContext
): Promise<SessionLockNavigationTarget> {
  if (context.routeName !== 'group-chat' && context.routeName !== 'private-chat') return null
  if (!context.sessionId) return null
  if (context.hasUnlockToken(context.sessionId)) return null

  let status: SessionLockStatus
  try {
    status = await context.fetchLockStatus(context.sessionId)
  } catch {
    return null
  }
  if (!status.locked || status.unlocked) return null
  return {
    name: 'session-lock',
    params: { id: context.sessionId },
    query: { redirect: context.fullPath },
  }
}
