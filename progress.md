# progress.md — loyiha jarayoni (doimiy yangilanadi)

> Bu fayl **ish jarayonining kundaligi**. Har bir ish sessiyasida yangilanadi:
> nima qilindi, qanday ishga tushiriladi, haqiqiy test natijalari, ochiq savollar.
> Batafsil hisobotlar: `PHASE_REPORTS/phaseN.md`; xom dalillar: `PHASE_REPORTS/evidence/`.
> **Oxirgi yangilanish:** 2026-10-08 kechqurun (Tashkent) — Phase 4 **TAYYOR**: Auditor Spice, jonli audit yozuvi olindi (PASS yo'li ham, FAIL→BLOCK yo'li ham), verify 16/16 fayl 179/179 test.

## 1. Loyiha nima qurmoqda

`SPEC.md` bo'yicha ichki "AI-Powered Website Production Pipeline":

```
Instagram DM → Requirements Agent → Texnik spetsifikatsiya + mijozga xulosa
   → mijozning bir marta tasdiqlashi → Spec Auditor → Main Coding Agent
   → Code Checker (runtime tekshiruv, §25A) → Team Panel → inson jamoasi
   → narx/muddat → yetkazib berish
```

Texnologiya (P0'da tasdiqlangan, **Option A**): TypeScript monorepo —
Fastify + Zod + Drizzle + PostgreSQL (sandboxda **PGlite**) + Next.js + Playwright.

## 2. Qanday ishlaymiz (SPEC §55A + `docs/phases/00_COMMON_RULES.md`)

1. Fazalar **qat'iy ketma-ket**; keyingi fazaning funksiyasi oldin yozilmaydi.
2. Har bir faza oxirida **TO'XTAYMIZ** va hisobot beramiz: nima qurildi / qanday ishga tushiriladi /
   haqiqiy test natijalari / tugallanmagan va xavfli joylar / ochiq savollar / keyingi qadam.
3. **Test ishga tushirilmaguncha "tayyor" deyilmaydi** (COMMON_RULES #7).
4. Bepul bo'lishi shart: faqat free-tier LLM'lar; kalitlar faqat gitignored `.env`/`/tmp`da.
5. **Gemini kod yozmaydi** (mijoz talabi): kodni assistant yozadi; P5 coding-agent route'i Gemini bo'lmaydi.

## 3. Fazalar holati

| Faza | Nima | Holat | Commit / dalil |
|---|---|---|---|
| P0 | Arxitektura, stack, DB sxema, state machine, kontraktlar | ✅ tasdiqlangan | `dc9a9a9` |
| P1 | Instagram gateway, suhbat dvigateli, orchestrator, simulator | ✅ | `068c5f4` |
| P2 | Requirements Agent (savolnoma-ma'lumot, completeness) | ✅ | `5503187` |
| P3 | Specification Agent, mijozga xulosa, 2 qadamli tasdiq | ✅ tasdiqlangan | `1a5b4cb` |
| **P4** | **Spec Auditor, §20–§21 audit sikli, 3 urinish → BLOCK** | ✅ **tayyor — bestätigt кутish** | `a7bfe9a` + **yakuniy commit** (D-046…D-051) |
| P5 | Main Coding Agent (landing page) | ⬜ tasdiqdan keyin | — |
| P6–P8 | Code Checker, Team Panel, rivojlangan bosqichlar | ⬜ | — |

## 4. Phase 4 — yakuniy holat (2026-10-08 kechqurun)

**Qurilgan (asos, `a7bfe9a`):** auditor agenti, deterministik audit qoidalari (SCORE_CAP, `mergeAuditVerdict`,
`shouldBlockAfterFailure`), §21 reviziya sikli (T11–T15, T34), `spec_audits` jadvali, audit artefakti,
`GET /api/v1/projects/:id/spec-audit`, `simulate:phase4`.

**Bugungi/yakuniy tuzatishlar (yakuniy commitda):**

1. **§10 deterministik qoida (D-046):** `matchedOptionStatus()` — mijoz aynan e'lon qilingan
   variantni aytsa, maydon qayta so'ralmaydi (`CLIENT_CONFIRMED`, `optionConfirmed: true`).
   Jonli isbotlangan (run #6: `RESTAURANT` → confirmation).
2. **Misdirect guard:** model boshqa maydonni so'rasa, savolnoma matni yuboriladi (jonli isbotlangan, run #6).
3. **Orchestrator (D-044, D-047):** timeout = `JOB_POLICIES[type].timeoutMs`; REQUIREMENTS_TURN
   180 s / CLIENT_INTENT_PARSE 120 s (run #6 dagi 503-bo'roni o'lchab ko'rsatdi); DEAD_LETTER →
   CRITICAL `SYSTEM_ERROR` + CRITICAL `HUMAN_REVIEW` (jonli isbotlangan, run #6).
4. **Auditor (D-045, D-049, D-051):** OpenRouter `:free` `cohere/north-mini-code:free`,
   `reasoningEffort: 'none'` → `reasoning:{enabled:false}`. Sabab: reasoning-model 9.7k-tokenli
   audit promptida 2 700 tokenni "o'ylash"ga sarflab, cap'ga urilib **bo'sh content** qaytardi —
   bu audit'ning o'lim sababi edi. Reasoning off bilan bir xil so'rov **1.03 s**da yaroqli verdict
   qaytardi. Shuningdek: repair'dagi bo'sh assistant xabar `'(empty response)'` bilan almashlandi,
   repair cap asl cap'dan pastga clamplanmaydi, TPM ogohlantirishi provider-aware.
5. **Yozuvchi (D-048):** `gemini-3.1-flash-lite` ga qotirilgan (o'lchangan: alias 503 vs pinned 200/2.96 s).
6. **SPECIFICATION (D-050):** maxOutputTokens 5000, timeout 240 s — ko'proq joy berildi, lekin
   bepul-tier yozuvchining spec'i baribir to'liq emas (26–27 ta gap) — bu Phase-3 кузатувi (writer sifati).

**Test natijalari (haqiqiy, 2026-10-08 tungi verify):**

| Nima | Natija |
|---|---|
| `npm run verify` (to'liq: typecheck + vitest + docs) | ✅ **16 fayl / 179 test / 213 s** + "OK: 23 docs present" |
| `npx tsc --noEmit` | ✅ EXIT 0 |
| `npm run simulate:phase4` (scripted) | ✅ PASS (T01→T12, ball 88, 0 mijoz xabari) |

**Jonli audit — BIRINCHI marta yozuv olindi (D-051):**

| Yurish | Nima bo'ldi |
|---|---|
| Audit-only (`DEMO_LLM=real`, 20:55) | Scripted interview → spec → approval → **jonli SPEC_AUDIT** `openrouter/cohere/north-mini-code:free` → **PASS, ball 100, 5/5 checks** → T12 **READY_FOR_BUILD** (~11 s). Audit yozuvi provider/model bilan. Dalil: `phase4-live-audit.txt`. |
| spec+audit (`DEMO_LIVE_LEGS=spec+audit`, 20:56) | Jonli spec (Gemini) → jonli audit **FAIL** (26 gap) → jonli revision → **FAIL** (27 gap) → 3-urinishdan so'ng **BLOCKED** + odamga uzatish. §21 sikli to'liq jonli isbotlangan. Dalil: `phase4-live-spec-audit.txt`. |

## 5. Jonli yurishlar (real provayderlar)

| Yurish | Nima bo'ldi |
|---|---|
| #3 | Gemini kunlik limiti (20 so'rov/kun) — 429, keyin DEAD_LETTER. Sabab topildi: `retryAfterMs` ish `runAt`iga o'tmaydi. |
| #4 | Q4 gacha boringan; keyin to'xtatilgan (dalil: `phase4-live-free-tier.txt`). |
| #5 | 28 tur javob olindi, completeness **0.958**; `website_type.type` qulflandi → §42 odamga uzatdi (sabab §10 qoidasi + clarify ma'lumoti bilan tuzatildi). |
| #6 | §10 qoidasi jonli isbotlandi (`RESTAURANT` → confirmation); 503-bo'roni DEAD_LETTER → CRITICAL HUMAN_REVIEW (D-044 jonli). Dalil: `phase4-live-run6.txt`. |
| #7 (audit-only) | **Birinchi jonli audit yozuvi: PASS → READY_FOR_BUILD** (D-051). Dalil: `phase4-live-audit.txt`. |
| #8 (spec+audit) | Jonli spec + jonli audit: FAIL(26) → revision → FAIL(27) → **BLOCKED** — §21 sikli jonli. Dalil: `phase4-live-spec-audit.txt`. |

## 6. Muhim qarorlar (DECISIONS.md)

- **D-042** yozuvchi/auditor ajratmasi; **D-044** timeout + dead-letter eskalatsiyasi;
  **D-045** auditor OpenRouter `:free`da; **D-046** §10 qoida; **D-047** JOB_POLICIES timeoutlari;
  **D-048** writer `gemini-3.1-flash-lite` ga qotirilgan; **D-049** auditor `reasoningEffort:'none'`
  (bo'sh content muammosi hal etildi); **D-050** SPECIFICATION cap + jonli §21 sikli isboti;
  **D-051** D-045 ogohlantirishi yechildi — jonli audit yozuvi olindi.
- Kalitlar: Gemini ×11 (`GEMINI_API_KEY_SPARE_1..10`), OpenRouter ×6 (`OPENROUTER_API_KEY_1..6`),
  Groq ×4 spare. Hammasi bepul tarif.
- **Ochiq:** kunlik kvota 429 — bu rejalashtirish muammosi; `retryAfterMs`ni job `runAt`iga
  o'tkazish hali qilinmagan (hozircha faqat DEAD_LETTER eskalatsiyasi).

## 7. Ochiq savollar

1. **Phase-5 stack** (React/Next statik sayt yoki oddiy HTML) — hali javobsiz; P5 kod yozishni
   boshlashdan oldin kerak.
2. **Phase-3 кузатуви (writer sifati):** bepul-tier yozuvchining spec'i 26–27 ta confirmed
   field'ni qamrab olmadi → auditor to'g'ri BLOCK qildi. Kuzatuv: writer prompt/model
   Phase 5'dan oldin ko'rib chiqiladi.
3. Sandbox cheklewleri: Docker/PostgreSQL/Redis/Chromium yo'q; Meta orqali haqiqiy yuborish
   sinalmagan.

## 8. Keyingi qadamlar

1. ✅ Bajarildi: verify 179/179, commit, `PHASE_REPORTS/phase4.md` yangilandi → **yakuniy Phase-4
   hisoboti verilmoqda** → **tasdiq kutish**.
2. Tasdiqdan so'ng P5 (Coding Agent) — Gemini kod yozmasligi sharti bilan.
3. Ochiq: kunlik-kvota 429 rejalashtirish (retryAfterMs → runAt), `/spec-audit` endpoint hali
   jonli so'rov ko'rmagan, Phase-5 stack savoli.

## 9. Tez eslatmalar

```bash
npm run dev            # api + worker, 0.0.0.0:3000 (hot-reload YO'Q — patchdan keyin qayta ishga tushiring)
npm run db:reset       # PGlite bazani tozalash (savolnomalar qayta yoziladi)
npm run verify         # to'liq to'plam
npm run simulate:phase4
npm run demo:live      # jonli oqim (DEMO_* env bilan)
```

⚠️ `/api/v1/*` uchun `x-internal-token: dev-internal-token`; simulator: `POST /dev/simulator/inbound`,
`GET /dev/simulator/outbox|stats|project/:id`. PGlite bir jarayonli — server ishlayotganda ikkinchi
jarayon bazaga ulanmasin.
