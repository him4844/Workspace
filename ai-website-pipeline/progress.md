# Loyiha jarayoni — `progress.md`

> Har sessiyada holat, bajarilgan ish, haqiqiy test natijalari va ochiq xavflar yangilanadi.
> Batafsil faza hisobotlari: `PHASE_REPORTS/phaseN.md`; xom dalillar: `PHASE_REPORTS/evidence/`.
> **Oxirgi yangilanish:** 2026-10-11 (Tashkent) — tashqi mustaqil audit (`AUDIT.md`) yakunlandi va uning **P0-1 hamda P1-1…P1-4** topilmalari test bilan yopildi; CI endi to‘liq `verify` pipeline‘ni ishga tushiradi. Serial to‘liq tekshiruv **31 fayl / 270 test PASS** (275.8 s), schema drift **39/39 jadval + 18/18 enum**, typecheck 0 xato. P5 boshlanmagan; aniq tasdiq va generated-site stack tanlovini kutmoqda (`AUDIT.md` §8D tavsiyasi: statik HTML/CSS/vanilla JS).
>
> _2026-10-09 — P0–P4 bo‘yicha aniqlangan kamchiliklarni tuzatish yakunlandi; serial to‘liq tekshiruv 24 fayl / 214 test PASS, docs/contracts PASS._

## 1. Loyiha va qat’iy cheklovlar

`SPEC.md` bo‘yicha AI Website Production Pipeline:

```text
Instagram DM → talablarni yig‘ish → texnik spetsifikatsiya + mijozga qisqa xulosa
→ xulosani ko‘rish → mijozdan aniq approve/change qarori
→ Spec Auditor → coding agent → runtime Code Checker
→ Team Panel → inson jamoasi → narx/muddat → yetkazib berish
```

- Tanlangan platforma stacki (Option A): TypeScript monorepo, Fastify, Zod, Drizzle, PostgreSQL/PGlite, Next.js, Playwright.
- **Bepul-only:** `LLM_FREE_ONLY=true`; faqat tekshirilgan bepul provider/model route’lari. `$10/kun` limit ikkilamchi himoya, pul sarflashga ruxsat emas.
- Gemini talablar/spec matni yozishi mumkin, **kod yozmaydi**. P5 coding-agent route’i Gemini bo‘lmaydi; repo kodi assistant tomonidan yoziladi.
- Haqiqiy provider bilan auditor yozuvchidan boshqa vendor va alohida credential bo‘lishi shart; bir xil vendor/shared-key fallback taqiqlangan.
- Mijoz tasdig‘i ikki qadamli: avval xulosa yuboriladi, mijoz javobidan keyin approve/change so‘raladi.
- Fazalar ketma-ket. Har faza hisobot va explicit gate’ga ega; P5’ga hozircha ruxsat berilmagan.
- Kalitlar faqat gitignored `.env`/vaqtinchalik joylarda. Hech qachon commit yoki logga chiqarilmaydi.

## 2. Fazalar holati

| Faza | Hozirgi holat | Asosiy dalil |
|---|---|---|
| P0 | ✅ tasdiqlangan | Arxitektura/stack qarorlari; `DECISIONS.md` |
| P1 | ✅ yakunlangan va rate-limit bilan mustahkamlangan | `PHASE_REPORTS/phase1.md`; D-062 |
| P2 | ✅ yakunlangan; clarifier, retry, budget guard tuzatildi | `PHASE_REPORTS/phase2.md`; D-052/D-054/D-056 |
| P3 | ✅ yakunlangan; summary gate va draft saqlash tuzatildi | `PHASE_REPORTS/phase3.md`; D-053/D-058 |
| P4 | ✅ Spec Auditor yakunlangan; remediation bilan qayta tekshirildi | `PHASE_REPORTS/phase4.md`; `evidence/phase4-live-all-fixes.txt` |
| **P0–P4 remediation** | ✅ serial tekshiruv va docs check PASS; Phase 5 boshlanmadi | `evidence/phase0-4-remediation-verify.txt` |
| P5 | ⏸️ **boshlanmagan — explicit approval + generated-site stack tanlovi kutilmoqda** | React/Next static vs plain HTML/CSS ochiq |
| P6–P8 | ⬜ keyingi fazalar | P5’dan keyin |

## 3. P0–P4’da tuzatilgan asosiy kamchiliklar

1. **429 va job retry:** provider `retryAfterMs` endi `jobs.run_at` vaqtiga o‘tadi; provider deadline + 1 soniyada qayta urinish rejalashtiriladi. 24 soatdan uzun kutish yoki urinish limiti tugashi DEAD_LETTER → CRITICAL human task → T30 `BLOCKED` qiladi.
2. **Spec/Client Summary sifati:** §18 qisqa mijoz xulosasi endi MUST sarlavhalarini aynan takrorlashni talab qilmaydi; maqsad/sahifalar/funksiyalar/dizayn va sahifa to‘qib chiqarmaslik tekshiriladi. Tekshiruvdan o‘tmagan draft va aniq gaplar saqlanadi; bounded repair oldingi draftni ko‘radi; yakuniy DB yozuv atomic.
3. **Savolnoma aniqlashtirishlari:** mismatch bo‘lgan Uzbek clarifier/variantlar tuzatilib, data-driven regression testlar qo‘shildi.
4. **Auditor mustaqilligi:** `cohere/north-mini-code:free` live-proven preset; haqiqiy auditor boshqa vendor/alohida kalitdan foydalanadi, yashirin same-vendor fallback yo‘q.
5. **Har kungi sarf himoyasi:** paid-route so‘rovidan avval org/UTC-day bo‘yicha atomik worst-case budget reservation (25% margin); noma’lum pricing bloklanadi. Bepul route’lar reservation qilmaydi; `LLM_FREE_ONLY=true` o‘zgarishsiz.
6. **Outbound pacing:** `SEND_RATE_PER_MINUTE` haqiqiy Instagram connection bo‘yicha DB’da durable 60 soniyali limit; overflow queue qilinadi va keyingi window’da yuboriladi. Simulator Graph limiter’ni chetlab o‘tadi.
7. **Human-visible failure:** dead-letter/auditor no-verdict holati task bilan birga loyihani `BLOCKED` qiladi; jim kutish yo‘q.
8. **HTTP/prompt/test coverage:** `/spec-audit` endpoint Fastify orqali tekshirildi; prompt-size script auditorni ham qamraydi; testlar real `.env` provider’lariga bog‘lanmaydi; ortiqcha Fastify deprecation warning olib tashlandi.

