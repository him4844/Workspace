/**
 * Machine-readable contracts, mirrored from `docs/contracts/*.json` (docs/06 §8).
 * Contract tests assert that the JSON files' `exampleValid` / `exampleInvalid` fixtures
 * behave exactly as these schemas say (docs/14 §4).
 */
import { z } from 'zod';
import { REQUIREMENT_STATUSES } from '@wpp/core';

export const AGENT_STATUSES = ['SUCCESS', 'FAILED', 'NEEDS_REVIEW'] as const;
export const AGENT_ERROR_CODES = [
  'LLM_TIMEOUT', 'LLM_RATE_LIMITED', 'LLM_PROVIDER_ERROR', 'INVALID_JSON',
  'SCHEMA_VALIDATION_FAILED', 'CONTENT_POLICY', 'INPUT_MISSING', 'INTERNAL_ERROR',
] as const;

const FIELD_PATH = /^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)*$/;

export const UsageSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  costUsd: z.number().min(0).optional(),
  durationMs: z.number().int().min(0).optional(),
});

export const AgentEnvelopeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('SUCCESS'),
    projectId: z.string().nullable().optional(),
    runId: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    nextAction: z.string().nullable().optional(),
    output: z.record(z.string(), z.unknown()),
    usage: UsageSchema,
    repairCount: z.number().int().min(0).max(1),
    artifacts: z.array(z.strictObject({ kind: z.string(), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).optional(),
  }),
  z.strictObject({
    status: z.literal('FAILED'),
    runId: z.string(),
    errorCode: z.enum(AGENT_ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    usage: UsageSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('NEEDS_REVIEW'),
    runId: z.string(),
    reason: z.string(),
    partialOutput: z.record(z.string(), z.unknown()).nullable().optional(),
    usage: UsageSchema.optional(),
  }),
]);

// ------------------------------------------------------------------ requirements turn (§5–§13)

export const FieldUpdateSchema = z.strictObject({
  fieldPath: z.string().min(1),
  category: z.string().optional(),
  value: z.unknown().optional(),
  status: z.enum(REQUIREMENT_STATUSES),
  priority: z.enum(['MUST', 'NICE_TO_HAVE', 'LATER']).optional(),
  sourceMessageId: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const ContradictionSchema = z.strictObject({
  fieldA: z.string().min(1),
  fieldB: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['MAJOR', 'MINOR']),
  status: z.enum(['OPEN', 'CLARIFYING', 'RESOLVED']).optional(),
});

export const VisionSchema = z.strictObject({
  clientConfirmed: z.array(z.string()),
  aiInferred: z.array(z.string()),
  notSpecified: z.array(z.string()),
});

export const RequirementsTurnSchema = z
  .strictObject({
    turnType: z.enum(['ASK_QUESTION', 'ACKNOWLEDGE_AND_ASK', 'COMPLETE']),
    question: z
      .strictObject({
        fieldPath: z.string().regex(FIELD_PATH),
        text: z.string().min(1).max(900),
        quickReplies: z.array(z.string().max(20)).max(13).optional(),
        why: z.string().max(300).optional(),
      })
      .optional(),
    acknowledgment: z.string().max(200).nullable().optional(),
    fieldUpdates: z.array(FieldUpdateSchema),
    contradictions: z.array(ContradictionSchema),
    vision: VisionSchema,
    completeness: z
      .strictObject({
        score: z.number().min(0).max(1),
        blockingFields: z.array(z.string()),
        openContradictions: z.number().int().min(0),
      })
      .optional(),
    injectionSuspected: z.boolean().optional(),
    internalSummaryMd: z.string().min(1).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.turnType === 'COMPLETE') {
      if (!value.internalSummaryMd || value.internalSummaryMd.trim().length < 40) {
        ctx.addIssue({
          code: 'custom',
          path: ['internalSummaryMd'],
          message: 'turnType=COMPLETE requires internalSummaryMd (internal summary for the Specification Agent)',
        });
      }
      return;
    }
    if (!value.question) {
      ctx.addIssue({ code: 'custom', path: ['question'], message: `${value.turnType} requires a question object` });
    }
    if (value.question && value.question.text.trim().length < 3) {
      ctx.addIssue({ code: 'custom', path: ['question', 'text'], message: 'question text is too short' });
    }
    if (value.question?.quickReplies && value.question.quickReplies.some((q) => q.trim().length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['question', 'quickReplies'], message: 'quick replies must not be empty' });
    }
  });

export type RequirementsTurn = z.infer<typeof RequirementsTurnSchema>;
export type FieldUpdate = z.infer<typeof FieldUpdateSchema>;
export type Contradiction = z.infer<typeof ContradictionSchema>;
export type Vision = z.infer<typeof VisionSchema>;

/** Turn a Zod failure into human-readable repair instructions (used by the runtime). */
export function zodErrorsToMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
