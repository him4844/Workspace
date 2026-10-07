/**
 * Simulator channel (docs/08 §8, DECISIONS #D-013).
 * A first-class adapter, not a test mock: it makes the whole pipeline developable
 * and testable while Meta App Review is pending. Disabled in production by config.
 *
 * "Sending" records the message as SENT with a synthetic mid; the outbox the tests
 * assert on is simply `messages where direction='OUTBOUND'`.
 */
import { randomUUID } from 'node:crypto';
import type { ChannelAdapter, OutboundMessage, SendResult } from '../events.js';

export const simulatorAdapter: ChannelAdapter = {
  channel: 'SIMULATOR',
  async send(_connectionId: string, _message: OutboundMessage): Promise<SendResult> {
    return { ok: true, channelMessageId: `sim_${randomUUID()}` };
  },
};

/** Build an Instagram-shaped webhook payload for a simulated client message (used by tests + the simulator API). */
export function buildSimulatorPayload(params: {
  accountId: string;
  senderId: string;
  username?: string;
  text: string;
  mid?: string;
  at?: Date;
}): { object: string; entry: unknown[] } {
  const timestamp = Math.floor((params.at ?? new Date()).getTime() / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: params.accountId,
        time: timestamp,
        messaging: [
          {
            sender: { id: params.senderId, ...(params.username ? { username: params.username } : {}) },
            recipient: { id: params.accountId },
            timestamp,
            message: { mid: params.mid ?? `sim_mid_${randomUUID()}`, text: params.text },
          },
        ],
      },
    ],
  };
}
