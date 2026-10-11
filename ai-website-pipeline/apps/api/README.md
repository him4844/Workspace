# apps/api — Fastify HTTP layer

REST `/api/v1`, `/webhooks/*` (signature-verified), `/preview/*`, dev simulator, health.
Thin: routes → application use-cases → `packages/*`. No business rules live here.
Implemented in Phase 1 (webhooks/conversations) and expanded per phase.
