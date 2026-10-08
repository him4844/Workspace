/**
 * Requirements Agent (SPEC §5.1, §6, §9, §11, §49).
 *
 * Division of labour: the deterministic planner (packages/core) decides *which* field to ask
 * about and *when* to stop; this agent phrases that question for the client and extracts
 * structured values from the client's answer. The model never decides completeness.
 */
import type { QuestionPlan } from '@wpp/core';
import type { RequirementFieldState } from '@wpp/core';
import type { Vision } from '../contracts.js';
import { RequirementsTurnSchema, zodErrorsToMessages, type RequirementsTurn } from '../contracts.js';
import type { ValidateResult } from '../runtime.js';
import type { RunAgentInput } from '../runtime.js';
import type { ReasoningEffort } from '../llm/types.js';

export const REQUIREMENTS_OUTPUT_SCHEMA_REF = 'docs/contracts/requirements-turn-output.json';

export interface AgentTurnContext {
  projectType: string;
  language: string;
  counters: { questionsAsked: number; maxQuestions: number };
  openContradictions: number;
  blockingFields: string[];
}

/** [3] TASK SPECIFICATION — what this turn must produce. */
export function buildTaskBlock(plan: QuestionPlan, ctx: AgentTurnContext): string {
  if (plan.kind === 'ASK') {
    const field = plan.field;
    const lines = [
      `Produce the next single turn of the requirements interview (turn #${ctx.counters.questionsAsked + 1} of max ${ctx.counters.maxQuestions}).`,
      `TARGET FIELD: ${plan.fieldPath}${field?.category ? ` (category: ${field.category})` : ''}`,
      `WHY THIS FIELD: ${describeReason(plan.reason)}`,
      field?.question ? `CANONICAL MEANING (do not change it): ${field.question}` : '',
      plan.prompt ? `EXTRA GUIDANCE: ${plan.prompt}` : '',
      field?.defaultSuggestion ? `SUGGESTED DEFAULT if the client does not know: ${field.defaultSuggestion}` : '',
      ctx.openContradictions > 0 ? `There are ${ctx.openContradictions} open contradiction(s): resolve them with this question if they touch this field.` : '',
      '',
      'Requirements for your answer:',
      '- turnType: ASK_QUESTION, or ACKNOWLEDGE_AND_ASK if you also confirm what the client just said.',
      '- question.fieldPath must be exactly the TARGET FIELD above.',
      '- question.text: one short, friendly question in the client\'s language, max 500 characters, easy to answer in a DM.',
      '- quickReplies: 2-4 short options ONLY if the answer is naturally a choice (max 13, each max 20 chars).',
      '- fieldUpdates: extract the client\'s LAST message into field updates with the correct statuses, and set sourceMessageId to that message id (shown in the CLIENT CONTENT block). If the last message did not answer anything, send an empty array.',
      '- A vague answer ("modern", "simple", "fast") must NOT become CLIENT_CONFIRMED: mark it UNCLEAR and let this question clarify it.',
      '- vision: refresh the three lists (clientConfirmed / aiInferred / notSpecified) from the current state.',
    ];
    return lines.filter((l) => l !== '').join('\n');
  }

  return [
    'The questionnaire has no mandatory field left to ask and no contradiction is open.',
    'Produce the FINAL turn of the requirements interview.',
    '',
    'Requirements for your answer:',
    '- turnType: COMPLETE.',
    '- question: omit it.',
    '- fieldUpdates: include any last confirmed facts from the client\'s last message.',
    '- internalSummaryMd: a compact internal summary (Markdown, 200-800 words) for the Specification Agent: business, audience, pages, features, design, content/languages, integrations, hosting/domain, budget/deadline implications, AI inferences (clearly marked as inferred, not confirmed) and open questions.',
    '- The summary is INTERNAL: the client never sees it and is never asked to approve requirements.',
  ].join('\n');
}

