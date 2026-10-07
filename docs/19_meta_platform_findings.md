# Deliverable 19 — Meta / Instagram Platform Findings (Section 31A verification)

**Verified on:** 2026-10-07 against Meta's official developer documentation (pages updated 2026-09-16 / 2026-09-28) plus corroborating sources. **These findings must be re-verified before Phase 1 implementation and before launch** — Meta changes platform rules with short notice.

## A. The 8 questions SPEC §31A requires us to answer

| # | Question | Finding |
|---|---|---|
| 1 | Which Instagram account type / linkage is required? | An **Instagram professional account (Business or Creator)** — personal accounts have no messaging API. With **Instagram API with Instagram Login** no Facebook Page is required (the account is addressed on `graph.instagram.com`). With the legacy Facebook-Login route the account must be linked to a Facebook Page. |
| 2 | Which permissions, and is App Review / Business Verification needed? | Permissions: `instagram_business_basic` + `instagram_business_manage_messages` (Instagram-Login route). **Advanced Access** (App Review + **Business Verification**) is required for production access; Standard Access only serves accounts/users with a role on the app. Meta's webhook setup page states Advanced Access + Business Verification for production. |
| 3 | Messaging window rules and human-follow-up exceptions | Standard window: **24 hours** from the person's last message; every new inbound message restarts it. Exception: up to **7 days** when the window is opened by the person's *first message after clicking a Click-to-Direct ad*. For human agents there is a separate **7-day Human Agent window** via the `human_agent` tag. |
| 4 | Can a human send price/deadline outside the standard window? | Yes, only via the **`human_agent` tag** (≤ 7 days from the person's message), and only for genuinely human-authored support replies; the Human Agent feature must be approved through App Review and requires Business Verification. Outside 7 days there is **no** sanctioned path (no re-engagement templates on Instagram) — the person must message first. |
| 5 | Webhook setup and signature verification | Callback endpoint must be HTTPS with a valid CA certificate (no self-signed). Verification: GET with `hub.mode=subscribe`, `hub.verify_token`, echo `hub.challenge`. Events: POST with JSON body and `X-Hub-Signature-256` (HMAC-SHA256 with the app secret) that the endpoint **must validate**. Notifications are delivered at-least-once: **dedupe required**. Meta stores **no history** of notifications — persist what you need. App must be **Live** to receive notifications. mTLS is offered as an option. |
| 6 | Rate limits | Per Instagram professional account: ~**100 calls/s** for messages containing text/links/reactions/stickers; ~**10/s** for audio/video; ~**750/h** private replies to comments; 100/s private replies to Live comments. A shared 200/h Business-Use-Case limit applies to other Instagram Platform calls. Our sender caps itself well below these (30 msg/min platform-side). |
| 7 | Supported message types & limits | Text (≤ 1000 chars), links, quick replies, buttons, templates, reactions, stickers, images (png/jpeg ≤ 8 MB), video (mp4/ogg/avi/mov/webm ≤ 25 MB), audio (aac/m4a/wav/mp4 ≤ 25 MB), pdf (≤ 25 MB), and the app user's own posts. **No group messaging** (one customer per conversation). |
| 8 | What happens with a long-silent client? | Sends after 24 h fail (**error 10, subcode 2534022**). Without the human_agent tag there is no compliant way to re-open the conversation — the client must message again. Threads in the *Requests* folder (non-followers) that are inactive for **30 days** stop being returned by API calls. |

## B. Additional platform facts that shape the design

1. **Conversations start only from the user.** Cold outreach is impossible, not merely rate-limited.
2. **"Allow access to messages" toggle** (Instagram app → Message controls → Connected tools) must be ON; when off, webhooks silently never arrive (and sends later fail with 200/2534041). This is the most common "it worked in testing" failure.
3. **Message tags:** Message tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` are **not available** for Instagram (deprecated 2026-04-27, return error 100). `HUMAN_AGENT` is the only tag documented for Instagram.
4. **Read receipts:** API-sent messages are not marked Read in the Instagram app; a message becomes Read only after the user replies.
5. **Inbox folders:** new conversations from non-followers land in *Requests*; a reply using the API moves the conversation to *General* regardless of inbox settings.
6. **App Publishing:** webhooks require the app to be **Live**, regardless of App Review status.
7. **Tester roles:** app testers need a role on the app, all required permissions granted, and a role on the Instagram professional account that owns the app.
8. **Automated-experience disclosure:** where legally required (special attention: California, Germany) automated chat must disclose it is automated — at the start, after significant lapses, and on human→bot transitions.
9. **Token lifecycle (Instagram-Login route):** short-lived token ~1 h → long-lived **60 days** → refresh via `refresh_access_token` (token must be ≥ 24 h old and not expired; each refresh resets to 60 days). Miss the window and the account must re-authorize.
10. **No historical webhook data** and **no field-level subscription per account** (an account gets every field subscribed for the app).

## C. Consequences already baked into the design

1. `Conversation Engine` is channel-independent; Instagram is one adapter (`08_instagram_integration.md` §3).
2. `conversations.last_client_message_at` + `window_expires_at` are stored; the Team Panel **warns before sending** and the sender blocks outside-window sends → `SEND_BLOCKED` + human fallback task (§31A design consequences).
3. The `human_agent` path is a human-only action with `humanAuthored=true`, never auto-applied to AI text.
4. The **simulator channel** makes Phases 1–7 developable and testable while Meta review is pending (critical path decoupling).
5. Token refresh is a daily job with alerting; connection status visible in the panel.
6. Questionnaire/approval flows use short messages, one question at a time, quick replies where useful.
7. Onboarding checklist for the team incl. Business Verification and App Review (`08_instagram_integration.md` §9).

## D. Sources

| Source | Type | Date |
|---|---|---|
| developers.facebook.com/documentation/instagram-platform/webhooks (+ /setup) | Official | updated 2026-09-16 |
| developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api | Official | updated 2026-09-28 |
| developers.facebook.com/documentation/instagram-platform/ (platform overview) | Official | 2026 |
| conferbot.com/limits/instagram — "Every Instagram Messaging API limit, in one table" | Third-party (corroborating) | 2026-08-20 |
| postmcpai.com/instagram-messaging-api — windows, rate limits, setup | Third-party (corroborating) | 2026-09-06 |
| creatorflow.so — DM compliance & tag deprecations (Apr 27, 2026) | Third-party (corroborating) | 2026-08-20 |
| singhamandeep.com — `instagram_business_manage_messages` approval guide | Third-party (corroborating) | 2026-07-05 |
| upload-post.com/instagram-api — token lifecycle & refresh | Third-party (corroborating) | 2026-09-28 |
| developers.chatwoot.com/self-hosted/instagram-app-review — reference App Review submission | Third-party (corroborating) | 2026 |

**Uncertainty notes:** rate-limit numbers and the exact behavior of the 7-day Click-to-Direct window are from official docs but Meta does not version these pages; re-verify at Phase 1 and again before launch. The webhook signature secret differs by route (Facebook app secret vs Instagram app secret) — confirm for the chosen setup during Phase 1.
