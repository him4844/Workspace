# Deliverable 9 — Instagram Integration Architecture

**Status:** Phase 0 design, **based on verified current Meta documentation** (see `19_meta_platform_findings.md` for sources and dates). Source: SPEC §31, §31A, §41.

## 1. Chosen integration path

**Instagram API with Instagram Login** (`graph.instagram.com`).

| Why | Detail |
|---|---|
| No Facebook Page required | Fewer moving parts; our account is a professional (Business/Creator) account. |
| Direct Instagram OAuth | The team connects the account once; token is the account's own. |
| It is Meta's recommended path | The legacy FB-Login/Messenger-Platform route is still supported but adds a Page dependency. |

**Permissions requested at connect time:** `instagram_business_basic`, `instagram_business_manage_messages`.
**Webhook subscriptions:** `messages`, `messaging_optins`, `messaging_postbacks`, `messaging_referrals`, `messaging_seen`, `messaging_reactions` (the last three used for intent signals only).

> If Meta rejects the Instagram-Login route for this business, the fallback is the FB-Login route (`graph.facebook.com`, permissions `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list`). The channel adapter is written against an interface so this becomes an adapter swap, not a rewrite.

## 2. Connection & token lifecycle

```
Team member (ADMIN) opens /integrations/instagram/connect
  → OUR OAuth start: https://www.instagram.com/oauth/authorize?client_id=...&redirect_uri=...&scope=instagram_business_basic,instagram_business_manage_messages&response_type=code&state=<csrf>
  → Instagram redirects to /integrations/instagram/callback?code=...
  → API exchanges code:  POST https://api.instagram.com/oauth/access_token   (short-lived, ~1h)
  → API exchanges for long-lived (60 days):
        GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=...&access_token=...
  → Store in channel_connections (encrypted): access_token_enc, token_expires_at, external_account_id, scopes
  → Subscribe webhooks for the account (App Dashboard + per-account enablement)
```

**Refresh job** (`jobs.type=TOKEN_REFRESH`, daily):
`GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...` — allowed once the token is ≥ 24 h old and before expiry; each refresh resets expiry to 60 days. If refresh fails → connection `status=NEEDS_REAUTH` → **HUMAN task** "Reconnect Instagram" + Team Panel banner. A token that expires unrefreshed cannot be refreshed (full OAuth again), which is why refresh is a daily cron with an alert to the team.

Token storage: AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` (KMS-managed in prod); never logged; redacted in `agent_runs.input_summary` (§36, §37).

## 3. Webhook ingestion

| Concern | Implementation |
|---|---|
| Endpoint | `GET/POST /webhooks/instagram` — public HTTPS, valid TLS (self-signed not accepted by Meta) |
| Verification handshake | GET returns `hub.challenge` iff `hub.mode=subscribe` and `hub.verify_token == IG_VERIFY_TOKEN` |
| Signature | Verify `X-Hub-Signature-256: sha256=<hmac>` over the **raw** request body using the app secret (HMAC-SHA256, constant-time compare). Invalid → 403 + `SECURITY_ALERT` event |
| Speed | ack 200 in < 300 ms; all processing enqueued |
| Dedupe | `webhook_events UNIQUE(channel, external_event_id)`; duplicates → 200 no-op (§41) |
| Retention | Meta provides **no historical event store**; we persist every raw payload + normalized message (§34) |
| Ordering | Handle out-of-order delivery by sorting on `entry[].time` + `message.mid` within a conversation; never assume order |
| Batches | A single POST may contain multiple `entry` items; process each independently |
| App state | App must be **Live** to receive notifications; kept Live with health checks |

**Inbound normalization** (`channels/conversation-engine`):

```
IG payload ──▶ InstagramAdapter.parse() ──▶ ConversationEvent {
  channel: 'INSTAGRAM', externalThreadId: <IGSID>, externalEventId: <mid>,
  direction: 'INBOUND', kind: 'TEXT'|'ATTACHMENT'|'QUICK_REPLY'|'POSTBACK'|'REACTION'|'SEEN',
  text?, attachments?, occurredAt, rawRef
}
```

The Conversation Engine and all agents only ever see `ConversationEvent` / normalized `messages` rows → Telegram/WhatsApp/web-chat can be added later without touching agent logic (§31).

## 4. Sending messages

| Concern | Implementation |
|---|---|
| Endpoint | `POST https://graph.instagram.com/<IG_ID>/messages` with `recipient:{id:<IGSID>}` and `message:{text}` (text ≤ 1000 chars; quick replies/buttons supported) |
| Preconditions | an inbound message exists from that user; the standard messaging window is open |
| Windows | **24 h** standard from the user's last message (every new inbound restarts it). Exception: up to **7 days** when the window was opened by the user's first message after a Click-to-Direct ad |
| Outside-window sends | `error 10 / subcode 2534022`. Our policy: the sender checks `conversations.window_expires_at` **before** calling; if closed → message `status=SEND_BLOCKED`, `MESSAGE_SEND_BLOCKED` event, **HUMAN task** "Contact client another way" (§31A design consequence). Exception: a human agent may reply up to 7 days with the `human_agent` tag (see §5) |
| Retries | safe retries only with the same client-side dedupe (store `mid` we receive back); 429/5xx → retry with backoff; 10/2534022 → never retry |
| Rate limits | our sender is capped well under Meta's ~100 msg/s (text/links) and 10/s (media) per account; platform-side limit 30 msg/min; a token-bucket per connection in the sender |
| Media | outbound attachments validated against Meta specs: image png/jpeg ≤ 8 MB; video mp4/ogg/avi/mov/webm ≤ 25 MB; audio aac/m4a/wav/mp4 ≤ 25 MB; pdf ≤ 25 MB |
| Read status | API sends do **not** mark the thread Read in the Instagram app; only the user replying does. Do not surface "read" as a guarantee |
| Replies folder | if the client's first DM is in the *Requests* folder (non-follower), our reply using the API moves the thread to General; threads inactive ≥ 30 days are no longer returned by API calls — relevant for the "client has not messaged for a long time" case |