function describeReason(reason: string): string {
  switch (reason) {
    case 'CONTRADICTION': return 'two answers conflict — ask one question that resolves the conflict';
    case 'CLARIFY_VAGUE': return 'the previous answer was vague — ask for something concrete and measurable';
    case 'CONFIRM_DEFAULT': return 'a default was proposed earlier and is still unanswered — ask whether the client accepts it';
    case 'CONFIRM_INFERRED': return 'this was inferred by the AI and must not become a requirement without the client confirming it';
    case 'NEXT_MANDATORY': return 'next mandatory field of the questionnaire template';
    default: return 'business-specific requirement for this website type';
  }
}

/** [4] PROJECT DATA — structured state, never prose (SPEC §50). */
export function buildProjectDataBlock(input: {
  projectId: string;
  projectType: string;
  fields: RequirementFieldState[];
  /** the question the client is answering right now (null when we have not asked yet) */
  pendingQuestion?: { fieldPath: string; text: string } | null;
  contradictions: Array<{ fieldA: string; fieldB: string; description: string; severity: string; status: string }>;
  vision: Vision | null;
  counters: { questionsAsked: number; maxQuestions: number; clarificationsByField: Record<string, number> };
}): unknown {
  return {
    projectId: input.projectId,
    projectType: input.projectType,
    interview: {
      questionsAsked: input.counters.questionsAsked,
      maxQuestions: input.counters.maxQuestions,
      clarificationsByField: input.counters.clarificationsByField,
    },
    pendingQuestion: input.pendingQuestion ?? null,
    requirementFields: input.fields.map((f) => ({
      fieldPath: f.fieldPath,
      category: f.category,
      status: f.status,
      priority: f.priority,
      mandatory: f.mandatory,
      value: f.value ?? null,
      note: f.note ?? null,
    })),
    openContradictions: input.contradictions,
    previousVision: input.vision,
    statusVocabulary: ['EMPTY', 'UNCLEAR', 'AI_INFERRED', 'DEFAULT_PROPOSED', 'CLIENT_CONFIRMED', 'CLIENT_APPROVED_DEFAULT', 'NOT_APPLICABLE'],
  };
}

export function validateRequirementsTurn(raw: unknown): ValidateResult<RequirementsTurn> {
  const parsed = RequirementsTurnSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: zodErrorsToMessages(parsed.error) };
}

/** Convenience: everything `runAgentTurn` needs for this agent. */
export function buildRequirementsRunInput(opts: {
  task: string;
  projectData: unknown;
  clientMessages: Array<{ id?: string; at?: string; text: string }>;
  outputSchema: unknown;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** reasoning models (Gemini 3.x) can spend the whole completion cap thinking */
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  onRaw?: RunAgentInput<RequirementsTurn>['onRaw'];
}): RunAgentInput<RequirementsTurn> {
  return {
    task: opts.task,
    projectData: opts.projectData,
    clientMessages: opts.clientMessages,
    outputSchema: opts.outputSchema,
    validate: validateRequirementsTurn,
    model: opts.model,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    reasoningEffort: opts.reasoningEffort,
    timeoutMs: opts.timeoutMs,
    onRaw: opts.onRaw,
  };
}

/**
 * The message that goes to the client, or null when nothing should be sent.
 * Instagram limits: one short DM. We never send internal summary or status vocabulary.
 */
export function toClientMessage(turn: RequirementsTurn): string | null {
  if (turn.turnType === 'COMPLETE') return null;
  const parts: string[] = [];
  if (turn.acknowledgment && turn.acknowledgment.trim().length > 0) parts.push(turn.acknowledgment.trim());
  if (turn.question) {
    parts.push(turn.question.text.trim());
    const quick = (turn.question.quickReplies ?? []).slice(0, 13).filter((q) => q.trim().length > 0);
    if (quick.length >= 2) parts.push(quick.join(' · '));
  }
  const text = parts.join('\n\n').trim();
  return text.length > 0 ? text.slice(0, 950) : null;
}

/** Deterministic fallback question text if the model returned none (never blocked by LLM text). */
export function fallbackQuestionText(plan: QuestionPlan): string {
  if (plan.kind === 'ASK') {
    const base = plan.field?.question ?? `Keling, ${plan.fieldPath} bo'yicha aniqlashtiramiz.`;
    return plan.prompt && plan.prompt !== base ? `${base}\n\n${plan.prompt}` : base;
  }
  return 'Rahmat! Ma\'lumotlar to\'plandi.';
}
