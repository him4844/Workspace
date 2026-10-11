# WPP — Mustaqil chuqur tahlil va audit hisoboti

**Sana:** 2026-10-10 (Toshkent)
**Auditor:** tashqi mustaqil agent (Arena.ai Agent Mode) — loyihani yozgan agent emas
**Qamrov:** `21be2c5` (P0–P4 remediation) holatidagi butun repo — 236 kuzatiladigan fayl
**Usul:** har bir fayl alohida o'qildi + barcha da'volar **amalda qayta tekshirildi** (typecheck, test suite, xatti-harakat zondlari)

---

## 0. Bir qarashda

| Mezon | Natija |
|---|---|
| Umumiy baho | **B+ / 8.3–10** — bu "AI yozgan prototip" emas, **intizomli muhandislik ishi** |
| Kod hajmi | 19 100 qator TypeScript (125 fayl) + 8 700 qator hujjat/konfiguratsiya/SQL |
| Hujjatlar | 19 ta arxitektura deliverable + 8 ta JSON Schema kontrakt + 9 ta faza yo'riqnomasi + 62 ta qaror (D-001…D-062) |
| `tsc --noEmit` | ✅ **toza** (men ishga tushirdim) |
| Test suite | ✅ **24 fayl / 214 test — 100% PASS, 269 s** (men ishga tushirdim, natija `progress.md` da'vosiga to'liq mos) |
| DB sxema drifti | ✅ 39 jadval — Drizzle sxema va SQL migratsiyalar **bir xil** |
| Git tarixi maxfiyligi | ✅ **toza** — 7 commit'ning hech birida `.env` yoki API kalit yo'q |
| Ishlaydigan fazalar | P0 arxitektura · P1 Instagram gateway/orkestrator · P2 Requirements Agent · P3 Specification + mijoz tasdigi · P4 Spec Auditor |
| Qurilmagan | P5 Coding Agent · P6 Code Checker · P7 Team Panel · P8 Advanced (`apps/panel`, `apps/coderunner` — faqat README) |
| **Topilgan muammolar** | **1 × P0 · 4 × P1 · 7 × P2 · 5 × P3** (quyida, har biri `fayl:qator` bilan) |

**Eng muhim xulosa:** loyihaning *ichki* sifati juda yuqori, lekin **ishonch darajasi hujjatlarda ko'rsatilgandan past**. Eng xavfli topilma — mijoz tasdig'ini aniqlashdagi **so'z inkorini taniymaslik** (P0-1): mijoz *"Tasdiqlamayman"* desa, tizim buni **APPROVE 0.95** deb qabul qiladi va qurilishni boshlaydi.

---

## 0A. Tuzatish holati — 2026-10-11

Quyidagi topilmalardan **P0 va P1 darajasidagilari shu branch'da yopildi** — har biri test bilan,
so'ngra butun `npm run verify` qayta ishga tushirildi. P2/P3 bandlari ochiq va §8 dagi ustuvorlik
tartibida turadi.

