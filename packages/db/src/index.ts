/**
 * Public surface of the persistence layer.
 * Namespaced repositories (`identityRepo`, `projectsRepo`, …) plus flat helpers for
 * the most common reads. Only this package contains SQL (docs/02 §1).
 */
export * from './client.js';
export * from './migrate.js';
export * from './schema.js';
export * from './seeding.js';

export * as orgRepo from './repositories/org.js';
export * as channelsRepo from './repositories/channels.js';
export * as identityRepo from './repositories/identity.js';
export * as projectsRepo from './repositories/projects.js';
export * as queueRepo from './repositories/queue.js';
export * as obsRepo from './repositories/observability.js';
export * as requirementsRepo from './repositories/requirements.js';
export * as questionnairesRepo from './repositories/questionnaires.js';
export * as agentConfigRepo from './repositories/agentConfig.js';
export * as artifactsRepo from './repositories/artifacts.js';
export * as specsRepo from './repositories/specs.js';
export * as auditsRepo from './repositories/audits.js';

// ---- flat exports (projects & state machine) ----
export {
  getProject, listProjects, createProject, setProjectType, applyTransition, listTransitions,
  getLoopCounter, incrementLoopCounter, resetLoopCounter,
  findOpenProjectForConversation, countProjects,
} from './repositories/projects.js';
export type { ProjectRow, ApplyTransitionInput, ApplyTransitionResult } from './repositories/projects.js';

// ---- flat exports (identity & conversations) ----
export {
  resolveClientByIdentity, findOrCreateConversation, getConversation, listConversations,
  insertMessage, getMessage, listMessages, listRecentMessages, markMessageSent, markMessageFailed,
  markMessageSendBlocked, touchInbound, touchOutbound, attachMessageToProject,
  conversationOverview, pendingOutbound, findIdentity, getClient,
} from './repositories/identity.js';
export type { ConversationRow, MessageRow, ClientRow, ClientIdentityRow } from './repositories/identity.js';

// ---- flat exports (queue) ----
export {
  enqueueJob, replacePendingJob, claimNextJob, completeJob, failJob, getJob, listJobs, jobStats,
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

// ---- flat exports (Phase 2: requirements, questionnaires, agent config, artifacts) ----
export {
  getCurrentRequirementVersion, createRequirementVersion, cloneFieldsFromVersion, setPendingFieldPath,
  setRequirementCompleteness, listRequirementFields, seedFieldsFromQuestionnaire,
  upsertRequirementField, recordFieldStatusChange, listFieldHistory,
  upsertContradiction, listContradictions, listCurrentRequirementSnapshot,
} from './repositories/requirements.js';
export type { RequirementVersionRow, RequirementFieldRow, ContradictionRow, FieldMutation } from './repositories/requirements.js';
export {
  upsertQuestionnaireDefinition, getQuestionnaireDefinition, listQuestionnaireDefinitions,
  loadQuestionnaireSources,
} from './repositories/questionnaires.js';
export { getActiveAgentConfig, recordLlmUsage, sumCostSince } from './repositories/agentConfig.js';
export type { AgentConfigVersionRow } from './repositories/agentConfig.js';
export { createArtifact, getArtifact, listArtifacts } from './repositories/artifacts.js';
export type { ArtifactRow } from './repositories/artifacts.js';
export {
  createSpecVersion, getSpecVersion, listSpecVersions, getCurrentSpecVersion, getLockedSpecVersion,
  setSpecStatus, markSummarySent, markApprovalRequested, setSpecArtifact, lockSpecVersion,
  supersedeSpecVersion, insertSpecRequirements, insertAcceptanceCriteria, listSpecRequirements,
  listAcceptanceCriteria, recordClientApproval, getApprovalForMessage, listClientApprovals,
  createChangeRequest, listChangeRequests, updateChangeRequestStatus, listSpecSnapshot, countSpecVersions,
} from './repositories/specs.js';
export type {
  SpecVersionRow, SpecRequirementRow, AcceptanceCriterionRow, ClientApprovalRow, ChangeRequestRow, SpecSnapshot,
} from './repositories/specs.js';
