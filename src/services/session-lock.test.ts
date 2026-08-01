/**
 * Run: pnpm test -- src/services/session-lock.test.ts
 *
 * 验证 localStorage token 缓存与 reactive 共享状态（lockedIds / unlockedIds）的同步语义。
 */

import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  cacheUnlockToken,
  clearUnlockToken,
  getAllValidUnlockTokens,
  getCachedUnlockToken,
  initSessionLockStates,
  isSessionLocked,
  isSessionUnlocked,
  relockSession,
} from './session-lock'

function createLocalStorageStub() {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  }
}

const FUTURE = Date.now() + 7 * 24 * 3600 * 1000

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).localStorage = createLocalStorageStub()
})

test('cacheUnlockToken stores the token and marks the session unlocked', () => {
  cacheUnlockToken('s-cache', 'tok', FUTURE)
  assert.equal(getCachedUnlockToken('s-cache'), 'tok')
  assert.equal(isSessionUnlocked('s-cache'), true)
})

test('expired cached token is deleted on read and treated as locked', () => {
  cacheUnlockToken('s-expired', 'tok', Date.now() - 1000)
  assert.equal(getCachedUnlockToken('s-expired'), '')
  assert.equal(isSessionUnlocked('s-expired'), false)
  assert.equal(localStorage.getItem('chatlab_session_unlock_s-expired'), null)
})

test('corrupted cached token is deleted on read', () => {
  localStorage.setItem('chatlab_session_unlock_s-corrupt', 'not-json')
  assert.equal(getCachedUnlockToken('s-corrupt'), '')
  assert.equal(localStorage.getItem('chatlab_session_unlock_s-corrupt'), null)
})

test('relockSession clears the cached token and unlocked state', () => {
  cacheUnlockToken('s-relock', 'tok', FUTURE)
  relockSession('s-relock')
  assert.equal(getCachedUnlockToken('s-relock'), '')
  assert.equal(isSessionUnlocked('s-relock'), false)
})

test('getAllValidUnlockTokens joins only valid tokens with commas', () => {
  cacheUnlockToken('s-a', 'tok-a', FUTURE)
  cacheUnlockToken('s-b', 'tok-b', FUTURE)
  cacheUnlockToken('s-expired', 'tok-x', Date.now() - 1000)
  localStorage.setItem('unrelated_key', 'value')
  assert.equal(getAllValidUnlockTokens(), 'tok-a,tok-b')
})

test('getAllValidUnlockTokens returns empty string when nothing is cached', () => {
  assert.equal(getAllValidUnlockTokens(), '')
})

test('clearUnlockToken removes both cache and unlocked state', () => {
  cacheUnlockToken('s-clear', 'tok', FUTURE)
  clearUnlockToken('s-clear')
  assert.equal(isSessionUnlocked('s-clear'), false)
})

test('initSessionLockStates loads locked ids and restores valid cached tokens', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ lockedIds: ['s-init-locked'] }), { status: 200 }))) as typeof fetch

  localStorage.setItem('chatlab_session_unlock_s-init-locked', JSON.stringify({ token: 'tok', expiresAt: FUTURE }))
  localStorage.setItem(
    'chatlab_session_unlock_s-init-expired',
    JSON.stringify({ token: 'tok', expiresAt: Date.now() - 1000 })
  )

  try {
    await initSessionLockStates()
    assert.equal(isSessionLocked('s-init-locked'), true)
    assert.equal(isSessionLocked('s-init-expired'), false)
    assert.equal(isSessionUnlocked('s-init-locked'), true)
    assert.equal(isSessionUnlocked('s-init-expired'), false)
    // 过期 token 在初始化扫描时被清理
    assert.equal(localStorage.getItem('chatlab_session_unlock_s-init-expired'), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('initSessionLockStates falls back to empty locked set when the request fails', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('network error'))) as typeof fetch

  try {
    await initSessionLockStates()
    assert.equal(isSessionLocked('any-session'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
