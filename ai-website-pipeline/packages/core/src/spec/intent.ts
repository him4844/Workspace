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
  /^\s*(ha|xa|да|yes|yep|yeah)\b/i,
  // Emoji quick replies carry no word boundary, so `\b` after 👍 can never match: they need
  // their own pattern.
  /^\s*(👍|👌|✅|☑)/u,
  /^\s*1\s*$/,
  /tasdiqlayman/i,
  /tasdiqla/i,
  /ma(’|')?qul\b/i,
  /roziman/i,
  /^\s*(подтверждаю|согласен|согласна)\b/i,
  /^\s*approve\b/i,
  /^\s*(yaxshi|zo‘r|durang|mayli)\b/i,
];

/**
 * Negation markers, checked *before* the approve patterns.
 *
 * Uzbek negation is agglutinative and attaches to the verb stem, so the affirmative keyword is a
 * literal substring of its own negation: `tasdiqlayman` ⊂ `tasdiqla**may**man`, `roziman` in
 * `roziman **emas**`, `ma'qul` in `ma'qul **emas**`. An unanchored approve match therefore reads a
 * client *rejection* as an approval with confidence 0.95, which is above
 * `spec.approval_confidence_threshold` (0.85) — it locks the spec and releases it for build.
 * Any marker here vetoes the local approve fast path outright.
 */
export const NEGATION_PATTERNS: RegExp[] = [
  /\bemas\b/i, // ma'qul emas / kerak emas / to‘g‘ri emas
  /(mayman|maymiz|masman|masmiz|maydi|maydilar|mas)\b/i, // tasdiqlamayman / rozimasman
  /^\s*(yo[’'‘]?q|no|не|нет|not)\b/i, // a bare refusal as the whole answer
  /\b(rad|bekor)\s+(et|qil)/i, // rad etaman / bekor qilamiz
  /(xohla|ista|kelish|qabul)\s*(may|qilmay)/i, // xohlamayman / qabul qilmayman
  /(qilmayman|qilmaymiz|olmayman|bo[’'‘]?lmaydi|kerakmas)\b/i,
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

/** True when the text carries a negation marker that must veto any local approval. */
export function containsNegation(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length === 0) return false;
  return NEGATION_PATTERNS.some((re) => re.test(t));
}

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
  // A negated reply is never a local approval. It is also not asserted to be a change request —
  // the agent reads it, and a low-confidence answer degrades to UNCLEAR (one clarifying question).
  if (containsNegation(t)) return null;
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
  // Defence in depth: the client wrote a negation, so an agent APPROVE is not trustworthy enough
  // to lock a spec. It degrades to UNCLEAR → exactly one clarifying question, never a build.
  const negated = containsNegation(params.text);
  if (agent.intent === 'APPROVE' && agent.confidence >= params.threshold && !negated) {
    return { intent: 'APPROVE', confidence: agent.confidence, source: 'AGENT' };
  }
  if (agent.intent === 'REQUEST_CHANGES' && agent.confidence >= 0.5) {
    return { intent: 'REQUEST_CHANGES', confidence: agent.confidence, source: 'AGENT' };
  }
  return { intent: 'UNCLEAR', confidence: agent.confidence, source: 'AGENT' };
}
