/**
 * 通用 HTTP 请求工具
 *
 * 供各 FetchXxxAdapter 复用的 GET/POST 封装。
 * 支持通过 configureHttpClient 注入 token 和 401 处理。
 */

let _baseUrl = '/_web'
let _token = ''
let _getToken: (() => string) | undefined
let _on401: (() => void) | undefined
let _getSessionUnlockToken: ((url: string) => string) | undefined
let _onSessionLocked: ((sessionId: string) => void) | undefined

export function configureHttpClient(config: {
  baseUrl?: string
  token?: string
  getToken?: (() => string) | null
  on401?: (() => void) | null
  /** 按请求 URL 取会话解锁 token（会话密码锁），返回空串表示不附加 */
  getSessionUnlockToken?: ((url: string) => string) | null
  /** 收到 423 SESSION_LOCKED 响应时回调（参数为 URL 中解析出的 sessionId） */
  onSessionLocked?: ((sessionId: string) => void) | null
}): void {
  if (config.baseUrl !== undefined) _baseUrl = config.baseUrl
  if (config.token !== undefined) _token = config.token
  if (config.getToken !== undefined) _getToken = config.getToken ?? undefined
  if (config.on401 !== undefined) _on401 = config.on401 ?? undefined
  if (config.getSessionUnlockToken !== undefined) _getSessionUnlockToken = config.getSessionUnlockToken ?? undefined
  if (config.onSessionLocked !== undefined) _onSessionLocked = config.onSessionLocked ?? undefined
}

/** 匹配 /sessions/<id>/ 形式的 URL，返回 sessionId。 */
export function parseSessionIdFromUrl(url: string): string | null {
  const match = /\/sessions\/([^/?#]+)(?:\/|\?|#|$)/.exec(url)
  return match ? decodeURIComponent(match[1]) : null
}

/** 会话相关请求附加 x-session-unlock header。 */
function applySessionUnlockHeader(url: string, headers: Headers): void {
  const token = _getSessionUnlockToken?.(url)
  if (token && !headers.has('x-session-unlock')) headers.set('x-session-unlock', token)
}

/** 423 且 error.code 为 SESSION_LOCKED 时回调；clone 读取 body，不影响调用方。 */
function handleSessionLocked(resp: Response, url: string): void {
  if (resp.status !== 423 || !_onSessionLocked) return
  resp
    .clone()
    .json()
    .then((body) => {
      if (body?.error?.code !== 'SESSION_LOCKED') return
      // URL 无法解析 sessionId 时（如 AI 入口）回退用服务端返回的 sessionId
      const sessionId = parseSessionIdFromUrl(url) ?? body.error.sessionId
      if (typeof sessionId === 'string' && sessionId) _onSessionLocked?.(sessionId)
    })
    .catch(() => {})
}

function resolveToken(): string {
  return _getToken ? _getToken() : _token
}

export function getAuthHeaders(): Record<string, string> {
  const token = resolveToken()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export function getBaseUrl(): string {
  return _baseUrl
}

/**
 * Resolve a URL path against the configured base.
 * When baseUrl is absolute (http://...), relative paths like "/_web/..."
 * are rewritten to the Internal Server origin. Otherwise returns as-is.
 */
function resolveFullUrl(url: string): string {
  if (!_baseUrl.startsWith('http://') && !_baseUrl.startsWith('https://')) return url
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  try {
    const origin = new URL(_baseUrl).origin
    return `${origin}${url}`
  } catch {
    return url
  }
}

/**
 * Authenticated fetch wrapper — same API as native fetch,
 * but auto-injects Authorization header and handles 401.
 * Paths starting with / are resolved via resolveFullUrl so that
 * Electron Internal Server mode works with absolute base URLs.
 */
export async function fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = resolveToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  applySessionUnlockHeader(url, headers)
  const resolvedUrl = resolveFullUrl(url)
  const resp = await fetch(resolvedUrl, { ...init, headers })
  if (resp.status === 401 && _on401) _on401()
  handleSessionLocked(resp, url)
  return resp
}

function handle401(resp: Response): void {
  if (resp.status === 401 && _on401) _on401()
}

/** 构造鉴权 header，并按需附加会话解锁 token。 */
function buildAuthHeaders(url: string): Record<string, string> {
  const headers = getAuthHeaders()
  const unlockToken = _getSessionUnlockToken?.(url)
  if (unlockToken) headers['x-session-unlock'] = unlockToken
  return headers
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(`${_baseUrl}${path}`, {
    headers: buildAuthHeaders(path),
    signal,
  })
  handle401(resp)
  handleSessionLocked(resp, path)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

export async function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const hasBody = body !== undefined
  const resp = await fetch(`${_baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(path),
      ...(hasBody && { 'Content-Type': 'application/json' }),
    },
    ...(hasBody && { body: JSON.stringify(body) }),
    signal,
  })
  handle401(resp)
  handleSessionLocked(resp, path)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

// ==================== 分析请求取消（epoch）====================
//
// 分析类只读请求（统计 / 分词 / 图表数据）都绑定当前「会话 + 时间筛选」。
// 切换会话或时间筛选时，上一批查询立即作废：abortAnalyticsRequests() 取消所有在途请求，
// 既释放浏览器对同源的并发连接（避免后续请求长时间 pending），又确保过期结果不会回写。
let _analyticsController = new AbortController()

/** 作废当前所有分析类在途请求，并开启新的请求 epoch。切换会话 / 时间筛选前调用。 */
export function abortAnalyticsRequests(): void {
  _analyticsController.abort()
  _analyticsController = new AbortController()
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// 已作废的请求永不 settle：避免旧数据覆盖新数据，也避免在调用方触发无意义的错误处理与空态闪烁。
function neverSettle<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

/**
 * Bind an analysis request to the current epoch.
 *
 * Besides aborting queued work, the identity check also discards a result when
 * the underlying runtime cannot interrupt a task that has already started.
 */
export function withAnalyticsRequestEpoch<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = _analyticsController
  return request(controller.signal)
    .then((result) => (controller === _analyticsController ? result : neverSettle<T>()))
    .catch((err) => {
      if (controller !== _analyticsController || isAbortError(err)) return neverSettle<T>()
      throw err
    })
}

/** 绑定当前 epoch 的 GET：被 abortAnalyticsRequests() 取消时静默作废。 */
export function analyticsGet<T>(path: string): Promise<T> {
  return withAnalyticsRequestEpoch((signal) => get<T>(path, signal))
}

/** 绑定当前 epoch 的 POST：被 abortAnalyticsRequests() 取消时静默作废。 */
export function analyticsPost<T>(path: string, body?: unknown): Promise<T> {
  return withAnalyticsRequestEpoch((signal) => post<T>(path, body, signal))
}

export async function del<T = boolean>(path: string): Promise<T> {
  const resp = await fetch(`${_baseUrl}${path}`, {
    method: 'DELETE',
    headers: buildAuthHeaders(path),
  })
  handle401(resp)
  handleSessionLocked(resp, path)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

export async function put<T>(path: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined
  const resp = await fetch(`${_baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      ...buildAuthHeaders(path),
      ...(hasBody && { 'Content-Type': 'application/json' }),
    },
    ...(hasBody && { body: JSON.stringify(body) }),
  })
  handle401(resp)
  handleSessionLocked(resp, path)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

export async function patch<T>(path: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined
  const resp = await fetch(`${_baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      ...buildAuthHeaders(path),
      ...(hasBody && { 'Content-Type': 'application/json' }),
    },
    ...(hasBody && { body: JSON.stringify(body) }),
  })
  handle401(resp)
  handleSessionLocked(resp, path)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}
