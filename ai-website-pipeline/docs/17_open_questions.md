# Deliverable 18 — Unresolved Decisions / Open Questions

**Status:** Phase 0. Per SPEC §55A.6 and COMMON_RULES #3, nothing here is guessed at implementation time — each item gets an explicit human answer or a documented default.

Format: `Q# | question | why it matters | proposed default (if any) | needed by`.

## A. Blocking Phase 1 start

| # | Question | Why it matters | Proposed default | Needed by |
|---|---|---|---|---|
| Q1 | ~~Approve the stack?~~ **ANSWERED 2026-10-07: Option A (TypeScript monorepo) approved.** | — | — | closed |
| Q2 | **Meta path choice: Instagram Login vs Facebook Login?** — **answered "unknown": decide before the Meta app submission.** Until then both adapters share one interface; default implementation targets IG Login. | Webhook signature secret, token type, permission names differ | IG Login (`graph.instagram.com`) pending decision | before Meta submission |
| Q3 | Who owns **Business Verification + App Review** submission (legal entity, screencast, privacy policy URL)? | Platform rule; weeks of external latency (risk A1) | Assign one named person now | Phase 1 start |
| Q4 | ~~LLM provider(s)~~ **ANSWERED 2026-10-07: mixed providers via OpenRouter-capable client; Spec Auditor on a DIFFERENT provider than the Spec/Coding agent (independence)** — keys still needed. Budget cap default $10/day. | — | per-agent config rows; fake provider until keys exist | keys before live P2 |
| Q5 | Client-facing **language(s)** for messages and generated sites (uz/ru/en)? | Questionnaire phrasing, summary text, design copy | Uzbek default + Russian on request; message templates per locale | Phase 2 |
| Q6 | Hosting: local/UZ VPS vs Hetzner/EU (data-protection & latency considerations)? Domain name? | Deployment + webhook URL + backups | EU VPS from the stack proposal; panel subdomain | Phase 5 |

## B. Design-affecting (answer before the relevant phase)

| # | Question | Why it matters | Proposed default | Needed by |
|---|---|---|---|---|
| Q7 | Is the **"client"** always a person DMing us, or can an agency/company own several projects? Does a second project for the same client create a new project (we assume yes) and a new conversation thread? | Client identity model, project splitting | 1 client : N projects; new project per new stated need; new thread if > 30 days | Phase 1 |
| Q8 | **Browser verification environment** for the code checker: install Chromium in this sandbox vs run checks only on the VPS/staging? | §25A is non-negotiable; where it executes matters | Chromium via Playwright on the VPS/staging; sandbox runs static + contract tests | Phase 6 |
| Q9 | Does the team want **"Approve build" → price/deadline to be two separate human actions** (T25 then T26)? | State machine granularity (§3 names both PRICE_PENDING and DEADLINE_PENDING) | Two steps, as specified | Phase 7 |
| Q10 | **Human_agent tag usage policy**: which messages qualify (price/deadline only, or any support reply)? who may send? | Platform compliance + column in messages | Price/deadline + explicit follow-ups, LEAD role only, always `humanAuthored=true` | before launch |
| Q11 | **Manual-send record**: when a human sends a DM from the Instagram app (not our platform), do we require them to paste it back as a "manual send" note so the conversation record stays complete? | Audit completeness vs friction | Yes for price/deadline; optional otherwise | Phase 7 |

## C. Operational / policy

| # | Question | Why it matters | Proposed default | Needed by |
|---|---|---|---|---|
| Q12 | **Data retention/PII policy**: how long do we keep conversations and client data after COMPLETED? Redaction on request procedure? | §34 says keep versions; privacy says minimise | Keep project record + versions; conversations archived, not deleted; documented deletion-on-request path | Phase 7 |
| Q13 | **Roles & team size**: who is ADMIN/LEAD/MEMBER/VIEWER? Multiple concurrent projects per member? | RBAC + assignment + notifications | 1 ADMIN, 1–2 LEAD, rest MEMBER; VIEWER for sales | Phase 7 |
| Q14 | **Default questionnaire breadth**: is the 18-category general set too long for small clients? Which fields are mandatory per website type? | Client patience vs completeness | All 18 categories asked, but per-type packages define which are mandatory; some categories quickly "not applicable" | Phase 2 |
| Q15 | **Budget/deadline capture**: should the AI ask budget before presenting an estimate (and how do we avoid anchoring)? | §6 category 17 exists; §30 says human decides price | Ask as a range, mark priority slot, never auto-quote | Phase 2 |
| Q16 | **Estimated hours model**: per-requirement heuristics or pure LLM estimate? | Complexity card credibility (§30) | Hybrid: rules (page count, integrations) + LLM judgment, shown as a range | Phase 7 |
| Q17 | **Design source**: do we standardise AI designs on tokens + Google Stitch prompts only, or also generate images/illustrations? | Copy quality, copyright | Tokens + Stitch prompts; stock/placeholder assets only, no AI-generated brand imagery unless asked | Phase 5 |
| Q18 | **Website-type order after landing page** (restaurant vs corporate vs e-commerce first)? | Phase 8 roadmap; restaurant is the §58 scenario | Restaurant first (it is the acceptance scenario), then corporate, then e-commerce, then education | Phase 8 |
| Q19 | **Change-request pricing**: after approval, are scope changes billed? Does the system record price impact automatically or human-entered? | §35 workflow | AI analyses impact, human enters final price impact | Phase 8 |
| Q20 | **Notification channels**: in-panel only, or email/Telegram for urgent tasks (dead letters, BLOCKED, token expiry)? | Response times | In-panel + email for CRITICAL tasks | Phase 7 |
| Q21 | **Panel language**: interface in uz/ru/en? | Daily usability | Uzbek + Russian labels, English code/docs | Phase 7 |
| Q22 | **Repo hosting & CI**: GitHub private repo? Self-hosted CI? | Deploy pipeline, secrets | GitHub private + Actions; can switch to Gitea later | Phase 1 |

## D. Contradictions/ambiguities found in SPEC (resolved in this design, listed for transparency)

| # | Observation | Resolution taken |
|---|---|---|
| O1 | §10 and v2 revision note require approval **once**, at the Client Summary; §18's `[APPROVE]` wording implies a UI button — Instagram only supports quick replies/text | Implemented as quick replies + intent classification; approval valid only with a stored message id |
| O2 | §3 has `PRICE_PENDING` and `DEADLINE_PENDING` but §30 describes them as one human action | Kept both states (explicit), with T26/T27 split; see Q9 |
| O3 | §31A.4 asks how a price message can go outside the window; the docs allow only the `human_agent` tag (≤7 d) and only after approval | Documented as the only sanctioned path; fallback task otherwise (`08_instagram_integration.md` §5) |
| O4 | §45's folder layout vs §33's DB-first principle could conflict | Resolved: DB is truth, folders are a regenerable projection (`01_system_architecture.md` §6) |
| O5 | §27 lists "Design Swap" as a button while §24/Phase 8 defers the workflow | Button present but disabled until Phase 8; disabled state documented |
| O6 | §53 lists statuses that §10A supersedes | Only §10A vocabulary implemented; legacy words mapped (§10A rules) |

**How defaults are treated:** a proposed default is used only after you approve this document; anything unanswered by the time its phase starts will be reported as an open question in the phase's stop-report rather than silently assumed (COMMON_RULES #3).