All outbound messages are rows in `messages` *before* the send (status `QUEUED`), so every attempt and failure is auditable.

## 5. Human-agent window (price/deadline messages)

§30 requires a human to decide price/deadline and §31A(4) asks how that message can legally reach the client:

- The draft is composed by the Team Assistant (or typed by a human) and stored as `messages.draft=true`.
- If the standard window is open → the human presses **Send** in the panel.
- If the window is closed but ≤ 7 days since the client's message and the **Human Agent** feature is approved for the app → the human may send with the `human_agent` tag. Requirements: genuinely human-written content (not automation), feature approved via App Review, Business Verification complete.
- Otherwise → the panel shows an explicit fallback task: contact the client another way (the client must message first again; there is **no** re-engagement template on Instagram).

The `human_agent` tag is used only when the request is marked `humanAuthored=true` **and** a team member is the actor; the system never applies it to AI-generated text automatically.

## 6. Message types we support in MVP

| Direction | MVP | Phase 8 |
|---|---|---|
| Inbound | text, quick replies, postbacks, attachments (link/media refs) | reactions, story mentions, referrals |
| Outbound | text (≤ 1000 chars), quick replies (up to 13, ≤ 20 chars/label — used for the approval prompt), links | media (image/pdf), templates |

**Client approval interaction (§18/§19):** the Client Summary is sent as text + quick replies `[✅ Approve]` `[✏️ Request changes]`. Any free-text reply is classified by the Intent Classifier; **an approval only counts with the exact message id stored in `client_approvals`** (§10A rule).

## 7. Failure modes & handling

| Failure | Detection | Handling |
|---|---|---|
| Invalid signature | 403 path | alert + block (spoofing) |
| Duplicate webhook | unique index hit | 200 no-op |
| Window closed | pre-send check / error 10/2534022 | `SEND_BLOCKED` + human task |
| Token expired/revoked | 190-class errors, `NEEDS_REAUTH` | task "reconnect" + panel banner |
| Rate limit 429 | error code | backoff + queue |
| "Allow access to messages" turned off | sends fail 200/2534041 | panel banner "client/account disabled messaging access" |
| App switched to Dev mode | no events arriving | watchdog: no inbound for X h while app Live expected → alert |
| Message send unknown state (timeout) | no `mid` returned | mark `FAILED`, **do not** auto-resend; human task (prevents duplicates) |

## 8. Testing without Meta (mandatory for this project)

Because production messaging is gated behind App Review + Business Verification (weeks), development must not depend on it:

1. **Simulator channel** — `POST /dev/simulator/:connectionId/inbound` injects a ConversationEvent; `GET /dev/simulator/:connectionId/outbox` lists outbound. All E2E tests (Phases 1–7) run through it. `POST /dev/simulator/clock` advances time to test windows/inactivity deterministically.
2. **Signed webhook replay** — captured real Meta payloads replayed with a valid HMAC against `/webhooks/instagram` to regression-test the real parser.
3. **Standard Access smoke test** — once the Meta app exists, the team's own test IG account (role on the app) can exercise the real adapter before Advanced Access is granted.

## 9. What must be true before going live (checklist for the team — not code)

1. Instagram account switched to **Professional (Business or Creator)**.
2. **Allow access to messages** enabled (Instagram app → Settings → Messages and story replies → Message controls → Connected tools).
3. Meta app created, Instagram product added, **app in Live mode**, webhook callback configured + verified, `messages` field subscribed.
4. **Business Verification** completed (required for production access).
5. **App Review** passed for `instagram_business_manage_messages` (+ Human Agent feature if we want the 7-day window), with screencast + privacy policy URL.
6. `IG_VERIFY_TOKEN`, app secret, app id/secret, encryption key set in prod secrets.
7. Watchdog + window alerts + token refresh job running.
8. Automated-chat disclosure in the first bot message (required where applicable, esp. California/Germany) — configurable text per locale.

These items are tracked as **known risks** (`16_known_risks.md`) and **open questions** (`17_open_questions.md`) per SPEC §31A.
