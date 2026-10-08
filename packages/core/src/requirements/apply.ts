/**
 * Applying an agent turn to requirement fields (SPEC §10A, §12, §13, §53).
 *
 * The LLM proposes updates; this module is the gate. It enforces the rules that must hold
 * regardless of what the model returns:
 *   - CLIENT_CONFIRMED / CLIENT_APPROVED_DEFAULT require a client message reference (§10A)
 *   - an AI inference can never overwrite client truth silently (§53)
 *   - lower-priority requirements are never deleted, only re-prioritised (§13)
 */
import { CLIENT_TRUTH_STATUSES, type RequirementStatus } from '../types.js';
import type { Priority, RequirementFieldState } from './questionnaires.js';

export interface ProposedFieldUpdate {
  fieldPath: string;
  category?: string;
  value?: unknown;
  status: RequirementStatus;
  priority?: Priority;
  sourceMessageId?: string | null;
  note?: string | null;
}

export interface RejectedUpdate {
  update: ProposedFieldUpdate;
  code: 'CLIENT_TRUTH_NEEDS_SOURCE' | 'DOWNGRADE_NEEDS_NOTE' | 'INVALID_STATUS' | 'EMPTY_PATH';
  message: string;
}

export interface AcceptedUpdate extends ProposedFieldUpdate {
  /** true when the update weakens an existing client-confirmed value */
  downgrade: boolean;
}

export interface ApplyPlan {
  accepted: AcceptedUpdate[];
  rejected: RejectedUpdate[];
  /** paths the model invented that the questionnaire did not know (allowed, recorded) */
  newPaths: string[];
}

const VALID_STATUSES: RequirementStatus[] = [
  'EMPTY', 'UNCLEAR', 'AI_INFERRED', 'DEFAULT_PROPOSED',
  'CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT', 'NOT_APPLICABLE',
];

const WEAKER: RequirementStatus[] = ['EMPTY', 'UNCLEAR', 'AI_INFERRED', 'DEFAULT_PROPOSED'];

export function planFieldUpdates(
  proposed: ProposedFieldUpdate[],
  ctx: {
    current: Map<string, RequirementFieldState>;
    knownPaths: Set<string>;
    /** message ids that belong to this conversation and are inbound */
    validSourceMessageIds: Set<string>;
    /** the newest inbound message of the turn — injected when the model omits the reference */
    currentInboundMessageId: string | null;
  },
): ApplyPlan {
  const accepted: AcceptedUpdate[] = [];
  const rejected: RejectedUpdate[] = [];
  const newPaths: string[] = [];

  for (const update of proposed) {
    if (!update.fieldPath || update.fieldPath.trim() === '') {
      rejected.push({ update, code: 'EMPTY_PATH', message: 'fieldPath is empty' });
      continue;
    }
    if (!VALID_STATUSES.includes(update.status)) {
      rejected.push({ update, code: 'INVALID_STATUS', message: `unknown status ${update.status}` });
      continue;
    }
    if (!ctx.knownPaths.has(update.fieldPath)) newPaths.push(update.fieldPath);

    // §10A: client truth must be traceable to a client message. If the model forgot the
    // reference but the turn is driven by an inbound client message, we use that message —
    // the update is still backed by real client text, never by invention.
    let sourceMessageId = update.sourceMessageId ?? null;
    if (CLIENT_TRUTH_STATUSES.includes(update.status)) {
      if (!sourceMessageId) sourceMessageId = ctx.currentInboundMessageId;
      if (!sourceMessageId || !ctx.validSourceMessageIds.has(sourceMessageId)) {
        rejected.push({
          update,
          code: 'CLIENT_TRUTH_NEEDS_SOURCE',
          message: `${update.status} requires a sourceMessageId of a real inbound message (§10A)`,
        });
        continue;
      }
    }

    const previous = ctx.current.get(update.fieldPath);
    const downgrade =
      previous !== undefined &&
      CLIENT_TRUTH_STATUSES.includes(previous.status) &&
      WEAKER.includes(update.status);

    if (downgrade && !(update.note && update.note.trim().length > 0)) {
      rejected.push({
        update,
        code: 'DOWNGRADE_NEEDS_NOTE',
        message: `cannot weaken ${previous?.status} → ${update.status} without a note (§53)`,
      });
      continue;
    }

    accepted.push({ ...update, sourceMessageId, downgrade });
  }

  return { accepted, rejected, newPaths };
}

/** §13 — priorities travel with the field; MUST is the default for mandatory template fields. */
export function resolvePriority(
  proposed: Priority | undefined,
  field: { priority?: Priority; mandatory: boolean } | undefined,
): Priority {
  if (proposed) return proposed;
  if (field?.priority) return field.priority;
  return field?.mandatory ? 'MUST' : 'NICE_TO_HAVE';
}

/** Build the plain field list the completeness engine and the summary consume. */
export function toFieldStates(
  fields: Array<{
    fieldPath: string; category: string; value: unknown;
    status: RequirementStatus; priority: Priority; mandatory: boolean; note?: string | null;
  }>,
): RequirementFieldState[] {
  return fields.map((f) => ({
    fieldPath: f.fieldPath,
    category: f.category,
    value: f.value,
    status: f.status,
    priority: f.priority,
    mandatory: f.mandatory,
    note: f.note ?? null,
  }));
}
