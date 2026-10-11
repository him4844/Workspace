/**
 * The single place that guards HTTP routes (docs/07, docs/10, SPEC §37).
 *
 * Two problems lived here before (AUDIT.md P2-1, P2-2):
 *
 *  1. Three route modules each registered their OWN root-level `preHandler` hook — `simulator.ts`,
 *     `inspector.ts` and `spec.ts`. Because `app.addHook` on the root instance is global, every
 *     request (including `/healthz` and `/webhooks/instagram`) ran the same URL-prefix test up to
 *     three times, and the `/api/v1` token check existed as two copies that could drift apart.
 *     Registering the guards once, before the routes, is the only arrangement where "which hook
 *     protects this URL?" has one answer.
 *
 *  2. The internal token was compared with `token !== config.INTERNAL_API_TOKEN`. A plain string
 *     compare short-circuits on the first differing byte, so response time leaks how much of a
 *     guessed bearer token was right. `packages/channels/src/instagram/verify.ts` already gets this
 *     right for the webhook secret with `timingSafeEqual`; this applies the same discipline to the
 *     internal API token.
 *
 * The dev simulator is additionally restricted to loopback. `CHANNEL_SIMULATOR_ENABLED` defaults to
 * **true** and only `NODE_ENV=production` refuses it, so any staging box or container reachable from
 * a network exposed `/dev/simulator/inbound` — an unauthenticated endpoint that injects client DMs
 * into the real ingestion path, starts agent turns and therefore spends LLM budget. Requiring
 * loopback keeps the local dev console working (it calls these endpoints from the same origin)
 * while removing the network exposure. Real sessions + RBAC arrive with the Team Panel (Phase 7).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppDeps } from './app.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True only for the machine's own addresses. `trustProxy` stays off, so `request.ip` is the socket. */
export function isLoopback(address: string | undefined | null): boolean {
  if (!address) return false;
  return LOOPBACK_ADDRESSES.has(address.toLowerCase());
}

/**
 * Constant-time string equality.
 *
 * Both sides are hashed first so `timingSafeEqual` always receives two 32-byte digests: it cannot
 * throw on a length mismatch, and neither the secret's length nor its matching prefix is observable
 * through timing. Hashing cost depends only on the *caller's* input length, which the caller
 * already knows.
 */
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/** A header may arrive repeated; the first value is the one a client meant to send. */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function unauthorized(reply: FastifyReply): void {
  void reply.status(401).send({
    ok: false,
    error: { code: 'UNAUTHORIZED', message: 'X-Internal-Token required' },
  });
}

/** 404 rather than 403: an unavailable dev endpoint should not advertise that it exists. */
function notAvailable(reply: FastifyReply, message: string): void {
  void reply.status(404).send({ ok: false, error: { code: 'NOT_AVAILABLE', message } });
}

/**
 * Register every route guard exactly once. Must run BEFORE the route modules so the hook is in
 * place for all of them; a route registered first would still be covered (Fastify resolves hooks at
 * request time), but keeping the order obvious avoids the "which module guards what?" question.
 */
export function registerRouteGuards(app: FastifyInstance, deps: AppDeps): void {
  const { config } = deps;

  app.addHook('preHandler', async (request, reply) => {
    const url = request.url;

    // ---- internal API: shared bearer token -----------------------------------------------
    if (url.startsWith('/api/v1')) {
      const token = firstHeaderValue(request.headers['x-internal-token']);
      if (typeof token !== 'string' || !safeEqual(token, config.INTERNAL_API_TOKEN)) {
        return unauthorized(reply);
      }
      return;
    }

    // ---- dev simulator channel: flag-gated AND loopback-only ------------------------------
    if (url.startsWith('/dev/simulator')) {
      if (!config.CHANNEL_SIMULATOR_ENABLED) {
        return notAvailable(reply, 'simulator channel is disabled');
      }
      if (!isLoopback(request.ip)) {
        request.log.warn({ url, remote: request.ip }, 'simulator channel refused: not loopback');
        return notAvailable(reply, 'simulator channel is local-only');
      }
      return;
    }
  });
}
