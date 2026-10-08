/**
 * HTTP adapters. We deliberately use `fetch` instead of vendor SDKs: fewer dependencies,
 * no hidden retries, and the request/response shape stays visible in the audit trail.
 */
import { LlmError, type LlmClient, type LlmCompletion, type LlmRequest } from './types.js';
import { estimateCostUsd } from './pricing.js';

async function postJson(
  url: string,
  init: { headers: Record<string, string>; body: unknown; timeoutMs: number },
): Promise<{ status: number; json: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new LlmError('LLM_TIMEOUT', `request timed out after ${init.timeoutMs}ms`);
    }
    throw new LlmError('LLM_PROVIDER_ERROR', (err as Error).message, true, err);
  } finally {
    clearTimeout(timer);
  }
}

function failFromStatus(provider: string, status: number, text: string): never {
  const detail = text.slice(0, 500);
  if (status === 429) throw new LlmError('LLM_RATE_LIMITED', `${provider} rate limited: ${detail}`);
  if (status === 400 && /content policy|safety/i.test(detail)) {
    throw new LlmError('CONTENT_POLICY', `${provider} refused the content`, false, detail);
  }
  throw new LlmError('LLM_PROVIDER_ERROR', `${provider} returned ${status}: ${detail}`, status >= 500);
}

/** OpenAI-compatible chat completions (OpenAI, OpenRouter, local gateways …). */
export function createOpenAICompatibleClient(opts: {
  apiKey: string;
  baseUrl?: string;
  providerName?: string;
  organization?: string;
}): LlmClient {
  const provider = opts.providerName ?? 'openai';
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  return {
    provider,
    async complete(request: LlmRequest): Promise<LlmCompletion> {
      const { status, json, text } = await postJson(`${baseUrl}/chat/completions`, {
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          ...(opts.organization ? { 'openai-organization': opts.organization } : {}),
        },
        timeoutMs: request.timeoutMs ?? 60_000,
        body: {
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.3,
          max_tokens: request.maxOutputTokens,
          ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        },
      });
      if (status < 200 || status >= 300) failFromStatus(provider, status, text);
      const body = json as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = body?.choices?.[0]?.message?.content ?? '';
      const promptTokens = body?.usage?.prompt_tokens ?? 0;
      const completionTokens = body?.usage?.completion_tokens ?? 0;
      return {
        text: content,
        usage: {
          provider,
          model: request.model,
          promptTokens,
          completionTokens,
          costUsd: estimateCostUsd(provider, request.model, promptTokens, completionTokens),
        },
        raw: { id: (body as { id?: string } | null)?.id },
      };
    },
  };
}

/** Anthropic Messages API. */
export function createAnthropicClient(opts: { apiKey: string; baseUrl?: string }): LlmClient {
  const provider = 'anthropic';
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
  return {
    provider,
    async complete(request: LlmRequest): Promise<LlmCompletion> {
      const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const messages = request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));
      const { status, json, text } = await postJson(`${baseUrl}/messages`, {
        headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        timeoutMs: request.timeoutMs ?? 60_000,
        body: {
          model: request.model,
          system,
          messages,
          temperature: request.temperature ?? 0.3,
          max_tokens: request.maxOutputTokens ?? 1024,
        },
      });
      if (status < 200 || status >= 300) failFromStatus(provider, status, text);
      const body = json as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      } | null;
      const content = (body?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      const promptTokens = body?.usage?.input_tokens ?? 0;
      const completionTokens = body?.usage?.output_tokens ?? 0;
      return {
        text: content,
        usage: {
          provider,
          model: request.model,
          promptTokens,
          completionTokens,
          costUsd: estimateCostUsd(provider, request.model, promptTokens, completionTokens),
        },
      };
    },
  };
}
