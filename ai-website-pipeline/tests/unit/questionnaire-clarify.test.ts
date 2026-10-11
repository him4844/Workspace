import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Field = { path: string; options?: string[]; clarifyPrompt?: string };
type Questionnaire = { code: string; fields: Field[] };
const root = join(process.cwd(), 'config', 'questionnaires');
const load = (code: string): Questionnaire => JSON.parse(readFileSync(join(root, `${code}.json`), 'utf8')) as Questionnaire;
const norm = (s: string) => s.toLocaleLowerCase('uz').replace(/[‘’`]/g, "'");

/**
 * Questionnaire wording audit: every choice clarification must actually help the client choose
 * among that field's options. These assertions were added after a live misdirect where a
 * clarification asked about an adjacent concept instead of the declared value (SPEC §50/§57).
 */
describe('questionnaire clarifications stay aligned with declared choices', () => {
  const fixtures: Array<{ code: string; path: string; options: string[]; hints: string[][] }> = [
    { code: 'CORPORATE', path: 'multilingual.enabled', options: ['two', 'three', 'one'], hints: [['ikki'], ['uch'], ['bir']] },
    { code: 'ECOMMERCE', path: 'cart.checkout_flow', options: ['cart', 'quick'], hints: [['savat'], ['tezkor']] },
    { code: 'ECOMMERCE', path: 'payments.methods', options: [], hints: [['click', 'payme'], ['naqd'], ['karta']] },
    { code: 'EDUCATION', path: 'lessons.video', options: ['youtube', 'vimeo', 'internal'], hints: [['youtube'], ['vimeo'], ['platformaning o‘zida', "platformaning o'zida"]] },
    { code: 'EDUCATION', path: 'payments.course', options: ['online', 'installments', 'offline'], hints: [['onlayn'], ['bo‘lib to‘lash', "bo'lib to'lash"], ['oflayn']] },
    { code: 'GENERAL', path: 'website_type.type', options: ['LANDING', 'CORPORATE', 'ECOMMERCE', 'RESTAURANT', 'EDUCATION', 'OTHER'], hints: [['landing'], ['korporativ'], ['do‘kon', "do'kon"], ['restoran'], ['ta’lim', "ta'lim"], ['boshqa']] },
    { code: 'GENERAL', path: 'budget.range', options: ['low', 'mid', 'high', 'undisclosed'], hints: [['past'], ['o‘rtacha', "o'rtacha"], ['yuqori'], ['oshkor qilinmaydi']] },
    { code: 'RESTAURANT', path: 'menu.kind', options: ['photos', 'text', 'pdf'], hints: [['rasm'], ['matn'], ['pdf']] },
    { code: 'RESTAURANT', path: 'delivery.enabled', options: ['own', 'aggregator', 'no'], hints: [['o‘z kuryer', "o'z kuryer"], ['agregator'], ['bo‘lmaydi', "bo'lmaydi"]] },
    { code: 'RESTAURANT', path: 'online_ordering.enabled', options: ['cart', 'phone', 'undecided'], hints: [['savat'], ['telefon'], ['qaror qilinmagan']] },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.code}.${fixture.path} asks about its own option values`, () => {
      const questionnaire = load(fixture.code);
      const field = questionnaire.fields.find((row) => row.path === fixture.path);
      expect(field, `${fixture.code}.${fixture.path} exists`).toBeDefined();
      if (!field) return;
      if (fixture.options.length > 0) expect(field.options).toEqual(fixture.options);
      expect(field.clarifyPrompt?.trim().length ?? 0).toBeGreaterThan(10);
      const prompt = norm(field.clarifyPrompt ?? '');
      for (const aliases of fixture.hints) {
        expect(aliases.some((alias) => prompt.includes(norm(alias))), `${fixture.code}.${fixture.path} mentions one of ${aliases.join(' / ')}`).toBe(true);
      }
    });
  }

  it('all six questionnaire files have unique field paths and non-duplicated choice options', () => {
    for (const code of ['GENERAL', 'LANDING', 'CORPORATE', 'ECOMMERCE', 'RESTAURANT', 'EDUCATION']) {
      const questionnaire = load(code);
      expect(questionnaire.code).toBe(code);
      const paths = questionnaire.fields.map((field) => field.path);
      expect(new Set(paths).size, `${code} field paths`).toBe(paths.length);
      for (const field of questionnaire.fields) {
        if (field.options) expect(new Set(field.options).size, `${code}.${field.path} options`).toBe(field.options.length);
      }
    }
  });
});
