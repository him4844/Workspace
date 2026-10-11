/**
 * Sending Instagram DMs (SPEC §31A, docs/08 §4).
 * POST https://graph.instagram.com/<IG_ID>/messages  with recipient + message.
 * Errors are classified so the caller can decide: retry, block, or escalate to a human.
 */
import type { OutboundMessage, SendResult } from '../events.js';

export interface InstagramSendConfig {
  baseUrl: string;              // https://graph.instagram.com (overridable for tests)
  accessToken: string | null;   // decrypted long-lived Instagram user token
  accountId: string | null;     // IG professional account id (or 'me')
  humanAgentTagEnabled: boolean;
  fetchImpl?: typeof fetch;
}

export async function sendInstagramMessage(
  cfg: InstagramSendConfig,
  to: { recipientExternalId: string },
  message: OutboundMessage,
  opts: { useHumanAgentTag?: boolean } = {},
): Promise<SendResult> {
  if (!cfg.accessToken) {
    return { ok: false, errorCode: 'NO_TOKEN', errorDetail: 'Instagram connection has no access token', blocked: true };
  }
  if (message.text.length > 1000) {
    return { ok: false, errorCode: 'TEXT_TOO_LONG', errorDetail: 'Instagram text limit is 1000 characters', blocked: true };
  }

  const target = cfg.accountId ?? 'me';
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/${target}/messages`;
  const body: Record<string, unknown> = {
    recipient: { id: to.recipientExternalId },
    message: { text: message.text },
  };
  if (message.quickReplies && message.quickReplies.length > 0) {
    (body.message as Record<string, unknown>).quick_replies = message.quickReplies
      .slice(0, 13)
      .map((title) => ({ content_type: 'text', title: title.slice(0, 20), payload: title }));
  }
  // §31A(4): the human_agent tag is only valid for genuinely human-authored messages
  // and only when the feature is approved for the app.
  if (opts.useHumanAgentTag && message.humanAuthored && cfg.humanAgentTagEnabled) {
    body.tag = 'HUMAN_AGENT';
  }

  const doFetch = cfg.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* non-JSON error body */ }

    if (!res.ok) {
      const error = (json.error ?? {}) as Record<string, unknown>;
      const code = String(error.code ?? res.status);
      const subcode = error.error_subcode != null ? String(error.error_subcode) : '';
      const detail = String(error.message ?? text ?? `HTTP ${res.status}`);
      // Outside the 24h window (Meta error 10 / subcode 2534022) — never retry, escalate.
      const blocked = code === '10' || subcode === '2534022' || code === '190';
      return {
        ok: false,
        errorCode: subcode ? `${code}/${subcode}` : code,
        errorDetail: detail,
        blocked,
      };
    }
    return { ok: true, channelMessageId: (json.message_id as string) ?? null };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'NETWORK',
      errorDetail: err instanceof Error ? err.message : String(err),
      blocked: false,
    };
  }
}
