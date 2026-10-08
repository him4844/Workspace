/**
 * Website-type detection (SPEC §7).
 *
 * Two sources, in order of authority:
 *   1. the client's answer to `website_type.type` (the questionnaire asks it explicitly) —
 *      `normaliseProjectType()` maps whatever they said onto a package code;
 *   2. a keyword hint from the first message, so the right package questionnaire is used
 *      from the very first reply (best effort, never authoritative).
 *
 * Pure and data-driven: adding a deliverable type means adding a package JSON, not code.
 */

/** Package codes that exist under `config/questionnaires/`. */
export const PROJECT_TYPES = ['LANDING', 'CORPORATE', 'ECOMMERCE', 'RESTAURANT', 'EDUCATION', 'OTHER'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number] | 'UNKNOWN';

const TYPE_KEYWORDS: Array<{ type: (typeof PROJECT_TYPES)[number]; words: string[] }> = [
  {
    type: 'RESTAURANT',
    words: ['restoran', 'restaurant', 'kafe', 'cafe', 'oshxona', 'menu', 'menyu', 'pizza', 'fast food', 'bar ', 'choyxona', 'stol bron'],
  },
  {
    type: 'ECOMMERCE',
    words: ['onlayn do‘kon', 'internet do‘kon', 'magazin', 'savat', 'buyurtma berish', 'e-commerce', 'ecommerce', 'shop', 'store', 'sotmoqchi', 'katalog', 'narxlar bilan mahsulot'],
  },
  {
    type: 'EDUCATION',
    words: ["o‘quv markaz", 'oquv markaz', "ta'lim", 'kurs', 'maktab', 'universitet', 'o‘qituvchi', 'student', 'talaba', 'education', 'school'],
  },
  {
    type: 'LANDING',
    words: ['landing', 'bitta sahifa', 'bir sahifa', 'reklama uchun sayt', 'kampaniya', 'promo sayt'],
  },
  {
    type: 'CORPORATE',
    words: ['korxona', 'kompaniya sayti', 'korporativ', 'corporate', 'kompaniyamiz', 'firma', 'xizmatlar haqida'],
  },
];

/** Best-effort hint from free text. `UNKNOWN` when nothing matches (§7: never guess loudly). */
export function detectProjectTypeHint(text: string | null | undefined): ProjectType {
  const haystack = (text ?? '').toLowerCase();
  if (haystack.trim().length === 0) return 'UNKNOWN';
  let best: { type: (typeof PROJECT_TYPES)[number]; word: string } | null = null;
  for (const entry of TYPE_KEYWORDS) {
    for (const word of entry.words) {
      if (haystack.includes(word) && (!best || word.length > best.word.length)) {
        best = { type: entry.type, word };
      }
    }
  }
  return best ? best.type : 'UNKNOWN';
}

/**
 * Map the client's answer to `website_type.type` (or a type the team set manually) onto a
 * package code. Accepts 'RESTAURANT', 'restaurant', 'Restoran', { type: 'restaurant' }.
 */
export function normaliseProjectType(input: unknown): ProjectType {
  if (input === null || input === undefined) return 'UNKNOWN';
  const raw = typeof input === 'object' && 'type' in (input as Record<string, unknown>)
    ? (input as Record<string, unknown>).type
    : input;
  if (typeof raw !== 'string') return 'UNKNOWN';
  const value = raw.trim().toUpperCase();
  if ((PROJECT_TYPES as readonly string[]).includes(value)) return value as ProjectType;
  return detectProjectTypeHint(raw);
}
