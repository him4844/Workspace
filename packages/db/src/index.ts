/**
 * Public surface of the persistence layer.
 * Namespaced repositories (`identityRepo`, `projectsRepo`, …) plus flat helpers for
 * the most common reads. Only this package contains SQL (docs/02 §1).
 */
export * from './client.js';
export * from './migrate.js';
export * from './schema.js';

export * as orgRepo from './repositories/org.js';
export * as channelsRepo from './repositories/channels.js';
export * as identityRepo from './repositories/identity.js';
export * as projectsRepo from './repositories/projects.js';
export * as queueRepo from './repositories/queue.js';
export * as obsRepo from './repositories/observability.js';

// ---- flat exports (projects & state machine) ----
export {
  getProject, listProjects, createProject, applyTransition, listTransitions,
  getLoopCounter, incrementLoopCounter, resetLoopCounter,
  findOpenProjectForConversation, countProjects,
} from './repositories/projects.js';
export type { ProjectRow, ApplyTransitionInput, ApplyTransitionResult } from './repositories/projects.js';

// ---- flat exports (identity & conversations) ----
export {
  resolveClientByIdentity, findOrCreateConversation, getConversation, listConversations,
  insertMessage, getMessage, listMessages, markMessageSent, markMessageFailed,
  markMessageSendBlocked, touchInbound, touchOutbound, attachMessageToProject,
  conversationOverview, pendingOutbound, findIdentity, getClient,
} from './repositories/identity.js';
export type { ConversationRow, MessageRow, ClientRow, ClientIdentityRow } from './repositories/identity.js';

// ---- flat exports (queue) ----
export {
  enqueueJob, claimNextJob, completeJob, failJob, getJob, listJobs, jobStats,
  parkJob, listParkedJobs, unparkJobs, requeueExpiredLeases, rememberIdempotencyKey,
} from './repositories/queue.js';
export type { JobRow, EnqueueInput } from './repositories/queue.js';

// ---- flat exports (observability, tasks) ----
export {
  recordEvent, listEvents, startAgentRun, finishAgentRun, listAgentRuns,
  createTask, listOpenTasks,
} from './repositories/observability.js';

// ---- flat exports (channels, org) ----
export {
  getActiveConnection, ensureConnection, getConnectionById, listConnections,
  recordWebhookEvent, markWebhookProcessed,
} from './repositories/channels.js';
export { getOrCreateDefaultOrg, getConfigValue, setConfigValue, findMemberByEmail } from './repositories/org.js';
