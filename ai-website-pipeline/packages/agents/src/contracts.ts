/**
 * Machine-readable contracts, mirrored from `docs/contracts/*.json` (docs/06 §8).
 * Contract tests assert that the JSON files' `exampleValid` / `exampleInvalid` fixtures
 * behave exactly as these schemas say (docs/14 §4).
 */
import { z } from 'zod';
import { REQUIREMENT_STATUSES } from '@wpp/core';

export const AGENT_STATUSES = ['SUCCESS', 'FAILED', 'NEEDS_REVIEW'] as const;
/**
 * The single source of truth for agent failure codes. `AgentErrorCode` (runtime.ts) is *derived*
 * from this array, so the runtime type and the wire enum cannot drift apart again; a contract test
 * asserts parity with `docs/contracts/common-envelope.json`.
 */
export const AGENT_ERROR_CODES = [
  'LLM_TIMEOUT', 'LLM_RATE_LIMITED', 'LLM_PROVIDER_ERROR', 'LLM_BUDGET_EXCEEDED', 'INVALID_JSON',
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
  // The DB has a unique (spec_version_id, code) index on acceptance_criteria, and the Phase-6
  // acceptanceTestMap keys by acCode alone. Model output that numbers AC-001 anew for every
  // requirement otherwise passes the frozen JSON shape, then crashes persistence after client
  // summary validation. Reject it here so the runtime's one repair can renumber before handlers
  // touch the DB (§49/§57).
  const acCodes = value.spec.requirements.flatMap((r) => r.acceptanceCriteria.map((ac) => ac.code));
  if (new Set(acCodes).size !== acCodes.length) {
    ctx.addIssue({
      code: 'custom', path: ['spec', 'requirements'],
      message: 'acceptance-criterion codes must be globally unique within one specification version (AC-001, AC-002, …)',
    });
  }
});

export type SpecificationOutput = z.infer<typeof SpecificationOutputSchema>;
export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

// ------------------------------------------------------------------ spec auditor (§20)

/** One issue, exactly as `docs/contracts/spec-audit-output.json` ($defs/issue) defines it. */
export const AuditIssueSchema = z.strictObject({
  code: z.string().min(2).max(80),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  description: z.string().min(3).max(600),
  specSection: z.string().max(160).nullable().optional(),
  specRequirementCode: z.string().max(80).nullable().optional(),
  suggestedFix: z.string().max(600).nullable().optional(),
});

export const AuditChecksSchema = z.strictObject({
  completeness: z.enum(['PASS', 'FAIL']),
  consistency: z.enum(['PASS', 'FAIL']),
  ambiguity: z.enum(['PASS', 'FAIL']),
  codingReadiness: z.enum(['PASS', 'FAIL']),
  clientAlignment: z.enum(['PASS', 'FAIL']),
});

/**
 * The §20 structured result. Two contract-level guards keep it usable: a FAIL must say *why*
 * (otherwise §21 has nothing to send to the Specification Agent and §42 nothing to show a human),
 * and a PASS may not carry criticalIssues. `checks` is optional in the frozen JSON Schema — the
 * deterministic audit fills the dimensions the model leaves out.
 */
export const SpecAuditOutputSchema = z
  .strictObject({
    status: z.enum(['PASS', 'FAIL']),
    score: z.number().min(0).max(100),
    criticalIssues: z.array(AuditIssueSchema).max(40),
    warnings: z.array(AuditIssueSchema).max(40),
    missingRequirements: z.array(AuditIssueSchema).max(40),
    contradictions: z.array(AuditIssueSchema).max(40),
    ambiguities: z.array(AuditIssueSchema).max(40),
    recommendations: z.array(z.string().min(3).max(600)).max(30),
    checks: AuditChecksSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'FAIL') {
      const reasons = value.criticalIssues.length + value.missingRequirements.length
        + value.contradictions.length + value.ambiguities.length;
      if (reasons === 0) {
        ctx.addIssue({
          code: 'custom', path: ['status'],
          message: 'status FAIL requires at least one issue in criticalIssues/missingRequirements/contradictions/ambiguities — name what is wrong',
        });
      }
    } else if (value.criticalIssues.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'status PASS cannot carry criticalIssues' });
    }
    if (value.checks) {
      // A failed dimension must be explained by an issue in one of its plausible buckets: an
      // unexplained "FAIL" is exactly the empty audit §21 cannot act on.
      const blamedFor: Record<string, Array<keyof typeof value>> = {
        completeness: ['missingRequirements', 'warnings', 'criticalIssues'],
        consistency: ['contradictions', 'warnings', 'criticalIssues'],
        ambiguity: ['ambiguities', 'warnings', 'criticalIssues'],
        codingReadiness: ['criticalIssues', 'missingRequirements', 'warnings'],
        clientAlignment: ['contradictions', 'criticalIssues', 'warnings'],
      };
      for (const [dimension, state] of Object.entries(value.checks)) {
        if (state !== 'FAIL') continue;
        const buckets = blamedFor[dimension] ?? ['criticalIssues', 'warnings'];
        const explained = buckets.some((bucket) => (value[bucket] as Array<unknown>).length > 0);
        if (!explained) {
          ctx.addIssue({
            code: 'custom', path: ['checks', dimension],
            message: `checks.${dimension} is FAIL but no issue explains it — every failed check needs a concrete issue (${buckets.join(' | ')})`,
          });
        }
      }
    }
  });

export type SpecAuditIssue = z.infer<typeof AuditIssueSchema>;
export type AuditChecks = z.infer<typeof AuditChecksSchema>;
export type SpecAuditOutput = z.infer<typeof SpecAuditOutputSchema>;

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
