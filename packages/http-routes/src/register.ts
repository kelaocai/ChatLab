/** Aggregate registration for the shared REST and Web route groups. */

import type { FastifyInstance } from 'fastify'
import type { HttpRouteContext } from './context'
import { registerRestRoutes } from './routes/rest/register'
import { registerWebRoutes, type WebRouteOptions } from './routes/web/register'
import { registerSessionLockRoutes } from './routes/web/session-lock'

export type SharedRouteOptions = WebRouteOptions

export function registerSharedRoutes(
  server: FastifyInstance,
  ctx: HttpRouteContext,
  options?: SharedRouteOptions
): void {
  // Session lock must register first: its enforcement hook only applies to
  // routes registered after it.
  registerSessionLockRoutes(server, ctx)
  registerRestRoutes(server, ctx)
  registerWebRoutes(server, ctx, options)
}
