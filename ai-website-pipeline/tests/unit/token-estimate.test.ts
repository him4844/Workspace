/**
 * P2-4: the free-tier token estimate must not assume every script costs 4 characters per token.
 *
 * `estimateTokens` used to be `Math.ceil(text.length / 4)`. That rate comes from provider docs and
 * holds for Latin prose, but BPE vocabularies are trained mostly on English: the same number of
 * Cyrillic characters costs roughly twice the tokens. `DEFAULT_LOCALE` is `uz` (Latin) but `ru` is a
 * supported client language and client text goes into the prompt verbatim, so a Russian-language
 * project was budgeted at about half its real cost — and the guard exists precisely so that WE refuse
 * an oversized request instead of the provider 429-ing it mid-phase (§58, D-040).
 */
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN, CHARS_PER_TOKEN_CJK, CHARS_PER_TOKEN_NON_LATIN, estimateTokens, scriptClass,
} from '@wpp/agents';

const repeat = (char: string, n: number): string => char.repeat(n);

describe('scriptClass — the buckets are explicit, not "everything above ASCII"', () => {
  it('keeps Latin text and Uzbek punctuation in the Latin bucket', () => {
    for (const char of ['a', 'Z', '0', ' ', '\n', '.', 'ʻ', 'ʼ', '’', '—', 'é', 'ö', '…']) {
      expect(scriptClass(char.codePointAt(0)!), char).toBe('latin');
    }
  });

  it('puts Cyrillic, Greek and other dense scripts in the non-Latin bucket', () => {
    for (const char of ['ф', 'Я', 'ї', 'Ω', 'ά', 'ا', 'ל', 'क', 'ก', '👍']) {
      expect(scriptClass(char.codePointAt(0)!), char).toBe('nonLatin');
    }
  });

  it('puts CJK, kana and Hangul in their own bucket', () => {
    for (const char of ['漢', 'あ', 'カ', '한', '中']) {
      expect(scriptClass(char.codePointAt(0)!), char).toBe('cjk');
    }
  });

  it('orders the divisors from cheapest to densest', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(CHARS_PER_TOKEN_NON_LATIN).toBe(2);
    expect(CHARS_PER_TOKEN_CJK).toBe(1.5);
    expect(CHARS_PER_TOKEN).toBeGreaterThan(CHARS_PER_TOKEN_NON_LATIN);
    expect(CHARS_PER_TOKEN_NON_LATIN).toBeGreaterThan(CHARS_PER_TOKEN_CJK);
  });
});

describe('estimateTokens', () => {
  it('is unchanged for pure Latin text — no existing measurement moves', () => {
    const uzbek = 'Osh Baraka — milliy taomlar, 3 filial, har kuni 10:00–22:00. Ma’lumotlar ʼbilanʻ.';
    expect(estimateTokens(uzbek)).toBe(Math.ceil(uzbek.length / CHARS_PER_TOKEN));
    expect(estimateTokens(repeat('a', 100))).toBe(25);
    expect(estimateTokens('')).toBe(0);
  });

  it('costs Cyrillic roughly twice what the same number of Latin characters costs', () => {
    expect(estimateTokens(repeat('a', 100))).toBe(25);
    expect(estimateTokens(repeat('ф', 100))).toBe(50);
  });

  it('splits a mixed-script prompt by class instead of averaging it away', () => {
    const mixed = repeat('a', 50) + repeat('ф', 50);
    expect(estimateTokens(mixed)).toBe(Math.ceil(50 / 4 + 50 / 2)); // 38, not 25
    expect(estimateTokens(mixed)).toBeGreaterThan(Math.ceil(mixed.length / CHARS_PER_TOKEN));
  });

  it('prices CJK at the densest rate', () => {
    expect(estimateTokens(repeat('漢', 90))).toBe(Math.ceil(90 / CHARS_PER_TOKEN_CJK)); // 60, not 23
  });

  it('classifies an astral character by its code point, not by its two UTF-16 halves', () => {
    expect('👍'.length).toBe(2); // a surrogate pair
    expect(scriptClass('👍'.codePointAt(0)!)).toBe('nonLatin');
    expect(estimateTokens('👍')).toBe(1);
    expect(estimateTokens(repeat('👍', 10))).toBe(5);
  });

  it('is never more permissive than the old length/4 formula', () => {
    // The guard may become stricter; it must never start letting through a prompt it used to refuse.
    const samples = [
      '', 'ok', repeat('a', 400), repeat('ф', 400), repeat('漢', 400), repeat('👍', 200),
      'Assalomu alaykum! Menyu kerakmi?', 'Здравствуйте, мне нужно меню',
      'Ma’lumot — ʼOsh Barakaʼ, 3 filial', '混合テキスト と русский, plus English',
    ];
    for (const text of samples) {
      const legacy = Math.ceil(text.length / CHARS_PER_TOKEN);
      expect(estimateTokens(text), JSON.stringify(text.slice(0, 40))).toBeGreaterThanOrEqual(legacy);
    }
  });
});
