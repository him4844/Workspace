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

// ------------------------------------------------------------------ specification (§14–§19)

/** SPEC-REQ / AC codes are fixed-width ids so traceability stays machine-readable (§16). */
const SPEC_REQ_CODE = /^SPEC-REQ-\d{3,}$/;
const AC_CODE = /^AC-\d{3,}$/;

export const AcceptanceCriterionSchema = z.strictObject({
  code: z.string().regex(AC_CODE),
  text: z.string().min(10).max(600),
  testable: z.boolean(),
  verificationHint: z.enum(['E2E', 'API', 'VISUAL', 'MANUAL', 'STATIC']).optional(),
});

export const SpecRequirementSchema = z.strictObject({
  code: z.string().regex(SPEC_REQ_CODE),
  originReqField: z.string().nullable().optional(),
  originMessageIds: z.array(z.string()).max(20).optional(),
  section: z.string().min(1).max(120),
  title: z.string().min(3).max(160),
  description: z.string().min(10).max(2000),
  priority: z.enum(['MUST', 'NICE_TO_HAVE', 'LATER']),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(12),
  verificationExpectation: z.string().max(400).nullable().optional(),
});

export const ClientSummarySchema = z.strictObject({
  markdown: z.string().min(40).max(3500),
  assumptionsShown: z.array(z.string().max(300)).max(20),
  approveLabel: z.string().max(40).optional(),
  requestChangesLabel: z.string().max(40).optional(),
});

export const SpecificationOutputSchema = z.strictObject({
  spec: z.strictObject({
    meta: z.strictObject({
      projectType: z.string().min(1),
      generatedFromRequirementsVersion: z.number().int().min(1),
      sectionsIncluded: z.array(z.string()).optional(),
      sectionsOmitted: z.array(z.string()).optional(),
    }),
    overview: z.string().nullable().optional(),
    businessGoals: z.array(z.string()).optional(),
    targetUsers: z.array(z.string()).optional(),
    sitemap: z.array(z.string()).optional(),
    pages: z
      .array(z.strictObject({ name: z.string().min(1), purpose: z.string().min(3), sections: z.array(z.string()).optional() }))
      .optional(),
    requirements: z.array(SpecRequirementSchema).min(1),
    nonFunctional: z.record(z.string(), z.unknown()).nullable().optional(),
    integrations: z.array(z.string()).optional(),
    databaseNotes: z.string().nullable().optional(),
    deploymentRequirements: z.string().nullable().optional(),
    definitionOfDone: z.array(z.string()).optional(),
    knownAssumptions: z.array(z.string()).optional(),
    openQuestions: z.array(
      z.strictObject({ question: z.string().min(5), blocking: z.boolean(), relatedField: z.string().nullable().optional() }),
    ),
    futureScope: z.array(z.string()).optional(),
  }),
  clientSummary: ClientSummarySchema,
}).superRefine((value, ctx) => {
  // §17: an acceptance criterion that is not testable is not an acceptance criterion.
  for (const [index, req] of value.spec.requirements.entries()) {
    if (req.priority === 'MUST' && req.acceptanceCriteria.every((ac) => !ac.testable)) {
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'requirements', index, 'acceptanceCriteria'],
        message: `${req.code} is MUST but has no testable acceptance criterion (§17)`,
      });
    }
  }
  const codes = value.spec.requirements.map((r) => r.code);
  if (new Set(codes).size !== codes.length) {
    ctx.addIssue({ code: 'custom', path: ['spec', 'requirements'], message: 'duplicate SPEC-REQ codes' });
  }
});

export type SpecificationOutput = z.infer<typeof SpecificationOutputSchema>;
export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

// ------------------------------------------------------------------ client intent (§18, §19)

export const ClientIntentSchema = z.strictObject({
  intent: z.enum(['APPROVE', 'REQUEST_CHANGES', 'ANSWER', 'QUESTION', 'SMALL_TALK', 'UNCLEAR', 'INJECTION_SUSPECTED']),
  confidence: z.number().min(0).max(1),
  changeItems: z
    .array(
      z.strictObject({
        description: z.string().min(3).max(600),
        likelyFieldPath: z.string().nullable().optional(),
        likelySpecSection: z.string().nullable().optional(),
      }),
    )
    .max(20)
    .optional(),
  clarificationNeeded: z.string().max(400).nullable().optional(),
  language: z.string().max(12).optional(),
});

export type ClientIntent = z.infer<typeof ClientIntentSchema>;
