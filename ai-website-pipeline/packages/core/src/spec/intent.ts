/**
 * Deterministic client-intent fast path (SPEC §18/§19, §10A discipline).
 *
 * Approvals are the one place where a misread costs a whole build, so the rules are:
 *   1. an exact quick-reply / keyword match is decided locally with high confidence — no model call,
 *      no ambiguity, no rate-limit exposure;
 *   2. everything else goes to the CLIENT_INTENT_PARSE agent turn (contract-validated), and an
 *      `APPROVE` below the configured confidence becomes UNCLEAR → one clarifying question;
 *   3. nothing ever becomes an approval without the exact `source_message_id`.
 */
export interface IntentHint {
  intent: 'APPROVE' | 'REQUEST_CHANGES' | 'UNCLEAR';
  confidence: number;
  matched: string;
}

export const APPROVE_PATTERNS: RegExp[] = [
  /^\s*(ok|okay|okey|ок|окей)\b/i,
  /^\s*(ha|xa|да|yes|yep|yeah|👍)\b/i,
  /^\s*1\s*$/,
  /tasdiqlayman/i,
  /tasdiqla/i,
  /ma(’|')?qul\b/i,
  /roziman/i,
  /^\s*(подтверждаю|согласен|согласна)\b/i,
  /^\s*approve\b/i,
  /^\s*(yaxshi|zo‘r|durang|mayli)\b/i,
];

export const REQUEST_CHANGE_PATTERNS: RegExp[] = [
  /^\s*2\s*$/,
  /o(’|')?zgartir/i,
  /o‘zgartir/i,
  /change/i,
  /\b(edit|modify|revise)\b/i,
  /(измен|поменять|не так|исправ)/i,
  /qo(s|‘)h(ish|moqchi)/i,
  /kerak emas/i,
  /boshqa(chа|cha)?\s+bo/i,
];

/**
 * Exact-match fast path. Returns null when the text is not a clear keyword answer, in which case
 * the caller asks the agent.
 */
export function classifyIntentHint(text: string): IntentHint | null {
  const t = (text ?? '').trim();
  if (t.length === 0) return null;
  if (t.length > 200) return null; // long messages carry detail: let the agent read them
  for (const re of REQUEST_CHANGE_PATTERNS) {
    const m = re.exec(t);
    if (m) return { intent: 'REQUEST_CHANGES', confidence: 0.9, matched: m[0] };
  }
  for (const re of APPROVE_PATTERNS) {
    const m = re.exec(t);
    if (m) return { intent: 'APPROVE', confidence: 0.95, matched: m[0] };
  }
  return null;
}

/** The approval decision the pipeline may act on, after threshold + evidence checks. */
export interface ApprovalDecision {
  intent: 'APPROVE' | 'REQUEST_CHANGES' | 'UNCLEAR';
  confidence: number;
  source: 'KEYWORD' | 'AGENT';
}

export function decideApproval(params: {
  text: string;
  agentIntent?: { intent: string; confidence: number } | null;
  threshold: number;
}): ApprovalDecision {
  const hint = classifyIntentHint(params.text);
  if (hint) return { intent: hint.intent, confidence: hint.confidence, source: 'KEYWORD' };
  const agent = params.agentIntent;
  if (!agent) return { intent: 'UNCLEAR', confidence: 0, source: 'AGENT' };
  if (agent.intent === 'APPROVE' && agent.confidence >= params.threshold) {
    return { intent: 'APPROVE', confidence: agent.confidence, source: 'AGENT' };
  }
  if (agent.intent === 'REQUEST_CHANGES' && agent.confidence >= 0.5) {
    return { intent: 'REQUEST_CHANGES', confidence: agent.confidence, source: 'AGENT' };
  }
  return { intent: 'UNCLEAR', confidence: agent.confidence, source: 'AGENT' };
}
