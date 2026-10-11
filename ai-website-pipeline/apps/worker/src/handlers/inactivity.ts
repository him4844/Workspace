/**
 * INACTIVITY_CHECK (SPEC §10 configurable "inactivity reminder").
 *
 * Scheduled a configurable number of hours after our question. If the client is still
 * silent: send ONE reminder (up to `requirements.inactivity_max_reminders`), then open a
 * human task. Never sends anything outside the messaging window — that path already
 * escalates through the outbound service (§31A).
 */
import type { JobRow } from '@wpp/db';
import { identityRepo, obsRepo, orgRepo, projectsRepo } from '@wpp/db';
import { WppError } from '@wpp/core';
import type { HandlerContext } from '../orchestrator.js';
import { sendOutboundMessage } from '../services/outbound.js';

const SCOPE = 'requirements';
const KEY = 'inactivity_reminders';

const REMINDER_TEXT =
  "Salom! Savolimiz javobsiz qoldi 🙂 Loyihangizni davom ettirish uchun bir-ikki daqiqa ajratib, qisqa javob yozsangiz bo'ladi.";

export async function inactivityCheck(ctx: HandlerContext, job: JobRow): Promise<void> {
  const payload = job.payload as { conversationId?: string };
  if (!job.projectId || !payload.conversationId) {
    throw new WppError('INVALID_JOB_PAYLOAD', 'INACTIVITY_CHECK requires projectId and conversationId', 'VALIDATION');
  }
  const { db, logger } = ctx;
  const projectId = job.projectId;
  const conversationId = payload.conversationId;

  const project = await projectsRepo.getProject(db, projectId);
  if (!project) return;
  // Reminders only make sense while we are actually interviewing the client.
  if (project.state !== 'INTAKE' && project.state !== 'REQUIREMENTS_IN_PROGRESS') return;

  const hours = (await orgRepo.getConfigValue<number>(db, 'requirements.inactivity_reminder_hours')) ?? 24;
  const maxReminders = (await orgRepo.getConfigValue<number>(db, 'requirements.inactivity_max_reminders')) ?? 2;

  const messages = await identityRepo.listRecentMessages(db, conversationId, 100);
  const last = messages.at(-1);
  if (!last) return;
  const silentMs = Date.now() - new Date(last.createdAt ?? Date.now()).getTime();
  if (last.direction === 'INBOUND') return; // the client answered; the turn handler owns the flow
  if (silentMs < hours * 3600 * 1000) return;

  const reminders = await projectsRepo.getLoopCounter(db, projectId, SCOPE, KEY);
  if (reminders >= maxReminders) {
    await obsRepo.createTask(db, {
      orgId: project.orgId,
      projectId,
      type: 'CLIENT_SILENT',
      priority: 'MAJOR',
      title: 'Client went silent during requirements',
      reason: `No reply for ${Math.round(silentMs / 3600000)}h after ${reminders} reminder(s)`,
      suggestedAction: 'Try another channel or pause the project; the messaging window may also be closing.',
      aiReport: { reminders, conversationId },
    });
    return;
  }

  const { message } = await identityRepo.insertMessage(db, {
    conversationId,
    projectId,
    direction: 'OUTBOUND',
    status: 'QUEUED',
    text: REMINDER_TEXT,
  });
  const outcome = await sendOutboundMessage(ctx, message.id);
  await projectsRepo.incrementLoopCounter(db, projectId, SCOPE, KEY);
  logger.info({ projectId, outcome: outcome.status, reminders: reminders + 1 }, 'inactivity reminder processed');
}