Qarorlar va fayl darajasidagi tafsilotlar: `DECISIONS.md` D-052…D-062, `PHASE_REPORTS/phase4.md` §§3.1–3.4.

## 4. Tekshiruv va live natijalar

### Yakuniy to‘liq serial verify — 2026-10-09

Ishlatilgan to‘liq buyruq (`verify` Vitest’ni RAM uchun serial ishga tushiradi):

```bash
npm run verify
```

- TypeScript: **PASS**.
- Vitest: **31 test fayli, 270 test PASS** (275.76 s). Auditdan keyin qo‘shilganlar: `db-driver` (4), `config-env-parity` (5), `contract-parity` (5), `api-auth` (16), `token-estimate` (10), `job-handler-coverage` (5), `send-rate-window` (8) va `spec-core` dagi 3 ta inkor/emoji testi — jami 56 ta yangi test. Mavjud 214 testdan hech biri o‘zgarmadi.
- Schema drift: `npm run schema:drift` — 39 Drizzle jadval vs 39 migratsiya jadvali, 18 vs 18 enum turi; `event_type` tartibi bo‘yicha 1 ta **ogohlantirish** (SQL `ALTER TYPE … ADD VALUE` faqat oxiriga qo‘shadi) — xato emas.
- Docs/contracts: **23 docs present; contracts valid JSON**.
- Buyruq yakuni: **exit 0**; xom log: `PHASE_REPORTS/evidence/phase0-4-remediation-verify.txt`.

### Real bepul writer + mustaqil auditor zanjiri

`PHASE_REPORTS/evidence/phase4-live-all-fixes.txt`:
- Gemini spec yo‘li → **30/30 SPEC-REQ**.
- §18 bo‘yicha qisqa mijoz xulosasi o‘tdi; ikki bosqichli approval v1’ni lock qildi.
- Vendor-separation: OpenRouter `cohere/north-mini-code:free` auditor.
- Audit: **PASS 100, 5/5 checks PASS → READY_FOR_BUILD**.

`phase4-prompt-sizes.txt`: scripted to‘liq zanjirda 32 LLM chaqiruvi; auditor taxmini ~7,920 prompt + 2,500 output token. Bu OpenRouter’ning rasmiy TPM limiti emas (published TPM yo‘q).

To‘liq live zanjir outbound limiter qo‘shilishidan oldingi capture; limiter-ning keyingi o‘zgarishi integratsion test bilan tekshirildi. Live flow simulator kanali orqali bo‘lgan; **Meta Graph API real send/receive isboti emas**.

## 5. Qolgan risklar / ochiq qarorlar

- **Meta:** test account/app token berilmagan. Haqiqiy Instagram send/receive, permissions, app review va token refresh hali tekshirilmagan.
- **Free quota:** Gemini/OpenRouter tarif limitlari o‘zgaradi. Bitta live client/model yo‘li barcha tillar va savolnoma turlariga kafolat bermaydi; hech qanday paid fallback ishlatilmasin.
- **Auditor sifati:** bepul OpenRouter route’da reasoning o‘chirilgan (bo‘sh javob yoki token limitiga urilishni oldini olish uchun); deterministik audit va inson eskalatsiyasi xavfsizlik qatlamidir, ammo nozik hukmlarni qo‘shimcha live baholash kerak.
- **Muhit:** verify PGlite/sandbox’da; production PostgreSQL deployment, Docker/Chromium/browser test va Meta bilan ishlash sinovdan o‘tmagan.
- **P5:** coding agent/Code Checker/Team Panel bu bosqichda hali qurilmagan. Generated site **React/Next static** bo‘ladimi yoki **plain HTML/CSS** — tanlanmagan.
- **Approval gate:** P0–P4 remediation hisoboti taqdim etilgandan keyin ham, user aniq ruxsat bermaguncha P5 boshlanmaydi.

## 6. Keyingi qadam

P0–P4 remediation tugadi va testdan o‘tdi. Hisobot uchun: `PHASE_REPORTS/phase4.md`.
P5’ni boshlashdan oldin ikki javob kerak:

1. Generated-site stack: **React/Next static** yoki **plain HTML/CSS**?
2. Shu tanlov bilan Phase 5’ni boshlashga **explicit tasdiq** berasizmi?

Tasdiq bo‘lsa, P5 alohida faza sifatida boshlanadi; Gemini kod yozmaydi va project free-only qoladi.

## 7. Tez commands

```bash
npm ci --no-audit --no-fund
npm run verify
npm run simulate:phase4
```

`.env` yoki credentials faylini hech qachon ko‘rsatmay/commit qilmaymiz. PGlite bir jarayonli; server yoqilgan paytda ikkinchi DB process ishga tushirmang.
