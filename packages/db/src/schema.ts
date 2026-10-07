/**
 * Drizzle schema — mirrors db/migrations/0001_init.sql (docs/03_database_schema.md).
 * Only packages/db may hold SQL; everything else uses repositories (docs/02 §1).
 */
import {
  bigint, boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

export const projectStateEnum = pgEnum('project_state', [
  'NEW', 'INTAKE', 'REQUIREMENTS_IN_PROGRESS', 'REQUIREMENTS_COMPLETE',
  'SPEC_GENERATING', 'CLIENT_REVIEW', 'CLIENT_CHANGES_REQUESTED', 'CLIENT_APPROVED',
  'SPEC_AUDIT', 'SPEC_REVISION_REQUIRED', 'READY_FOR_BUILD', 'BUILDING', 'CODE_AUDIT',
  'CODE_REVISION_REQUIRED', 'TEAM_REVIEW', 'TEAM_REVISION', 'PRICE_PENDING',
  'DEADLINE_PENDING', 'IN_DEVELOPMENT', 'READY_FOR_DELIVERY', 'COMPLETED', 'BLOCKED', 'FAILED',
]);

export const requirementStatusEnum = pgEnum('requirement_status', [
  'EMPTY', 'UNCLEAR', 'AI_INFERRED', 'DEFAULT_PROPOSED', 'CLIENT_CONFIRMED',
  'CLIENT_APPROVED_DEFAULT', 'NOT_APPLICABLE',
]);

export const priorityLevelEnum = pgEnum('priority_level', ['MUST', 'NICE_TO_HAVE', 'LATER']);
export const agentTypeEnum = pgEnum('agent_type', [
  'REQUIREMENTS', 'SPECIFICATION', 'SPEC_AUDITOR', 'CODING', 'CODE_CHECKER', 'TEAM_ASSISTANT',
]);
export const runStatusEnum = pgEnum('run_status', ['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED']);
export const jobStatusEnum = pgEnum('job_status', ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'PARKED', 'DEAD_LETTER']);
export const channelTypeEnum = pgEnum('channel_type', ['INSTAGRAM', 'SIMULATOR', 'TELEGRAM', 'WEBCHAT']);
export const messageDirectionEnum = pgEnum('message_direction', ['INBOUND', 'OUTBOUND']);
export const messageStatusEnum = pgEnum('message_status', ['RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SEND_BLOCKED']);
export const actorTypeEnum = pgEnum('actor_type', ['SYSTEM', 'AI_AGENT', 'HUMAN', 'CLIENT']);
export const severityEnum = pgEnum('severity', ['CRITICAL', 'MAJOR', 'MINOR', 'INFO']);
export const taskTypeEnum = pgEnum('task_type', [
  'HUMAN_REVIEW', 'PRICE_DECISION', 'DEADLINE_DECISION', 'CLIENT_SILENT', 'SCOPE_CHANGE', 'MANUAL_SEND', 'DELIVERY_PREP', 'OTHER',
]);
export const taskStatusEnum = pgEnum('task_status', ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED']);
export const eventTypeEnum = pgEnum('event_type', [
  'PROJECT_CREATED', 'STATE_CHANGED', 'MESSAGE_INBOUND', 'MESSAGE_OUTBOUND', 'MESSAGE_SEND_BLOCKED',
  'REQUIREMENTS_COMPLETE', 'SPEC_GENERATED', 'SPEC_LOCKED', 'SPEC_AUDIT_RESULT', 'BUILD_STARTED', 'BUILD_FINISHED',
  'CODE_CHECK_RESULT', 'TASK_CREATED', 'TASK_STATUS_CHANGED', 'APPROVAL_RECORDED', 'CHANGE_REQUEST', 'AGENT_RUN_FINISHED',
  'HUMAN_ACTION', 'SECURITY_ALERT', 'SYSTEM_ERROR', 'WEBHOOK_RECEIVED', 'WEBHOOK_DUPLICATE',
]);

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable('team_members', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  role: text('role').notNull().default('MEMBER'),
  status: text('status').notNull().default('ACTIVE'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  memberId: text('member_id').notNull().references(() => teamMembers.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teamActions = pgTable('team_actions', {
  id: text('id').primaryKey(),
  memberId: text('member_id'),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  payloadJson: jsonb('payload_json').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clients = pgTable('clients', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  displayName: text('display_name'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clientIdentities = pgTable('client_identities', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().references(() => clients.id),
  channel: channelTypeEnum('channel').notNull(),
  externalId: text('external_id').notNull(),
  username: text('username'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  channelExternalUq: uniqueIndex('client_identities_channel_external_uq').on(t.channel, t.externalId),
}));

export const channelConnections = pgTable('channel_connections', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  channel: channelTypeEnum('channel').notNull(),
  externalAccountId: text('external_account_id'),
  displayName: text('display_name'),
  accessTokenEnc: text('access_token_enc'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: text('scopes').array().notNull().default([]),
  status: text('status').notNull().default('ACTIVE'),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(),
  channel: channelTypeEnum('channel').notNull(),
  externalEventId: text('external_event_id').notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  processingError: text('processing_error'),
}, (t) => ({
  dedupeUq: uniqueIndex('webhook_events_channel_event_uq').on(t.channel, t.externalEventId),
}));

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  clientId: text('client_id').notNull().references(() => clients.id),
  connectionId: text('connection_id').notNull().references(() => channelConnections.id),
  channel: channelTypeEnum('channel').notNull(),
  externalThreadId: text('external_thread_id'),
  status: text('status').notNull().default('OPEN'),
  lastClientMessageAt: timestamp('last_client_message_at', { withTimezone: true }),
  lastBusinessMessageAt: timestamp('last_business_message_at', { withTimezone: true }),
  windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  threadUq: uniqueIndex('conversations_connection_thread_uq').on(t.connectionId, t.externalThreadId),
  windowIx: index('conversations_window_ix').on(t.windowExpiresAt),
}));

export const conversationState = pgTable('conversation_state', {
  conversationId: text('conversation_id').primaryKey().references(() => conversations.id),
  currentQuestionField: text('current_question_field'),
  unansweredFields: text('unanswered_fields').array().notNull().default([]),
  pendingDefaultField: text('pending_default_field'),
  aiContext: jsonb('ai_context').notNull().default({}),
  requirementsVersion: integer('requirements_version'),
  status: text('status').notNull().default('ACTIVE'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  clientId: text('client_id').notNull().references(() => clients.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  name: text('name'),
  projectType: text('project_type').default('UNKNOWN'),
  state: projectStateEnum('state').notNull().default('NEW'),
  blockedFrom: projectStateEnum('blocked_from'),
  assignedMemberId: text('assigned_member_id').references(() => teamMembers.id),
  lockedSpecVersionId: text('locked_spec_version_id'),
  currentRequirementsVersion: integer('current_requirements_version').notNull().default(0),
  currentSpecVersion: integer('current_spec_version').notNull().default(0),
  currentBuildVersion: integer('current_build_version').notNull().default(0),
  complexityEstimate: jsonb('complexity_estimate'),
  finalPrice: jsonb('final_price'),
  finalDeadline: date('final_deadline'),
  deliveryJson: jsonb('delivery_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ stateIx: index('projects_state_ix').on(t.state) }));

export const projectStateTransitions = pgTable('project_state_transitions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  transitionId: text('transition_id').notNull(),
  fromState: projectStateEnum('from_state'),
  toState: projectStateEnum('to_state').notNull(),
  actorType: actorTypeEnum('actor_type').notNull(),
  actorId: text('actor_id'),
  trigger: text('trigger').notNull(),
  reason: text('reason'),
  contextJson: jsonb('context_json').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const loopCounters = pgTable('loop_counters', {
  projectId: text('project_id').notNull().references(() => projects.id),
  scope: text('scope').notNull(),
  key: text('key').notNull().default('attempts'),
  value: integer('value').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  projectId: text('project_id').references(() => projects.id),
  direction: messageDirectionEnum('direction').notNull(),
  status: messageStatusEnum('status').notNull(),
  channelMessageId: text('channel_message_id'),
  clientIdentityId: text('client_identity_id').references(() => clientIdentities.id),
  text: text('text'),
  attachments: jsonb('attachments').notNull().default([]),
  quickReplyPayload: text('quick_reply_payload'),
  agentRunId: text('agent_run_id'),
  draft: boolean('draft').notNull().default(false),
  humanAuthored: boolean('human_authored').notNull().default(false),
  errorCode: text('error_code'),
  errorDetail: text('error_detail'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  midUq: uniqueIndex('messages_conversation_mid_uq').on(t.conversationId, t.channelMessageId),
  convIx: index('messages_conversation_ix').on(t.conversationId, t.createdAt),
}));

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  projectId: text('project_id').references(() => projects.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  idempotencyKey: text('idempotency_key'),
  status: jobStatusEnum('status').notNull().default('PENDING'),
  priority: integer('priority').notNull().default(100),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastError: text('last_error'),
  deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idemUq: uniqueIndex('jobs_idem_uq').on(t.idempotencyKey),
  claimIx: index('jobs_claim_ix').on(t.status, t.runAt, t.priority),
}));

export const jobAttempts = pgTable('job_attempts', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => jobs.id),
  attempt: integer('attempt').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: runStatusEnum('status').notNull(),
  errorCode: text('error_code'),
  errorDetail: text('error_detail'),
  durationMs: integer('duration_ms'),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  scope: text('scope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  projectId: text('project_id'),
  type: eventTypeEnum('type').notNull(),
  actorType: actorTypeEnum('actor_type').notNull(),
  actorId: text('actor_id'),
  payload: jsonb('payload').notNull().default({}),
  severity: severityEnum('severity').notNull().default('INFO'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ projectIx: index('events_project_ix').on(t.projectId, t.createdAt) }));

export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  agentType: agentTypeEnum('agent_type').notNull(),
  jobId: text('job_id').references(() => jobs.id),
  status: runStatusEnum('status').notNull().default('QUEUED'),
  inputArtifactId: text('input_artifact_id'),
  outputArtifactId: text('output_artifact_id'),
  inputSummary: jsonb('input_summary').notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  retryCount: integer('retry_count').notNull().default(0),
  repairCount: integer('repair_count').notNull().default(0),
  errorCode: text('error_code'),
  errorDetail: text('error_detail'),
  model: text('model'),
  provider: text('provider'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  nextAction: text('next_action'),
  confidence: numeric('confidence', { precision: 4, scale: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  projectId: text('project_id').references(() => projects.id),
  type: taskTypeEnum('type').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  priority: severityEnum('priority').notNull().default('MAJOR'),
  reason: text('reason').notNull(),
  aiReport: jsonb('ai_report').notNull().default({}),
  suggestedAction: text('suggested_action'),
  assigneeMemberId: text('assignee_member_id').references(() => teamMembers.id),
  status: taskStatusEnum('status').notNull().default('OPEN'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  closedByMemberId: text('closed_by_member_id'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdByAgentRunId: text('created_by_agent_run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  projectId: text('project_id'),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  mime: text('mime'),
  version: integer('version'),
  createdByRunId: text('created_by_run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const configValues = pgTable('config_values', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedByMemberId: text('updated_by_member_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  organizations, teamMembers, sessions, teamActions,
  clients, clientIdentities, channelConnections, webhookEvents,
  conversations, conversationState, projects, projectStateTransitions, loopCounters,
  messages, jobs, jobAttempts, idempotencyKeys, events, agentRuns,
  tasks, artifacts, configValues,
};