| Topilma | Holat | Nima qilindi | Dalil |
|---|---|---|---|
| **P0-1** so'z inkori tanilmaydi | ✅ **yopildi** | `NEGATION_PATTERNS` qo'shildi va approve fast-path'dan **oldin** tekshiriladi; yangi `containsNegation()` agent qaytargan APPROVE'ni ham vetolaydi (defence in depth); 👍/✅ emoji uchun alohida pattern — `\b` simboldan keyin hech qachon ishlamas edi | `tests/unit/spec-core.test.ts` +3 test |
| **P1-1** Postgres drayveri yo'q | ✅ **yopildi** (fail-fast) | `createDb({driver})` va `assertDbDriverSupported()`: `DB_DRIVER=postgres` endi `DB_DRIVER_UNSUPPORTED` (VALIDATION, non-retryable) bilan **ma'lumot bazasi ochilishidan oldin** tushadi; 5 ta chaqiruv joyi `driver`'ni uzatadi. Drayverning o'zi hali yo'q — bu P8 ishi | `tests/unit/db-driver.test.ts` (4 test) |
| **P1-2** CI faqat docs-check | ✅ **yopildi** | `.github/workflows/ci.yml` endi to'liq `verify`'ni Node 20 va 22 da bajaradi. Loyiha ushbu repoda papka ostida turgani uchun ildizda `.github/workflows/ai-website-pipeline-ci.yml` ham qo'shildi (GitHub faqat ildizdagi workflow'larni o'qiydi). Postgres job'i **qasddan yo'q** — drayver yo'q, aks holda mavjud bo'lmagan yo'lni "tekshirgan" bo'lardik | CI'ning o'zi |
| **P1-3** `.env.example` drift | ✅ **yopildi** | Shablon `ConfigSchema` haqiqatan o'qiydigan 45 o'zgaruvchiga aniq moslandi (to'g'ri default'lar bilan); o'qilmaydigan 42 nom `PLANNED — NOT READ BY ANY CODE YET` banneri ostida izohga olindi; `docs/12` yangilandi | `tests/unit/config-env-parity.test.ts` (5 test) — drift endi build'ni buzadi |
| **P1-4** kontrakt enum drifti | ✅ **yopildi** | `AgentErrorCode` endi `AGENT_ERROR_CODES` dan **keltirib chiqariladi** (`(typeof AGENT_ERROR_CODES)[number]`), ya'ni runtime va wire-enum yana ajralib ketishi mumkin emas; `LLM_BUDGET_EXCEEDED` JSON kontraktga qo'shildi | `tests/unit/contract-parity.test.ts` (5 test) |
| **P3-1** README eskirgan | ✅ **yopildi** | Status jadvali: P0–P4 ✅ / P5–P8 ❌ (aniq sababi bilan); `docker compose` bloki "ishlamaydi (P8)" deb belgilandi; keyingi qadamlar P5 ga qaratildi | — |
| §6 hujjat-vs-reallik drifti | ✅ **qisman** | `docs/14 §3` va `§7`, `docs/16 C2`, `docs/12` haqiqatga moslandi; qaysi CI bosqichi yo'qligi va **nega** yo'qligi jadval bilan yozildi | — |
| **P2-1** `/dev/simulator/*` autentifikatsiyasiz | ✅ **yopildi** | Markaziy guard endi **loopback** talab qiladi: flag `true` bo'lsa ham tarmoqdan kirish 404. `trustProxy` yoqilmagan, shuning uchun `request.ip` — soket manzili, header bilan soxtalashtirib bo'lmaydi | `tests/integration/api-auth.test.ts` |
| **P2-2** takroriy, tartibga bog'liq auth hook'lar | ✅ **yopildi** | Uchta modul o'z root-level `preHandler`'ini ro'yxatdan o'tkazar edi (har bir so'rovda 3 marta). Endi bitta `apps/api/src/auth.ts` bor; `token !== config.INTERNAL_API_TOKEN` o'rniga **constant-time** `safeEqual()` (SHA-256 + `timingSafeEqual`) | `tests/integration/api-auth.test.ts` (16 test) |
| **P2-3** `WATCHDOG` handler'siz | ✅ **yopildi** | `HANDLERS` endi **total** `Record<JobType, JobHandler>` — keyingi tushib qolgan job turi `tsc` xatosi bo'ladi; `WATCHDOG: notImplemented('Phase 7')` qo'shildi. Orchestrator'dagi runtime `NO_HANDLER` gardi saqlandi (DB'dan kelgan `type` — string) | `tests/unit/job-handler-coverage.test.ts` (5 test) |
| **P2-4** `CHARS_PER_TOKEN=4` kirill uchun kam | ✅ **yopildi** | `estimateTokens()` endi skript-aware: lotin 4, kirill/yunon/arab va b. 2, CJK 1.5; kod nuqtalari bo'yicha sanaydi. **Natija hech qachon eskisidan past emas** — guard faqat qat'iyroq bo'ldi, lotin matn o'zgarmadi (shuning uchun `PHASE_REPORTS/evidence/` o'lchovlari hali ham to'g'ri) | `tests/unit/token-estimate.test.ts` (10 test) |
| **P2-5** fixed window, hujjatda "token bucket" | ✅ **yopildi** (hujjat + kafolat) | `docs/08`, `docs/10`, `docs/16 A5` haqiqatga moslandi; chegaradagi burst xatti-harakati **test bilan qoqib qo'yildi**; `consumeSendRateLimit` parametri `Executor`→`Db` ga toraytirildi — nested transaction endi kompilyatsiya xatosi | `tests/integration/send-rate-window.test.ts` (8 test) |
| **P2-6** o'lik `LLM_QUOTA_EXHAUSTED` shoxi | ✅ **yopildi** | Shox olib tashlandi (bu kod hech qaysi `LlmErrorCode`/`AGENT_ERROR_CODES` da yo'q); yangi kod qo'shish **frozen §49 kontraktini** buzardi. O'rniga operator xabari haqiqiy signalni ajratadi: daqiqalik kutish = TPM oynasi, soatlik/yoki kutish yo'q = kunlik kvota tugagan → boshqa free preset | — |
| **P2-7** ESLint yo'q, lekin 6 ta `eslint-disable` | ✅ **yopildi** | Barcha 6 ta izoh o'chirildi va o'rnini **haqiqiy sabab** egalladi (bootstrap stderr, `while(true)` ning chiqish yo'li, §38 sanitiserining ataylab control-char klassi). ESLint o'rnatish P5 oldidan tavsiya sifatida qoldi | `grep eslint-disable` → 0 |
| **P3-1** README eskirgan | ✅ **yopildi** | Status jadvali P0–P4 ✅ / P5–P8 ❌; `docker compose` "ishlamaydi (P8)" deb belgilandi | — |
| **P3-4** `PHASE0_REVIEW.html` ildizda | ✅ **yopildi** | `PHASE_REPORTS/PHASE0_REVIEW.html` ga ko'chirildi (`git mv`, tarix saqlangan); hech qaysi fayl unga havola qilmagan | — |
| **P3-2** `phase4-live-all-fixes.txt` o'ziga zid | ⏳ **ochiq, ataylab** | Bu **tarixiy dalil fayli** — `PHASE_REPORTS/evidence/` xom yozuv. Uni tahrirlash dalilni soxtalashtirish bo'lardi; ziddiyat `AUDIT.md` §4 da qayd etilgan holda qoladi | — |
| **P3-3** planner/model maydon nomlari mos kelmasligi (30/30 turn warning) | ⏳ **ochiq** | Scripted-persona demo artefakti; P5 da haqiqiy planner paydo bo'lganda yopiladi | — |
| **P3-5** `data/projects/*` — scripted-persona natijasi | ⏳ **ochiq, ataylab** | Fayllar o'zining haqiqiy LLM natijasi emasligini ochiq aytadi; ular demo uchun kerak. Repo'ga kirmagan (`.gitignore`) | — |

**Yangi vosita — `scripts/check-schema-drift.ts`** (`npm run schema:drift`, CI'da majburiy bosqich):
Drizzle sxema bilan `db/migrations/*.sql` ni **jadval va enum qiymatlari** bo'yicha solishtiradi.
Auditda bu tekshiruv qo'lda va faqat jadvallar bo'yicha qilingan edi (§2). Skript enum'larni ham
qamrab oldi va `ALTER TYPE … ADD VALUE` ni hisobga oladi: `event_type` ning *tartibi* SQL'da
Drizzle'dan farq qiladi, chunki migratsiya faqat oxiriga qo'sha oladi. Hech qayerda enum bo'yicha
tartiblash/range-solishtirish yo'q, shuning uchun bu **ogohlantirish**, xato emas.

**Yakuniy tekshiruv (shu branch'da, toza `npm ci`, Node v22.22.3):**

```
node scripts/check-docs.mjs   -> OK: 23 docs present, contracts valid JSON
npm run schema:drift          -> 39 Drizzle vs 39 migrated tables, 18 vs 18 enums, 1 WARN (event_type order) -> exit 0
npm run typecheck             -> 0 errors
npm run test                  -> 31 files / 270 tests PASS, 275.8 s
```

Ya'ni §0 jadvalidagi "24 fayl / 214 test" endi **31 fayl / 270 test** — 7 ta yangi test fayli va
56 ta yangi test qo'shildi, mavjud 214 tasidan **hech biri buzilmadi**.

---



### 1.1 Biznes maqsad

Instagram DM orqali kelgan mijoz so'rovini **yetkazib beriladigan veb-saytga** aylantiruvchi **ichki** konveyer (SaaS emas — `SPEC §2`):

```
Mijoz DM → Requirements Agent → Texnik spetsifikatsiya + mijozga qisqa xulosa
→ mijozdan BIR martalik aniq approve/change → Spec Auditor → Coding Agent
→ runtime Code Checker → Team Panel → inson jamoasi → narx/muddat → yetkazib berish
```

Asosiy g'oya: **AI takrorlanuvchi ishni qiladi, qaror insonda qoladi.** Narx, muddat va yakuniy qabul — faqat inson (`T25–T29` guard'lari `humanActorType === 'HUMAN'` talab qiladi).

### 1.2 Arxitekturadagi markaziy printsip

Loyihaning eng kuchli va eng izchil qarori — **"model yozadi, yadro tekshiradi"** bo'linishi:

| Qatlam | Nima qiladi | Nima qila **olmaydi** |
|---|---|---|
| `packages/core` (2 206 q.) | Deterministik qarorlar: state machine, completeness engine, question planner, traceability audit, spec-audit qoidalari, intent klassifikatsiya | LLM chaqirmaydi, IO qilmaydi — 100% sof, testlanadigan |
| `packages/agents` (1 858 q.) | Prompt yig'ish, JSON chiqarish, schema validatsiya, **1 marta** repair, provider adapterlari | Holatni o'zgartirmaydi, DB'ga yozmaydi |
| `apps/worker` (3 013 q.) | Orkestrator: job claim → guard → handler → retry/backoff/dead-letter → transition | Agentlar bir-birini chaqirmaydi |
| `packages/db` (3 092 q.) | Yagona SQL qatlami, 39 jadval, repository'lar | — |
| `apps/api` (1 314 q.) | Yupqa HTTP: webhook (HMAC), inspector, spec, dev simulator | Biznes qoidalar saqlamaydi |

Natija: **AI hech qachon hal qiluvchi qarorni o'zi bermaydi.** `computeCompleteness()` faqat *statuslarni* o'qiydi — model "COMPLETE" deb javob bersa-yu, muhandislik motori rozi bo'lmasa, javob **e'tiborsiz qoldiriladi** va loglanadi (`requirements.ts:~355`, `PREMARKED_COMPLETE_IGNORED`). Bu — `SPEC §10` ning to'g'ri implementatsiyasi va kamdan-kam uchraydigan intizom.

### 1.3 Fayl-modul tahlili (har bir blok bo'yicha)

**`packages/core/src/types.ts`** — 23 holat (`SPEC §3` verbatim), 7 talab statusi (`§10A`), `JOB_POLICIES` jadvali (har bir job turi uchun concurrency/timeout/maxAttempts/backoff — **kod emas, ma'lumot**), `JOBS_ALLOWED_IN_STATE` (qaysi holatda qaysi job mumkin). Izohda 60 s timeout'ni 180 s'ga oshirishning *sababi* live o'lchov bilan yozilgan (2026-10-08, 503 storm) — bu namunali hujjatlashtirish.

**`packages/core/src/state-machine/transitions.ts`** — 34 ta transition (T01–T34), har biri `from[]`, `to`, `trigger`, `actor`, `guard(ctx)`, `implementedIn` (qaysi fazada qurilgan) bilan. `decideTransition()` sof funksiya: terminal holat, human-gate va guard tekshiruvlari. T34 (§21 audit loop uchun SPEC_GENERATING → SPEC_AUDIT) Phase 0 jadvalida **yo'q edi** va Phase 4'da qo'shildi — bu kamchilikni topib tuzatish madaniyatini ko'rsatadi.

**`packages/core/src/requirements/*`** — 5 fayl: `detect.ts` (veb-sayt turini aniqlash, o'zbek/ingliz/rus kalit so'zlar), `questionnaires.ts` (GENERAL + paket birlashtirish, `dependsOn` gate'lari, validatsiya), `planner.ts` (keyingi **bitta** savolni deterministik tanlash; ustunlik: ziddiyat > noaniq javob > DEFAULT_PROPOSED > AI_INFERRED > majburiy > dinamik), `completeness.ts` (yagona yakuniy instantsiya), `apply.ts` (model takliflarini **darvoza**dan o'tkazish: `CLIENT_CONFIRMED` uchun haqiqiy inbound `sourceMessageId` shart, AI inference mijoz haqiqatini **izohsiz** pasaytira olmaydi).

**`packages/core/src/spec/*`** — `intent.ts` (mijoz qarorini aniqlash: keyword fast-path + agent), `traceability.ts` (REQ → SPEC-REQ → AC zanjiri, coverage hisobi), `rules.ts` (summary↔spec izchilligi, versiya/lock qoidalari, ikki bosqichli approval holati), `render.ts` (Markdown'ga deterministik render — hujjat shakli model'ning "kayfiyati"ga bog'liq emas).

**`packages/core/src/audit/rules.ts`** (360 q.) — Phase 4 yuragi. `auditSpecStructure()`: traceability gap'lari, AC'siz MUST, o'lchanmaydigan so'zlar ("beautiful", "zamonaviy", "qulay", "современный" + `MEASURABLE` regex bilan tekshirish), blokirovka qiluvchi ochiq savol, hech kim belgilamagan sahifa, summary'da noma'lum sahifa. `mergeAuditVerdict()`: **strukturaviy CRITICAL/MAJOR model'ning PASS'ini bekor qiladi**, ball shippa bilan cheklanadi (CRITICAL ≤30, MAJOR ≤60, MINOR ≤80), FAIL bo'lgan o'lchov `checks`'da PASS bo'la olmaydi. Bu `D-031` intizomi va u **to'g'ri** bajarilgan.

**`packages/agents/src/runtime.ts`** — bitta LLM chaqiruvi, strict JSON, schema validatsiya, **ko'pi bilan 1** repair, keyin `SUCCESS/FAILED/NEEDS_REVIEW` konverti. 429/5xx uchun *chegaralangan* kutish (`maxRateLimitWaits=2`, `maxRateLimitWaitMs=70 s`) — bepul tarif uchun to'g'ri: token-per-minute limit bu **pauza**, xato emas.

**`packages/agents/src/prompt.ts`** — `SPEC §38` (prompt injection) implementatsiyasi: 6 ta blok qat'iy tartibda, mijoz matni faqat `<<<CLIENT_CONTENT>>>` delimitrlari ichida, boshqaruv belgilari tozalanadi, `<|system|>` kabi teglar neytrallashtiriladi, 4000 belgi chegarasi. `AGENT_RULES` hech qachon mijoz matnidan olinmaydi. Injection shubhasi **faqat** jamoa uchun flag — xatti-harakatni o'zgartirmaydi (to'g'ri qaror: bloklash noto'g'ri musbatlarga olib kelardi).

**`packages/agents/src/prompt-budget.ts`** — bepul tarif muammosining real yechimi: JSON'ni ixcham yuborish, sxemadan kosmetik kalitlarni (`$schema`, `title`, `description`, `examples`) olib tashlash. `slimSchema()` ikkita tuzoqni hisobga olgan: `properties` ostidagi kalitlar — **maydon nomlari** (ularni o'chirib bo'lmaydi), `default`/`const`/`enum` ichidagi qiymatlar — **ma'lumot**. Bu nozik joylarni test orqali topib, izohda qoldirish — yuqori daraja.

**`packages/db/src/repositories/queue.ts`** — Postgres-as-queue: `FOR UPDATE SKIP LOCKED` bilan atomik claim, idempotency key, lease expiry requeue, PARKED (holat ruxsat bermasa) + har tick'da qayta baholash. `failJob()` — **D-052**: provider `retryAfterMs` bersa, backoff emas, uning **o'z deadline'ida** qayta rejalashtiriladi; 24 soatdan uzun kutish → DEAD_LETTER → CRITICAL human task → `T30 BLOCKED`. Bu bepul tarif bilan ishlashning to'g'ri modeli.

**`packages/db/src/repositories/budget.ts`** — kunlik sarf himoyasi: org/UTC-day bo'yicha **atomik worst-case rezervatsiya** (UPDATE predikat ichida qayta tekshiradi, ikki worker bir qoldiqni sarflay olmaydi), 25% margin, noma'lum narxli paid route **bloklanadi** (0 deb hisoblanmaydi). Bepul route'lar rezervatsiya qilmaydi.

**`apps/worker/src/handlers/requirements.ts`** (763 q.) — eng katta fayl. 8 bosqich: versiya+maydonlar → limitlar/hisoblagichlar → agent konfiguratsiya → turn (min-interval defer) → maydon yangilanishlarini qo'llash → veb-sayt turi → ziddiyat/vision → qayta baholash → so'rash/yakunlash/eskalatsiya. LLM bo'lmasa **halol degradatsiya** (Phase 1 echo + hodisa yozuvi), jim ishlamaydi.

**`apps/worker/src/handlers/spec.ts`** (539 q.) — generatsiya/reviziya, 1 marta chegaralangan traceability repair, muvaffaqiyatsiz nomzodni **CHANGES_REQUESTED draft** sifatida saqlash (avval bu butunlay yo'qolardi — `§57` tuzatildi), yakuniy DB yozuvi atomik, mijozga **faqat xulosa** yuboriladi (texnik spec ichki).

**`apps/worker/src/handlers/audit.ts`** (472 q.) — §21 loop: T11 → deterministik audit → model → merge → persist → PASS (lock + T12) / FAIL (T13 + SPEC_REVISE, aniq muammolar bilan) / oxirgi urinishda (T15 BLOCKED + CRITICAL task, har bir muammoni iqtibos qiladi). **Urinish broji = `spec_audits` qatorlari** (`cycle_key` bilan) — crash/replay byudjetni yo'qota olmaydi (D-038). Mijoz loop davomida **uyg'otilmaydi** (0 outbound — test bilan tasdiqlangan).

**`apps/worker/src/services/llm.ts`** — `resolveAuditorLlm()`: auditor **o'z** route'ini talab qiladi; `vendorKey()` base URL host'ini haqiqiy vendor'ga normallashtiradi (`generativelanguage.googleapis.com` → google); yozuvchi bilan bir xil vendor yoki bir xil kalit bo'lsa → **rad etadi** (`null`), yashirin fallback yo'q. Bu `SPEC §20`/`D-037` ning to'g'ri va qat'iy implementatsiyasi.

**`packages/channels/`** — Instagram webhook parse (echo/deleted tashlab yuboriladi, malformed entry crash qilmaydi), HMAC-SHA256 **constant-time** tekshirish, Graph send (1000 belgi limiti, `human_agent` tag faqat haqiqiy inson matni uchun, error 10/subcode 2534022 → `blocked`), simulator adapter (test mock emas, **birinchi darajali kanal** — Meta App Review kutilayotganda butun konveyerni ishlatish imkonini beradi; bu `risk A1` ni kritik yo'ldan ajratib qo'ygan aqlli qaror).

**`packages/testing/`** (924 q.) — scripted persona'lar: mijoz intervyusi, spec yozuvchi, auditor. 850+ qator test-double — bu kamchilik emas, **sarmoya**: butun konveyerni kalitsiz, tarmogsiz, deterministik ishga tushirish imkonini beradi.

**`config/`** — 6 ta savolnoma (GENERAL 551 qator, ECOMMERCE, RESTAURANT, EDUCATION, CORPORATE, LANDING), `defaults.json` (18 ta config qiymat — loop cheklovlari, approval prag'ı, uzbek xabar matnlari), `llm-presets.json` (8 preset: 6 bepul, 2 paid), `agents.json` (3 agent: temperature/maxOutputTokens/timeout/reasoningEffort/outputSchemaFile). **Konfiguratsiya = ma'lumot** printsipi (`§50`) izchil bajarilgan.

**`db/migrations/`** — 7 ta forward-only SQL migratsiya, 39 jadval, `schema_migrations` orqali kuzatiladi.

---

## 2. Men haqiqatan tekshirgan narsalar (verification log)

Loyihaning barcha hisobotlari "haqiqiy natijalar" deb da'vo qiladi. Men **qayta ishga tushirdim**:

| # | Tekshiruv | Buyruq | Natija |
|---|---|---|---|
| 1 | Bog'liqliklar | `npm ci --no-audit --no-fund` | ✅ 103 paket, 6 s |
| 2 | TypeScript | `npm run typecheck` | ✅ **0 xato** |
| 3 | To'liq test suite | `npm run test -- --pool=threads --maxWorkers=1 --fileParallelism=false` | ✅ **24 fayl / 214 test PASS, 269.06 s** |
| 4 | Sxema drifti | Drizzle `pgTable(...)` vs `CREATE TABLE` diff | ✅ **39/39 bir xil, farq yo'q** |
| 5 | Maxfiy kalitlar git tarixida | `git log --all --diff-filter=A --name-only` + `git grep` (barcha rev) | ✅ **toza** — faqat `.env.example` |
| 6 | Intent klassifikator xatti-harakati | maxsus zod (`classifyIntentHint`/`decideApproval`) | 🔴 **P0 bug topildi** (quyida) |
| 7 | `.env` va `uploads/` maxfiyligi | fayl formati + `.env` bilan solishtirish | 🔴 **11 ta haqiqiy Gemini kaliti** (quyida) |
| 8 | CI haqiqiy qamrovi | `.github/workflows/ci.yml` o'qish | 🔴 faqat docs check |
| 9 | Prod deployment yo'li | `createDb()`, `docker-compose.yml`, `infra/` | 🔴 Postgres drayver va Dockerfile'lar **yo'q** |

> **Muhim:** `progress.md` va `PHASE_REPORTS/phase4.md` dagi barcha sonlar (24/214, 269 s, exit 0) **to'g'ri chiqdi**. Bu loyihaning eng katta ishonch belgisi — hisobotlar bo'rttirilmagan.

---

## 3. Kuchli tomonlar (tanqidning adolatli tomoni)

1. **Halollik madaniyati.** `docs/14 §8` "What we will NOT claim" bo'limi bor va unga amal qilingan: "Live flow simulator kanali orqali bo'lgan; **Meta Graph API real send/receive isboti emas**" deb ochiq yozilgan. `PHASE_REPORTS/phase4.md` §2.4 da *eski* xato tashxis saqlanib, "bu tarixiy dalil, hozirgi sifat hukmi emas" deb belgilangan. Kamdan-kam uchraydigan yetuklik.
2. **Determinizm chegarasi to'g'ri chizilgan.** AI faqat *ifodalaydi* va *chiqaradi*; *qaror qilish* — qoidalarda. `matchedOptionStatus()` (model UNCLEAR desa ham, deklaratsiya qilingan variant tanlangan bo'lsa → CLIENT_CONFIRMED) live topilma asosida qo'shilgan va sharhda sababi yozilgan.
3. **Har bir qarorning izi.** 62 ta D-yozuv, har bir kod bloki `SPEC §N` yoki `D-0NN` ga havola qiladi. Kod o'qish = spetsifikatsiya o'qish.
4. **Xatolardan o'rganish zanjiri.** D-049 (reasoning model butun completion cap'ni "o'ylash"ga sarflab, bo'sh javob qaytardi → `reasoning:{enabled:false}`), D-052 (7 soat 45 daqiqalik quota hint'i job'ni darhol dead-letter qildi → provider deadline'ida requeue), D-053/D-061 (xato tashxis → qayta tekshiruv → haqiqiy sabab: Phase 3 leksik summary tekshiruvi). Bu **real production debugging** madaniyati.
5. **Bepul-only intizomi.** `LLM_FREE_ONLY=true` + preset-based `decideRoute()` + OpenRouter uchun majburiy `:free` slug + noma'lum narxni bloklash + kunlik atomik rezervatsiya. Pul sarflash uchun **uchta** mustaqil to'siq.
6. **Auditor mustaqilligi.** Vendor+key ajratilishi qat'iy, yashirin same-vendor fallback yo'q, rad etilsa → CRITICAL task + `T30 BLOCKED`.
7. **Sifat belgilari:** `any` — 0 ta; `TODO/FIXME/HACK` — 0 ta; `console.log` — paketlarda 0 ta; logger'da 12 ta redact path; `strict` + `noUncheckedIndexedAccess` yoqilgan.
8. **Platforma tadqiqoti.** `docs/19` Meta hujjatlarini sana bilan tekshirgan, manbalar jadvali va "noaniqlik izohlari" bilan — 24 h / 7 kun human_agent oynasi, error 10/subcode 2534022, tag deprecation (2026-04-27), token 60 kun lifecycle.

---

## 4. Tanqid va audit topilmalari

Baholar: **P0** = darhol tuzatish kerak (noto'g'ri biznes natijasi) · **P1** = P5 oldidan tuzatish kerak · **P2** = yaqin vaqtda · **P3** = sifat/gigiyena.

### 🔴 P0-1 — Mijoz rad etishi **APPROVE** deb qabul qilinadi

**Fayl:** `packages/core/src/spec/intent.ts:18-29` (`APPROVE_PATTERNS`), `:31-41` (`REQUEST_CHANGE_PATTERNS`), `:66-72` (`decideApproval`)

`SPEC §18/§19` bo'yicha mijoz tasdigi **bir marta** so'raladi va undan keyin spec **LOCKED** bo'lib, audit → `READY_FOR_BUILD` ketadi. Keyword fast-path 0.95 ishonch bilan qaytaradi va `spec.approval_confidence_threshold` (0.85) prag'ini **chetlab o'tadi**.

`REQUEST_CHANGE_PATTERNS` o'zbek **inkor shakllarini** qamramaydi (`emas`, `-mayman`, `rozimasman`, `yo'q`), `APPROVE_PATTERNS` esa **anchoring'siz substring**'lardan iborat (`/tasdiqla/i`, `/ma(’|')?qul\b/i`, `/roziman/i`).

**Men ishga tushirgan zond natijasi:**

| Mijoz matni | Haqiqiy ma'no | Tizim qarori |
|---|---|---|
| `Tasdiqlayman` | ✅ tasdiq | APPROVE 0.95 — to'g'ri |
| **`Tasdiqlamayman`** | ❌ **RAD** | 🔴 **APPROVE 0.95** (`"Tasdiqla"` substring) |
| `Ma'qul` | ✅ tasdiq | APPROVE 0.95 — to'g'ri |
| **`Ma'qul emas`** | ❌ **RAD** | 🔴 **APPROVE 0.95** (`"Ma'qul"` substring) |
| **`👍`** | ✅ tasdiq (quick reply) | 🟡 `null` → agent → UNCLEAR (xavfsiz, lekin emoji pattern'i ishlamaydi: `/👍\b/` — `\b` emoji'dan keyin chegarani topmaydi) |
| `Yo'q, o'zgartirish kerak` | ❌ rad | REQUEST_CHANGES 0.9 — to'g'ri |

**Oqibat:** mijoz "tasdiqlamayman" yoki "ma'qul emas" deb yozsa → `T10 CLIENT_APPROVED` → spec `LOCKED` → audit → `READY_FOR_BUILD`. **Mijoz rad etgan spetsifikatsiya bo'yicha qurilish boshlanadi.** Bu aynan `docs/16 D4` risk ("Client approval ambiguity — 'ok' ≠ approval") oldini olish uchun qurilgan mexanizmning o'zi buzilishi.

**Test qamrovidagi ko'r nuqta:** `tests/unit/spec-core.test.ts:183-194` ijobiy holatlar va bitta inkorni (`Menyu sahifasi kerak emas`) tekshiradi, lekin **fe'l inkorini** (`-mayman`, `emas` bilan tugagan qisqa javob) tekshirmaydi — bug aynan shu yerda.

**Tavsiya (minimal, ~30 qator):**
1. `REQUEST_CHANGE_PATTERNS` ga o'zbek inkor naqshlarini **APPROVE'dan oldin** qo'shish: `/\bemas\b/i`, `/(mayman|maymiz|masman|maydi)\b/i`, /^\s*(yo'q|yoq|no|net|не|нет)\b/i`, `/rad\s+(etaman|qilaman)/i`, `/to'g'ri emas/i`, `/xato/i`.
2. `APPROVE_PATTERNS` ni **anchoring** qilish: `/^\s*tasdiqla(yman|miz)?\b/i` (substring emas), `/^\s*ma(’|')?qul\s*$/i`.
3. **Umumiy inkor qoidasi:** matnda inkor markeri bo'lsa — hech qanday APPROVE pattern'ini qo'llamasdan `null` qaytarish (agentga yuborish). Xavfsiz tomon: noto'g'ri UNCLEAR (bitta aniqlashtiruvchi savol) noto'g'ri APPROVE'dan (butun build) arzon.
4. Regression testlar: `Tasdiqlamayman`, `Ma'qul emas`, `Rozimasman`, `Yo'q`, `👍`, `Ha, lekin narxlar kerak emas`.

---

### 🔴 P1-1 — Production deployment yo'li **butunlay mavjud emas** (lekin hujjatlar tayyordek ko'rsatadi)

**Dalillar:**
- `packages/infra/src/config.ts:37` — `DB_DRIVER: z.enum(['pglite','postgres'])` ✅ qabul qiladi
- `packages/db/src/client.ts:24-33` — `createDb()` **faqat PGlite** yaratadi; `postgres` tanlanganda `dataDir=undefined` → konteyner ichida `.pglite`
- `packages/db/src/migrate.ts:11` — `handle.pglite.exec(...)`; Postgres'da ishlamaydi
- `package.json` dependencies — **`pg` / `postgres` / `drizzle-orm/node-postgres` yo'q**
- `infra/docker-compose.yml:20,34,47,60` — `infra/Dockerfile.api|worker|coderunner|panel` ga havola
- `infra/` tarkibi — **faqat `Caddyfile` va `docker-compose.yml`**; 4 ta Dockerfile **mavjud emas**

**Oqibat:** `docker compose up` **birinchi soniyada** yiqiladi (`Dockerfile.api not found`). Agar Dockerfile bo'lganda ham, `DB_DRIVER=postgres` jim holda PGlite'ga qaytadi va worker+api **alohida konteynerlarda ikkita alohida bazaga** yozadi.

**Tanqid mohiyati:** kod yozilmagan — bu P4 uchun normal. Muammo shundaki, `docker-compose.yml` va `Caddyfile` **tayyor artefakt** sifatida repo'da turibdi va `docs/15` deployment strategiyasini tasvirlaydi, hech qanday "bu ishlamaydi" belgisisiz. `docs/16 C8` risk ("works in dev illusions") aynan shu holatni o'zi yaratib qo'ygan.

**Tavsiya:** (a) `infra/docker-compose.yml` boshiga `# STATUS: TARGET ONLY — Dockerfiles not written (Phase 7+)` qo'shish; (b) `createDb()` da `DB_DRIVER === 'postgres'` bo'lsa **throw** qilish (`'postgres driver is not implemented yet — see docs/15'`), jim holda PGlite'ga tushmaslik; (c) `README.md` "prod" bo'limini `⏳ NOT IMPLEMENTED` deb belgilash.

---

### 🔴 P1-2 — CI faqat hujjat tekshiradi; barcha haqiqiy tekshiruvlar **qo'lda**

**Fayl:** `.github/workflows/ci.yml:14-22` — yagona job `phase0-docs` → `node scripts/check-docs.mjs`.

**Ziddiyat:**
- `docs/14 §3` sarlavhasi: *"Integration tests (PGlite + **real Postgres job in CI**)"*
- `docs/16 C2` mitigatsiyasi: *"**CI runs** the integration suite against real Postgres too"*
- `ci.yml` izohi o'zi: *"From Phase 1 this workflow grows into the full `npm run verify` pipeline"* — Phase 4 tugagan, **o'smagan**
- `README.md` CI badge yo'q; `progress.md` verify natijasini **qo'lda** yozadi

**Oqibat:** 214 test va typecheck **hech qachon avtomatik ishga tushmaydi**. Regressiya faqat keyingi agent `npm run verify` ni eslab qolsa aniqlanadi. Fayl o'zi "CI skeleton. Phase 0" deb yozilgan — ya'ni Phase 0 holatida qolgan.

**Tavsiya:** `verify` job qo'shish (`npm ci` → `npm run typecheck` → `vitest --pool=forks --maxWorkers=1` → `check-docs.mjs`), Node 22 (loyiha 22 da tekshirildi), timeout 15 min, `paths-ignore: ['**.md']` emas (docs check kerak). Taxminiy ish vaqti: ~5 daqiqa.

---

### 🔴 P1-3 — `.env.example` haqiqiy konfiguratsiya bilan **keskin zidd** (onboarding tuzog'i)

**Fayllar:** `.env.example` (75 ta o'zgaruvchi) vs `packages/infra/src/config.ts:31-101` (Zod sxema) vs `scripts/init-repo.sh:8` (`cp .env.example .env` — **avtomatik!**)

**`config.ts` o'qiydigan, lekin `.env.example`'da YO'Q (11 ta) — eng muhimlari:**
`LLM_PROVIDER`, `LLM_API_KEY`, `INTERNAL_API_TOKEN`, `LLM_DAILY_BUDGET_USD`, `REQUIREMENTS_LLM_PROVIDER`, `REQUIREMENTS_LLM_MODEL`, `SPECIFICATION_LLM_MODEL`, `AGENT_MAX_REPAIRS`, `DATABASE_URL`, `ORG_NAME`, `ECHO_REPLY_TEMPLATE`

**`.env.example`'da bor, lekin hech kim o'qimaydigan (42 ta):**
`LLM_FAKE_MODE`, **`LLM_DAILY_SPEND_CAP_USD`** (haqiqiy nomi `LLM_DAILY_BUDGET_USD`!), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY_SPARE_1`, `LOOP_SPEC_AUDIT_MAX`, `LOOP_CODE_CHECK_MAX`, `LOOP_CLIENT_REVISION_MAX`, `LOOP_REQUIREMENTS_MAX_QUESTIONS`, `INACTIVITY_*`, `BUILD_*`, `CHECK_*`, `PLAYWRIGHT_BROWSERS_PATH`, `SMTP_URL`, `SENTRY_DSN`, `PANEL_*`, `BACKUP_*`, `DB_POOL_MAX`, `TZ`, …

**Oqibat (aniq):** yangi dasturchi `scripts/init-repo.sh` ni ishga tushiradi → `.env` yaratiladi → **`LLM_PROVIDER` yo'q** → `z.default('none')` → butun konveyer **AI'siz** echo rejimida ishlaydi va hech qanday xato bermaydi. `LLM_DAILY_SPEND_CAP_USD=10` yoziladi, lekin haqiqiy `LLM_DAILY_BUDGET_USD` default'ga tushadi. `LOOP_*` o'zgaruvchilari yoziladi, lekin loop cheklovlari `config_values` DB jadvalidan o'qiladi — ya'ni ular **hech narsani boshqarmaydi**.

**Tavsiya:** `.env.example` ni `config.ts` dan **generatsiya qilish** (yoki `config-validation.test.ts` ga "har bir ConfigSchema kaliti `.env.example`'da bor va aksincha" testini qo'shish — bu drift'ni doimiy ushlaydi). Phase 5/6/7 o'zgaruvchilarini `# ---- Phase 5+ (not read yet) ----` deb belgilash.

---

### 🔴 P1-4 — Agent envelope kontrakti **drift** qilgan va hech qayerda tekshirilmaydi

**Fayllar:**
- `packages/agents/src/runtime.ts:19` — `AgentErrorCode` = 9 ta kod, **`LLM_BUDGET_EXCEEDED` bor**
- `packages/agents/src/contracts.ts:11-14` — `AGENT_ERROR_CODES` = **8 ta**, `LLM_BUDGET_EXCEEDED` **yo'q**
- `docs/contracts/common-envelope.json` → `$defs/failed/properties/errorCode.enum` — **8 ta**, `LLM_BUDGET_EXCEEDED` **yo'q**
- `AgentEnvelopeSchema` — `grep` natijasi: **faqat `contracts.ts` da e'lon qilingan, hech qayerda ishlatilmaydi**

**Tanqid mohiyati:** `docs/06 §8` va `docs/14 §4` "frozen contract" tushunchasini kiritadi: JSON Schema fayllari — haqiqat manbai, Zod ularning ko'chirmasi, contract test'lar ularni solishtiradi. Amalda:
1. Kunlik byudjet himoyasi (`llm-budget.ts:38`) `LLM_BUDGET_EXCEEDED` otadi → `runtime.ts:150` uni konvertga yozadi → "frozen" kontrakt bo'yicha bu **yaroqsiz** envelope.
2. Konvertni kontraktga qarshi tekshiradigan **bitta ham test yo'q** — ya'ni drift jim holda o'sadi.

**Tavsiya:** (a) `LLM_BUDGET_EXCEEDED` ni `AGENT_ERROR_CODES` va `common-envelope.json` ga qo'shish; (b) contract test yozish: har bir `docs/contracts/*.json` `exampleValid`/`exampleInvalid` fixture'ini tegishli Zod sxema orqali o'tkazish + `enum` qiymatlarini TS union bilan solishtirish. Bu `docs/14 §4` ning *va'da qilingan* testidir.

---

### 🟠 P2-1 — `/dev/simulator/*` autentifikatsiyasiz (faqat feature flag himoya qiladi)

**Fayl:** `apps/api/src/routes/simulator.ts:25-30` — yagona himoya: `CHANNEL_SIMULATOR_ENABLED=false` bo'lsa 404. **Token tekshiruvi yo'q.**

Endpoint'lar: `POST /dev/simulator/inbound` (mijoz nomidan **ixtiyoriy xabar kiritish** → butun konveyerni harakatga keltiradi), `GET /dev/simulator/outbox` (**barcha** mijoz suhbatlarini o'qish), `GET /dev/simulator/stats`, `GET /dev/simulator/project/:id`, `GET /dev/simulator/lookup`.

Himoya zanjiri: `loadConfig()` production'da `CHANNEL_SIMULATOR_ENABLED=true` bo'lsa **throw** qiladi (`config.ts:106-113`) — bu yaxshi. Lekin `NODE_ENV=development` bilan server ishga tushirilsa (juda keng tarqalgan xato), **autentifikatsiyasiz mijoz-ma'lumotlari oqishi va xabar inyeksiyasi** ochiladi.

**Tavsiya:** `/dev/simulator/*` ga ham `X-Internal-Token` talabini qo'shish (yoki `NODE_ENV !== 'development'` bo'lsa 404). Dev console brauzerda ishlaydi, shuning uchun token'ni URL query yoki cookie orqali berish mumkin.

### 🟠 P2-2 — Autentifikatsiya hook'lari **takrorlangan** va ro'yxatdan o'tish tartibiga bog'liq

**Fayllar:** `apps/api/src/app.ts:56-61` (ro'yxat tartibi) · `routes/inspector.ts:20-26` (hook #1) · `routes/spec.ts:48-55` (hook #2 — **bir xil**)

Fastify'da root instance'ga qo'shilgan `preHandler` faqat **o'shandan keyin** ro'yxatdan o'tgan route'larga ta'sir qiladi. Hozir `/api/v1` himoyasi `inspector.ts` ichida yashiringan; `spec.ts` esa o'z nusxasini qo'shadi (ikkalasi bir vaqtda ishlaydi — zararsiz, lekin chalkash).

**Xavf:** kelajakda yangi `/api/v1/*` modul `inspector.ts` dan **oldin** ro'yxatdan o'tsa (masalan `registerPanelRoutes` `app.ts:56` ga qo'shilsa), u **jim holda autentifikatsiyasiz** qoladi. Hech qanday test buni ushlamaydi.

**Tavsiya:** bitta `registerAuthHook(app, deps)` ni `app.ts` da, **barcha route modullaridan oldin** chaqirish; yoki har bir route modulini Fastify plugin (encapsulated) qilib, `prefix` bilan ajratish. Qo'shimcha: `tests/integration/` ga "har bir `/api/v1` route token'siz 401 qaytaradi" testini qo'shish (route'larni `app.printRoutes()` dan avtomatik yig'ish mumkin).

### 🟠 P2-3 — `WATCHDOG` job turi e'lon qilingan, lekin handler'i **yo'q**

**Fayllar:** `packages/core/src/types.ts:61` (`JobType` da `WATCHDOG`) · `types.ts:90` (`JOB_POLICIES.WATCHDOG`) · `apps/worker/src/handlers/index.ts` (`HANDLERS` map)

`HANDLERS` da `BUILD_RUN`, `CODE_CHECK`, `TOKEN_REFRESH` uchun `notImplemented('Phase N')` placeholder'lari bor — lekin **`WATCHDOG` umuman yo'q**. Agar bunday job enqueue qilinsa → `NO_HANDLER` → `failAndEscalateDeadLetter` → DEAD_LETTER → CRITICAL task → **`T30 BLOCKED`**.

**Nima uchun muhim:** `docs/16 A3` risk mitigatsiyasi aynan *"Webhook watchdog (no inbound for N h while expected) + panel banner"* — ya'ni "Allow access to messages" o'chib qolganda jim qolishni oldini oluvchi yagona mexanizm. U **rejalashtirilgan, e'lon qilingan, lekin qurilmagan va hatto placeholder bilan belgilanmagan**.

**Tavsiya:** `WATCHDOG: notImplemented('Phase 7')` qo'shish (bir qator) va `docs/16 A3` da "not implemented until Phase 7" deb belgilash.

### 🟠 P2-4 — Token byudjeti evristikasi lotin/kirill matn uchun **past baholaydi**

**Fayl:** `packages/agents/src/prompt-budget.ts:26-28` — `CHARS_PER_TOKEN = 4`

`4 belgi = 1 token` — ingliz tili uchun taxmin. Loyihaning mijoz matnlari **o'zbek (lotin) va rus (kirill)**: kirill uchun odatda ~2–3 belgi/token, o'zbek maxsus belgilari (`o'`, `g'`, `‘`) uchun ham nisbat yuqoriroq. Natijada `budgetReport()` **haqiqiy token sonidan 20–40% past** ko'rsatadi va `fits:true` deb hisoblagan so'rov provider'da 429 olishi mumkin.

Bu raqam allaqachon muammo bo'lgan: `phase4-live-all-fixes.txt` da audit so'rovi 6 715 prompt token (`chars/4` bo'yicha) — haqiqati ehtimol 8–9k. Kod izohi "±20%" deydi, lekin kirill uchun xato kattaroq.

**Tavsiya:** (a) kirill/o'zbek uchun alohida koeffitsient (matn `[\u0400-\u04FF]` ulushini hisoblab, 2.8–3.2 ga o'tish); (b) provider qaytargan `usage.prompt_tokens` ni yig'ib, **o'lchangan** nisbatni qayta hisoblash (bu bepul va aniq); (c) `LLM_DUMP_DIR` allaqachon request body'ni yozadi — shundan kalibrlash mumkin.

### 🟠 P2-5 — Outbound rate limit: **fixed window**, hujjatda **token bucket**

**Fayllar:** `packages/db/src/repositories/sendRateLimit.ts:16-45` (fixed 60 s window) vs `docs/16 A5` mitigatsiyasi: *"Self-imposed 30 msg/min per connection **token bucket**"* va `docs/19 A.6`: *"Our sender caps itself well below these (30 msg/min)"*

Fixed window'da **chegara burilishida 2× burst** mumkin: 59-soniyada 30 ta + 61-soniyada 30 ta = 2 soniyada 60 xabar. Meta limiti ~100/s text uchun, shuning uchun amalda xavfli emas — lekin hujjat va kod **turli narsani** aytyapti, bu esa audit izini buzadi.

Qo'shimcha: `consumeSendRateLimit()` ichida `ex.transaction(...)` chaqiriladi (`sendRateLimit.ts:16`). Hozir `outbound.ts` uni transaction **tashqarisida** chaqiradi (shuning uchun ishlaydi), lekin agar kelajakda kimdir uni `db.transaction` ichidan chaqirsa — PGlite'da nested transaction xatosi bo'ladi. Bu cheklov kodda izohlanmagan.

**Tavsiya:** (a) `docs/16 A5` ni "fixed 60 s window (DB-durable)" ga o'zgartirish **yoki** haqiqiy token bucket qilish; (b) `sendRateLimit.ts` boshiga "MUST NOT be called inside an existing transaction" izohini qo'shish va `tests/unit/rate-limit.test.ts` ga burst-at-boundary testini qo'shish.

### 🟠 P2-6 — `LLM_QUOTA_EXHAUSTED` — o'lik kod shoxi

**Fayl:** `apps/worker/src/orchestrator.ts:149` — `error.code === 'LLM_QUOTA_EXHAUSTED' || error.code === 'LLM_RATE_LIMITED'`

`grep` natijasi: bu kod **butun repo'da bir marta** uchraydi. `LlmErrorCode` (`llm/types.ts:66-72`) va `AgentErrorCode` (`runtime.ts:19`) da `LLM_QUOTA_EXHAUSTED` **yo'q** — hech qachon otilmaydi.

**Nima uchun muhim:** bu shox daily-quota tugaganda inson uchun **maxsus tushuntirish** yozish uchun mo'ljallangan (eng kerakli holat!). Amalda quota tugasa `LLM_RATE_LIMITED` (429) yoki `LLM_BUDGET_EXCEEDED` keladi — ya'ni izoh yozilishi mumkin, lekin kod hech qachon maxsus shoxni ishlatmaydi. Bu "o'ylangan, lekin ulanmagan" qism.

**Tavsiya:** yoki `LLM_QUOTA_EXHAUSTED` ni `LlmErrorCode`'ga qo'shib, `http.ts` da 429 + `quota`/`daily` so'zlaridan aniqlash; yoki shoxni o'chirib, `LLM_BUDGET_EXCEEDED` bilan almashtirish.

### 🟠 P2-7 — `eslint-disable` izohlari bor, lekin **ESLint o'rnatilmagan**

**Fayllar:** `packages/agents/src/prompt.ts:29`, `runtime.ts:147`, `apps/api/src/index.ts:52`, `apps/worker/src/index.ts:41`, `orchestrator.ts:199`, `scripts/dev.ts:74`

Repo'da `.eslintrc*`, `eslint.config.*`, `biome.json`, `.prettierrc` **yo'q**; `package.json` da lint dependency/script **yo'q**. 6 ta faylda `eslint-disable-next-line` turibdi — ular hech narsani boshqarmaydi.

`docs/14 §7` CI pipeline'ida *"lint+boundaries"* bosqichini va'da qiladi. **"Boundaries"** ayniqsa muhim: `docs/02` qatlam qoidasi ("core hech qanday IO/framework import qilmaydi", "faqat `packages/db` SQL yozadi") hozir **faqat izohlarda** — uni avtomatik tekshiradigan hech narsa yo'q.

**Tavsiya:** (a) `eslint.config.js` + `typescript-eslint` + `import/no-restricted-paths` (core → infra/db taqiqi, agents → db taqiqi); (b) yoki oddiyroq: `scripts/check-boundaries.mjs` (har bir paket uchun ruxsat etilmagan import'larni regex bilan tekshirish) va uni `verify` ga qo'shish. Bu ~40 qator va `docs/02` ni haqiqiy qoidaga aylantiradi.

---

### 🟡 P3 — Sifat/gigiyena topilmalari

| # | Topilma | Fayl | Izoh |
|---|---|---|---|
| P3-1 | `README.md` **Phase 0 holatida qolgan** | `README.md:19-27` | "Status: Phase 0 — COMPLETE, awaiting human approval. No feature code has been written" — bu **noto'g'ri**: P1–P4 qurilgan, 19 100 qator kod bor, 214 test o'tadi. `progress.md` to'g'ri, `README.md` eskirgan. Yangi odam repo'ni ochsa, loyihani bo'sh deb o'ylaydi. |
| P3-2 | Live dalil faylida **o'z-o'ziga zid** statistika | `PHASE_REPORTS/evidence/phase4-live-all-fixes.txt` (oxiri) | `agent runs: 1 audit run(s) of 36 total` va `LLM calls: 32 total, **0 audit, 0 specification**` — ya'ni live Gemini/OpenRouter chaqiruvlari `llm_usage` jadvaliga **yozilmagan**. Bu kuzatuvchanlik teshigi: `recordLlmUsage()` chaqiriladi, lekin summary 0 ko'rsatadi (ehtimol model/provider bo'yicha guruhlash mos kelmagan). Narx/kvota hisobi aynan shu jadvalga tayanadi. |
| P3-3 | Har turn'da bir xil ogohlantirish — 30/30 marta | `evidence/phase4-live-all-fixes.txt` (boshi) | `"requirements model asked about a different field than the planner"` — 30 turn'ning **barchasida**. `plannedField` doim `modelField` dan bir qadam oldinda. Scripted persona'ning kechikishi bo'lishi mumkin, lekin bu **har doim** yonadigan ogohlantirish = signal/shovqin nisbati nolga teng; real muammoni yashiradi. Yoki persona'ni planner bilan sinxronlash, yoki log darajasini `debug` ga tushirish kerak. |
| P3-4 | `PHASE0_REVIEW.html` (286 qator HTML) repo ildizida | `PHASE0_REVIEW.html` | Markdown loyihasida bitta HTML fayl — versiyalanishi qiyin, diff o'qilmaydi. `PHASE_REPORTS/phase0.md` allaqachon bor; HTML nusxani `PHASE_REPORTS/` ga ko'chirish yoki o'chirish. |
| P3-5 | `data/projects/` artefaktlari scripted persona chiqindisi bilan to'la | `data/projects/01a11be4-…/client-summary/v2.md` | "Funksiyalar" ro'yxatida maydon **yorliqlari** turibdi: `Budjet oralig'i`, `Sayt turi`, `Loyiha maqsadi — yangilangan`, `Muddat kutilmasi`. Har bir sahifa uchun bir xil matn: *"Menyu bo'limi mijozga kerakli ma'lumotni ko'rsatadi."* Bu gitignored (to'g'ri), lekin agar kimdir `data/` ni haqiqiy natija deb ko'rsatsa — bu **scripted test double** chiqindisi, real Gemini natijasi emas. `README` yoki `data/README.md` da "bu papqa runtime artefakt, scripted simulyatsiya chiqindisi bo'lishi mumkin" deb yozish kerak. |

---

## 5. Xavfsizlik auditi

### 5.1 🔴 Repo tashqarisida — **haqiqiy API kalitlar oshkor bo'lgan**

Bu loyihaning o'zida emas, **agent workspace**ida:

| Joy | Tarkib | Holat |
|---|---|---|
| `workspace/uploads/api gemini_1..11.txt` | **11 ta haqiqiy Gemini API kaliti** (UTF-16LE, 54 belgi) — `.env` dagi qiymatlar bilan 11/11 mos | 🔴 ochiq matn |
| `ai-website-pipeline/.env` | Gemini ×11, OpenRouter ×9, Groq ×5, `TOKEN_ENCRYPTION_KEY`, `INTERNAL_API_TOKEN` | 🟡 `.gitignore` da, git tarixida **yo'q** (tekshirdim) |
| Ushbu audit suhbati | `.env` ni tahlil qilishda qism kalitlar chat log'iga chiqib ketdi | 🔴 |

**Yaxshi yangilik:** loyihaning git tarixi **toza** — 7 commit'ning hech birida `.env` yoki kalit yo'q (`git log --all --diff-filter=A` + barcha revision bo'yicha `git grep` bilan tekshirildi). Shuning uchun repo'ni GitHub'ga joylash **xavfsiz**.

**Darhol qilish kerak:**
1. **Barcha kalitlarni bekor qilish (rotate):** Google AI Studio (11 ta), OpenRouter (9 ta), Groq (5 ta) — ular chat log'i va zip arxivida ochiq qoldi.
2. `TOKEN_ENCRYPTION_KEY` ni almashtirish — bu kalit bilan shifrlangan Instagram token'larni ochish mumkin.
3. Kalitlarni endi **chatga yuklamaslik**: faqat GitHub Secrets yoki server'dagi `.env`.

### 5.2 Ijobiy xavfsizlik topilmalari

| Mexanizm | Fayl | Baho |
|---|---|---|
| HMAC-SHA256 webhook imzo, **constant-time** (`timingSafeEqual`) | `channels/src/instagram/verify.ts:16-24` | ✅ to'g'ri |
| Raw body saqlash (imzo tekshirish uchun) | `api/src/app.ts:36-45` | ✅ to'g'ri |
| Production konfiguratsiya **fail-fast** (dev- secret, simulator on, signature off → throw) | `infra/src/config.ts:106-113` | ✅ a'lo |
| Token'larni AES-256-GCM bilan shifrlash | `infra/src/crypto.ts` | ✅ (lekin unit test yo'q — P2-2 ga qarang) |
| Logger'da 12 ta redact path (authorization, token, secret, apiKey, password) | `infra/src/logger.ts:3-16` | ✅ |
| Prompt injection: delimitr + sanitize + teg neytrallashtirish + DATA bloki | `agents/src/prompt.ts:29-52` | ✅ |
| Mijoz matni → hech qachon instruction emas | `AGENT_RULES`, `prompt.ts:18-25` | ✅ |
| §10A: `CLIENT_CONFIRMED` uchun haqiqiy `sourceMessageId` shart | `core/src/requirements/apply.ts` | ✅ |
| DB CHECK constraint (client truth → source message) | `docs/16 B6` da va'da qilingan | ⚠️ tekshirish kerak (migration'da) |
| Auditor kaliti yozuvchi kalitiga teng bo'lsa → rad | `worker/src/services/llm.ts` | ✅ |

### 5.3 Xavfsizlik bo'yicha qolgan kamchiliklar

- `encryptSecret`/`decryptSecret` uchun **to'g'ridan-to'g'ri unit test yo'q** (round-trip, noto'g'ri key, tampered ciphertext, noto'g'ri format). Bu shifrlash kodi — regressiya jim holda Instagram token'larini yo'qotadi.
- `uuidv7()` uchun test yo'q (RFC 9562 version/variant bitlari, monotonlik).
- `INTERNAL_API_TOKEN` taqqoslanishi `token !== config.INTERNAL_API_TOKEN` — **constant-time emas** (`inspector.ts:23`, `spec.ts:50`). Timing attack ichki tarmoqda past risk, lekin `timingSafeEqual` bir qatorlik tuzatish.
- Session/JWT/RBAC yo'q — `X-Internal-Token` yagona darvoza. Phase 7 (Team Panel) uchun `sessions`/`team_members` jadvallari allaqachon mavjud, lekin autentifikatsiya qurilmagan. Bu rejalashtirilgan (P7), lekin `docs/10` da "hozirgi holat: bitta statik token" deb ochiq yozilishi kerak.

---

## 6. Hujjat vs reallik — drift xaritasi

| Hujjat da'vosi | Reallik | Baho |
|---|---|---|
| `docs/14 §3`: "Integration tests (PGlite + **real Postgres job in CI**)" | CI'da Postgres job yo'q; `pg` drayveri umuman yo'q | 🔴 P1-2 |
| `docs/16 C2`: "**CI runs** the integration suite against real Postgres too" | CI faqat `check-docs.mjs` | 🔴 P1-2 |
| `docs/14 §7`: CI = "lint+boundaries → unit → integration → contract → e2e → schema drift → openapi diff" | CI = 1 job, 1 step | 🔴 P1-2 |
| `docs/15`: prod = `docker compose up` (postgres, api, worker, coderunner, panel, caddy) | 4 ta Dockerfile mavjud emas; Postgres drayver yo'q | 🔴 P1-1 |
| `docs/16 A5`: "30 msg/min **token bucket**" | Fixed 60 s window | 🟠 P2-5 |
| `docs/16 A3`: "Webhook **watchdog** + panel banner" | `WATCHDOG` handler yo'q | 🟠 P2-3 |
| `docs/06 §8` / `docs/14 §4`: "frozen contract, contract tests assert fixtures" | `AgentEnvelopeSchema` hech qayerda ishlatilmaydi; enum drift | 🔴 P1-4 |
| `README.md:19`: "Phase 0 COMPLETE, **no feature code has been written**" | 19 100 qator kod, P1–P4 qurilgan, 214 test | 🟡 P3-1 |
| `progress.md`: "24 fayl / 214 test PASS" | **Men tasdiqladim: 24/214 PASS, 269 s** | ✅ to'g'ri |
| `phase4.md`: typecheck clean | **Men tasdiqladim: 0 xato** | ✅ to'g'ri |
| `phase4.md §1`: 11 ta Phase-4 vazifasi bajarilgan | Kod va testlarda tekshirdim — **barchasi mavjud** | ✅ to'g'ri |
| `docs/19` Meta topilmalari (24h oyna, error 10/2534022, tag deprecation) | `send.ts` da aniq shu kod/subcode ishlatilgan | ✅ izchil |

**Umumiy xulosa:** *faza hisobotlari va progress.md — ishonchli* (barcha sonlar qayta tekshirildi). *Drift asosan Phase 0 hujjatlarida* — ular keyingi fazalarda yangilanmagan (`docs/14`, `docs/15`, `docs/16`, `README.md`). `docs/phases/00_COMMON_RULES.md` "har faza oxirida hisobot" talab qiladi, lekin "eski hujjatlarni yangilash" talabini qo'ymagan — bu jarayon kamchiligi.

---

## 7. SPEC qamrovi matritsasi

| SPEC bo'limi | Mavzu | Holat | Isbot |
|---|---|---|---|
| §3 | 23 holatli state machine | ✅ to'liq | `types.ts` PROJECT_STATES (verbatim), 34 transition, 17 test |
| §4 | Markaziy Orkestrator | ✅ to'liq | `orchestrator.ts` tick/claim/guard/retry/dead-letter |
| §5–§9 | Requirements Agent + questionnaire + dynamic + vision | ✅ qurilgan | `handlers/requirements.ts`, `core/requirements/*`, 6 savolnoma |
| §10/§10A | Completeness engine + yagona status lug'ati | ✅ to'liq | `completeness.ts`, `apply.ts`; AI COMPLETE'ni e'tiborsiz qoldiradi |
| §11–§13 | "Bilmayman" + ma'lumot modeli + ustuvorlik | ✅ qurilgan | `DEFAULT_PROPOSED`/`resolvePriority` |
| §14–§17 | Specification Agent + texnik spec + traceability | ✅ qurilgan | `handlers/spec.ts`, `traceability.ts`, `render.ts` |
| §18–§19 | Mijoz xulosasi + **BIR** tasdiq + izchillik | ⚠️ qurilgan, **P0 bug** | ikki bosqichli approval ishlaydi; keyword inkor teshigi (P0-1) |
| §20–§21 | Spec Auditor + audit loop + ceiling | ✅ to'liq | `audit/rules.ts`, `handlers/audit.ts`, `T11–T15`, `T34` |
| §22–§26 | Coding Agent | ⬜ qurilmagan (P5) | `BUILD_RUN: notImplemented('Phase 5')` |
| §25A | Runtime verification | ⬜ qurilmagan (P6) | — |
| §27–§30 | Team Panel, dashboard, tasks, price/deadline | ⬜ qurilmagan (P7) | `apps/panel/README.md` faqat; T23–T29 guard'lari tayyor |
| §31/§31A | Instagram + Meta cheklovlari | ✅ gateway qurilgan | parse/send/verify + window guard + rate limit; **real Meta isboti yo'q** |
| §32 | Conversation state | ✅ to'liq | `conversation_state`, identity resolution |
| §33–§35 | DB + version control + change requests | ✅ qurilgan | 39 jadval, 7 migratsiya, `spec.ts` change-request API |
| §36 | AI agent run log | ✅ to'liq | `agent_runs` + `llm_usage` (lekin P3-2 gap) |
| §37–§38 | Security + prompt injection | ✅ asosiy qurilgan | crypto, redact, sanitize; session/RBAC P7'da |
| §39–§42 | Observability, error handling, idempotency, human-in-loop | ✅ to'liq | events/tasks, `ErrorClass`, idempotency key, T30/T31 |
| §43 | Team Assistant Agent | ⬜ qurilmagan (P7) | kontrakt mavjud |
| §44 | Design prompt generation | ⬜ qurilmagan (P5/P8) | — |
| §45 | Project file structure | ✅ rioya qilingan | `docs/11` bilan mos |
| §46–§47 | MVP priority + overengineering'tan saqlanish | ✅ rioya qilingan | SaaS funksiyalar yo'q; `org_id` tayyor, lekin ishlatilmagan |
| §48 | Panel UI (10 savol) | ⬜ qurilmagan (P7) | — |
| §49–§51 | AI output format + data/prompt ajratish + agent config | ✅ to'liq | Zod kontraktlar, `config/` = ma'lumot, versiyalangan agent config |
| §52–§54 | Sifat + taxminlar qoidasi + yakuniy printsip | ✅ rioya qilingan | halol hisobotlar |
| §55/§55A | Stack approval + fazali bajarish | ✅ rioya qilingan | 7 commit = 7 gate; P5 **kutilmoqda** |
| §56 | 18 ta Phase 0 deliverable | ✅ 18/18 | `docs/01…19` + `check-docs.mjs` |
| §57–§59 | Implementation rule + acceptance test + printsip | ⚠️ qisman | §58 final acceptance test P5–P7'siz bajarila olmaydi |

**Qamrov xulosasi:** SPEC'ning P0–P4 ga tegishli qismi **to'liq va sifatli** qurilgan. P5–P8 qismi reja bo'yicha qurilmagan (bu to'g'ri — gate kutilmoqda).

---

## 8. Tavsiyalar — ustuvorlik tartibida

### A. Darhol (bugun, ~2 soat)

1. **Barcha API kalitlarni rotate qilish** (Gemini 11, OpenRouter 9, Groq 5) + `TOKEN_ENCRYPTION_KEY`. (§5.1)
2. **P0-1 ni tuzatish**: inkor naqshlari + anchoring + regression testlar. Bu bitta fayl (`core/src/spec/intent.ts`) va bitta test fayli.
3. **`.env.example` ni `config.ts` bilan sinxronlash** (P1-3) + drift'ni ushlaydigan test.

### B. P5 ni boshlashdan oldin (~1 kun)

4. **CI'ni haqiqiy qilish** (P1-2): `verify` job — typecheck + 214 test + docs. Bu P5'da coding agent kod yozganda yagona avtomatik himoya.
5. **Kontrakt drift'ini yopish** (P1-4): `LLM_BUDGET_EXCEEDED` + contract test'lar.
6. **Deployment haqiqatini belgilash** (P1-1): `createDb()` throw + compose/README'ga "TARGET ONLY".
7. **`README.md` ni yangilash** (P3-1): status = P0–P4 qurilgan, P5 kutilmoqda.
8. **Lint + boundaries** (P2-7): `docs/02` qatlam qoidasini avtomatik tekshirish — P5'da yangi paketlar (`coderunner`) paydo bo'lganda hal qiluvchi.

### C. P5 davomida

9. `/dev/simulator/*` ga token (P2-1) va bitta markaziy auth hook (P2-2).
10. `WATCHDOG` placeholder (P2-3) — Meta live bo'lganda birinchi kerak bo'ladigan mexanizm.
11. Token byudjeti kalibrlash (P2-4) — o'lchangan `prompt_tokens` dan.
12. Crypto va uuidv7 unit testlari (§5.3).
13. Hujjat sinxronizatsiyasini **jarayonga** kiritish: har faza hisobotida "qaysi docs/* fayllari eskirdi" bo'limi.

### D. P5 uchun ochiq qarorlar (loyihaning o'zi so'ragan)

`progress.md §6` ikki javob so'raydi. Auditor sifatida tavsiyam:

**1. Generated-site stack: React/Next static yoki plain HTML/CSS?**

Tavsiya: **statik HTML + CSS + minimal vanilla JS** (yoki Astro kabi zero-JS generator), React/Next emas. Sabablar:
- `§25A` Code Checker **build va run** qilishi kerak. Plain HTML'da build bosqichi yo'q → checker'ning eng katta muvaffaqiyatsizlik manbai (npm install, bundler xatolari, versiya ziddiyatlari) yo'qoladi.
- Bepul-only cheklovi: LLM uchun `§58` da 8k TPM oyna bor. Next.js loyihasi ko'p fayl + konfiguratsiya talab qiladi → ko'proq LLM chaqiruvi → ko'proq 429. Bitta HTML fayl kamroq token.
- `apps/coderunner` uchun sandbox: Playwright + Chromium allaqachon kerak; Node build toolchain qo'shish C3 riskini (CPU/RAM) oshiradi.
- Ichki sayt (landing/corporate/restaurant) uchun React'ning foydasi yo'q — SEO uchun statik yaxshiroq.
- **Kompromis:** `ECOMMERCE` turi uchun keyinroq (P8) komponentli stack'ka o'tish yo'lini ochiq qoldirish — `spec.requirements` ichida `verificationHint` allaqachan bor.

**2. P5 ni boshlashga ruxsat?**

Tavsiya: **yo'q, avval A va B bloklari** (1–8-bandlar). Sabab: P5 coding agent **kod yozadi** va Code Checker uni **runtime'da tekshiradi**. Hozir:
- CI avtomatik emas (P1-2) → coding agent regressiyasi jim o'tadi;
- `createDb()` postgres'da jim holda noto'g'ri ishlaydi (P1-1) → coderunner sandbox muhiti noaniq;
- lint/boundaries yo'q (P2-7) → yangi `apps/coderunner` qatlam qoidasini buzishi mumkin;
- approval gate'da P0 bug bor (P0-1) → noto'g'ri tasdiqlangan spec bo'yicha kod yoziladi.

Bu to'rtta narsa P5 ning **kirish shartlari**. Ularni tuzatish ~1 kun, P5 esa haftalar.

---

## 9. Yakuniy baho

Bu — **o'rtacha AI-agent prototipi emas**. Bu:
- aniq spetsifikatsiya (1 899 qator, 59 bo'lim, v2 reviziya izohlari bilan),
- 62 ta hujjatlashtirilgan arxitektura qarori,
- halol, qayta-ishga-tushiriladigan faza hisobotlari (men barcha sonlarni tasdiqladim),
- 214 ta o'tadigan test, toza typecheck,
- va eng muhimi: **AI'ning vakolatini chegaralash intizomi** — model yozadi, qoida tekshiradi, inson hal qiladi.

Kamchiliklari ham shu intizomning narxi: **hujjatlar koddan tez eskiradi** (Phase 0 docs hali Phase 0 holatini tasvirlaydi), **CI qurilmagan** (barcha tekshiruv qo'lda), va **bitta hal qiluvchi joyda — mijoz tasdig'ida — deterministik qoida til nuansiga yiqiladi** (P0-1). Bu uchta narsa tuzatilishi mumkin va tuzatilishi kerak; ular loyihaning arxitekturasini shubha ostiga qo'ymaydi.

**P5 ga o'tishdan oldin 8 ta bandni bajarishni tavsiya qilaman.**

---

*Ushbu hisobot tashqi auditor tomonidan yozildi va `PHASE_REPORTS/` dagi ichki hisobotlardan mustaqil. Barcha "men tekshirdim" deb belgilangan da'volar 2026-10-10 da toza sandbox'da (Node v22.22.3, `npm ci` dan keyin) qayta ishga tushirilgan.*
