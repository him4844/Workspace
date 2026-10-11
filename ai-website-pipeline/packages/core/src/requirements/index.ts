/**
 * Requirements domain (SPEC §5–§13, §10A) — pure functions, no IO.
 *
 *  - `questionnaires.ts` — the shape of a questionnaire definition (data, §50)
 *  - `completeness.ts` — the ONLY place that decides "requirements are complete" (§10)
 *  - `planner.ts` — which single question comes next (§5.1, §6, §8)
 *  - `apply.ts` — applying an agent turn's field updates with §10A rules
 *  - `detect.ts` — website-type detection / normalisation (§7)
 *
 * Everything here is deterministic; the LLM only phrases questions and extracts values.
 */
export * from './questionnaires.js';
export * from './completeness.js';
export * from './planner.js';
export * from './apply.js';
export * from './detect.js';
