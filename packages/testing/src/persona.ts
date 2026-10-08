/**
 * Scripted Requirements-Agent clients for tests, local demos and CI (docs/14 §3).
 *
 * A "persona" answers the pending question and asks the next one exactly like a cooperative
 * client would, so the full pipeline (planner → prompt → contract validation → persistence →
 * completeness) runs for real without a provider key. Only the network call is replaced.
 */
import { createScriptedLlm, requirementsTurn, type ScriptedLlm } from './scripted-llm.js';
import type { LlmRequest } from '@wpp/agents';


export type { ScriptedLlm };

export interface PromptView {
  task: string;
  projectData: {
    projectId: string;
    projectType: string;
    pendingQuestion?: { fieldPath: string; text: string } | null;
    requirementFields: Array<{ fieldPath: string; status: string; mandatory: boolean; value: unknown; category: string }>;
    openContradictions: Array<{ fieldA: string; fieldB: string; description?: string; status: string }>;
    interview: { questionsAsked: number; maxQuestions: number; clarificationsByField: Record<string, number> };
  };
  clientBlock: string;
  raw: string;
}

/** Parse the assembled prompt the way a debugging human would (the blocks are labelled). */
export function readPrompt(request: LlmRequest): PromptView {
  const user = request.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
  const task = between(user, '[3] TASK SPECIFICATION\n', '\n\n[4] PROJECT DATA') ?? '';
  const dataRaw = between(user, '[4] PROJECT DATA\n', '\n\n[5] CLIENT CONTENT') ?? '{}';
  const clientBlock = between(user, '<<<CLIENT_CONTENT>>>\n', '\n<<<END_CLIENT_CONTENT>>>') ?? '';
  return { task, projectData: JSON.parse(dataRaw) as PromptView['projectData'], clientBlock, raw: user };
}

function between(text: string, start: string, end: string): string | null {
  const from = text.indexOf(start);
  if (from < 0) return null;
  const to = text.indexOf(end, from + start.length);
  return text.slice(from + start.length, to < 0 ? undefined : to);
}

export function targetField(task: string): string | null {
  return /TARGET FIELD: ([^\s(]+)/.exec(task)?.[1] ?? null;
}

export function isFinalTurn(task: string): boolean {
  return task.includes('FINAL turn');
}

export const SUMMARY_MD = [
  '# Ichki xulosa — Osh Baraka',
  '',
  '## Biznes',
  '- O‘zbek/turk oshxonasi restorani, 2 filial, Toshkent.',
  '- Maqsad: menyu, filiallar va stol bron qilish.',
  '',
  '## Sahifalar va funksiyalar',
  '- 5 sahifa: bosh, menyu, biz haqimizda, filiallar, aloqa.',
  '- Stol bron qilish (telefon orqali tasdiqlanadi), xarita, Instagram/Telegram.',
  '',
  '## Dizayn va kontent',
  '- Yorug‘ va minimal uslub, oq fon + to‘q sariq.',
  '- Ikki til: o‘zbek va rus; matnlar mijozdan.',
  '',
  '## AI taxminlari (tasdiqlanmagan)',
  '- Menyu rasmlari professional suratga olinishi kerak.',
  '',
  '## Ochiq savollar',
  '- Yetkazib berish kelajakda qo‘shilishi mumkin.',
].join('\n');

/** Values a cooperative restaurant client would give (keyed by questionnaire field path). */
export const RESTAURANT_PERSONA: Record<string, unknown> = {
  'business_purpose.purpose': 'Mijozlar restoranimizni topib, menyuni ko‘rib, stol bron qilishi uchun',
  'business_purpose.company_name': 'Osh Baraka',
  'target_audience.primary': 'Toshkentdagi 25-45 yoshli oilalar va ofis xodimlari',
  'target_audience.languages': ['O‘zbek', 'Rus'],
  'website_type.type': 'RESTAURANT',
  'pages.list': ['Bosh sahifa', 'Menyu', 'Biz haqimizda', 'Filiallar', 'Aloqa'],
  'features.core': ['stol bron qilish', 'menyu ko‘rish', 'xarita va manzil'],
  'authentication.needed': 'no',
  'payments.needed': 'no',
  'products_services.description': 'O‘zbek va turk oshxonasi: palov, kabob, shashlik, somsa, ichimliklar',
  'products_services.count': '50+ ta taom',
  'admin_panel.needed': 'yes',
  'admin_panel.roles': ['admin', 'kontent muharriri'],
  'design.style': 'Yorug‘ va minimal: oq fon, to‘q sariq urg‘u, menyu rasmlari katta',
  'design.logo_assets': 'Bor',
  'content.languages': ['O‘zbek', 'Rus'],
  'content.texts_ready': 'client',
  'seo.needed': 'yes',
  'seo.keywords': ['palov yetkazib berish', 'Toshkent restoran', 'milliy taomlar'],
  'integrations.list': ['Instagram', 'Google Maps', 'Telegram'],
  'integrations.google_analytics': 'GA4',
  'security.requirements': 'Standart: HTTPS, mijoz ma’lumotlari shifrlangan holda saqlanadi',
  'hosting.preference': 'team',
  'domain.name': 'oshbaraka.uz (bizda bor)',
  'budget.range': 'mid',
  'deadline.expected': '1 oy ichida, sentabr kampaniyasiga ulgurish kerak',
  'deadline.hard_date': '2026-09-01 reklama starti',
  'menu.kind': 'Rasm bilan, narxlar bilan',
  'menu.categories_count': '6-10 bo‘lim',
  'reservations.enabled': 'yes',
  'reservations.confirmation': 'Telefon orqali tasdiqlanadi',
  'delivery.enabled': 'own',
  'delivery.zone': 'Toshkent shahri, Yakkasaroy va Yunusobod',
  'branches.count': '2 ta filial',
  'branches.hours': 'Har kuni 10:00–23:00',
  'online_ordering.enabled': 'phone',
  'location.map': 'google',
};

const VAGUE_ANSWER = 'zamonaviy va chiroyli bo‘lsin';

export interface PersonaOptions {
  /** answer these fields vaguely first, then concretely (§8A) */
  vagueFirst?: Set<string>;
  /** make two answers conflict and check that the pipeline clarifies (§8B) */
  contradiction?: { fieldA: string; fieldB: string; description: string; conflictingValue?: unknown };
  /** answers that override or extend the persona */
  answers?: Record<string, unknown>;
  /** internal summary returned on the final turn */
  summary?: string;
  /** return this prose instead of JSON on call #N (repair-loop test) */
  malformedCall?: number;
  /**
   * Interactive demo mode: take the value of the pending field from the client's own last
   * message instead of the canned persona answer, so a human typing in the dev console sees
   * their words recorded. Tests keep the deterministic default (false).
   */
  useClientAnswer?: boolean;
}

/**
 * A scripted LLM that plays a cooperative client: it answers the pending question and asks
 * the next one the task block demands — the same contract the real model has.
 */
export function createPersonaLlm(
  persona: Record<string, unknown> = RESTAURANT_PERSONA,
  options: PersonaOptions = {},
): ScriptedLlm {
  const answers = { ...persona, ...(options.answers ?? {}) };
  const vagueAsked = new Set<string>();
  let callIndex = 0;
  let contradictionRaised = false;

  return createScriptedLlm((request) => {
    callIndex += 1;
    const view = readPrompt(request);
    const target = targetField(view.task);
    const pending = view.projectData.pendingQuestion?.fieldPath ?? null;
    const source = lastClientMessageId(view);

    if (options.malformedCall && callIndex === options.malformedCall) {
      return 'Sure! Here is a short prose answer instead of JSON.';
    }

    if (isFinalTurn(view.task)) {
      const confirmed = view.projectData.requirementFields.filter((f) => f.status === 'CLIENT_CONFIRMED');
      const inferred = view.projectData.requirementFields.filter((f) => f.status === 'AI_INFERRED');
      const empty = view.projectData.requirementFields.filter((f) => f.status === 'EMPTY');
      return requirementsTurn({
        turnType: 'COMPLETE',
        acknowledgment: 'Rahmat, hammasi aniq!',
        fieldUpdates: [],
        contradictions: [],
        vision: {
          clientConfirmed: confirmed.map((f) => f.fieldPath),
          aiInferred: inferred.map((f) => f.fieldPath),
          notSpecified: empty.map((f) => f.fieldPath),
        },
        internalSummaryMd: options.summary ?? SUMMARY_MD,
      });
    }

    const fieldUpdates: Array<Record<string, unknown>> = [];
    const contradiction = options.contradiction;

    if (pending && contradiction && contradiction.fieldA === pending && !contradictionRaised) {
      // The client's new answer conflicts with what they said before: record both values and
      // let the pipeline schedule the clarification question (§8B).
      contradictionRaised = true;
      fieldUpdates.push({
        fieldPath: pending,
        value: answers[pending] ?? 'juda minimal dizayn',
        status: 'CLIENT_CONFIRMED',
        sourceMessageId: source,
      });
      fieldUpdates.push({
        fieldPath: contradiction.fieldB,
        value: contradiction.conflictingValue ?? ['ko‘p animatsiyalar va vizual effektlar'],
        status: 'CLIENT_CONFIRMED',
        sourceMessageId: source,
      });
      return requirementsTurn({
        turnType: 'ACKNOWLEDGE_AND_ASK',
        acknowledgment: 'Tushundim!',
        question: {
          fieldPath: contradiction.fieldB,
          text: `${contradiction.fieldB}: bir joyda “minimal”, boshqa joyda “animatsiya ko‘p” dedingiz — qaysi biri asosiy bo‘lsin?`,
          quickReplies: ['Minimal qolsin', 'Animatsiya ko‘p', 'O‘rtacha'],
        },
        fieldUpdates,
        contradictions: [{ ...contradiction, severity: 'MAJOR', status: 'OPEN' }],
        vision: { clientConfirmed: [], aiInferred: [], notSpecified: [] },
      });
    }

    if (pending && contradiction && contradictionRaised && contradiction.fieldB === pending) {
      // Answering the clarification resolves the contradiction and the interview continues.
      fieldUpdates.push({
        fieldPath: pending,
        value: ['yorug‘ minimal dizayn', 'oz miqdorda animatsiya'],
        status: 'CLIENT_CONFIRMED',
        sourceMessageId: source,
      });
      return requirementsTurn({
        turnType: 'ACKNOWLEDGE_AND_ASK',
        acknowledgment: 'Tushunarli — minimal dizayn, animatsiya kam bo‘ladi.',
        question: target ? { fieldPath: target, text: canonicalQuestion(target), quickReplies: ['Ha', 'Yo‘q'] } : undefined,
        fieldUpdates,
        contradictions: [{ ...contradiction, severity: 'MAJOR', status: 'RESOLVED' }],
        vision: { clientConfirmed: [], aiInferred: [], notSpecified: [] },
      });
    }

    if (pending) {
      const typed = options.useClientAnswer ? lastClientText(view) : null;
      const answer = typed !== null && typed !== undefined
        ? stripFieldPrefix(typed, pending)
        : answers[pending];
      if (answer !== undefined) {
        const stillVague = options.vagueFirst?.has(pending) && !vagueAsked.has(pending);
        if (stillVague) {
          vagueAsked.add(pending);
          fieldUpdates.push({
            fieldPath: pending,
            value: VAGUE_ANSWER,
            status: 'UNCLEAR',
            sourceMessageId: source,
            note: 'vague answer (§8A)',
          });
        } else {
          fieldUpdates.push({
            fieldPath: pending,
            value: answer,
            status: 'CLIENT_CONFIRMED',
            sourceMessageId: source,
            priority: 'MUST',
          });
        }
      }
    }

    if (!target) {
      return requirementsTurn({
        turnType: 'COMPLETE',
        fieldUpdates,
        contradictions: [],
        vision: { clientConfirmed: [], aiInferred: [], notSpecified: [] },
        internalSummaryMd: options.summary ?? SUMMARY_MD,
      });
    }

    const nextAnswer = answers[target];
    // Instagram quick replies are limited to 20 characters by the contract — a real model
    // must respect that, and so does the test persona.
    const quickReplies = Array.isArray(nextAnswer)
      ? nextAnswer.slice(0, 3).map((v) => String(v).slice(0, 20))
      : ['Ha', 'Yo‘q', 'Boshqacha'];

    return requirementsTurn({
      turnType: 'ACKNOWLEDGE_AND_ASK',
      acknowledgment: pending ? 'Yozib oldim.' : null,
      question: { fieldPath: target, text: canonicalQuestion(target), quickReplies, why: 'next required field' },
      fieldUpdates,
      contradictions: [],
      vision: { clientConfirmed: [], aiInferred: [], notSpecified: [] },
    });
  });
}

/**
 * Demo/test question wording. The real model writes its own text (the contract only fixes the
 * shape); this map exists so the scripted client asks questions a human can read in the console.
 */
export const QUESTION_TEXT: Record<string, string> = {
  'business_purpose.purpose': 'Sayt ochishdan asosiy maqsadingiz nima — mijozlar nima qilishini xohlaysiz?',
  'business_purpose.company_name': 'Kompaniya yoki brend nomi qanday bo‘ladi?',
  'target_audience.primary': 'Asosiy mijozlaringiz kimlar? (yosh, shahar, kim uchun)',
  'target_audience.languages': 'Sayt qaysi tillarda bo‘lsin?',
  'website_type.type': 'Bu qanday turdagi sayt bo‘ladi? (masalan: restoran, korporativ, do‘kon)',
  'pages.list': 'Qaysi sahifalar kerak? Ro‘yxat qilib bering.',
  'features.core': 'Saytda qanday asosiy funksiyalar bo‘lishi kerak?',
  'authentication.needed': 'Foydalanuvchi ro‘yxatdan o‘tish / kirish kerakmi?',
  'payments.needed': 'Saytda to‘lov qilish kerakmi?',
  'products_services.description': 'Nima sotiladi yoki qanday xizmat ko‘rsatiladi?',
  'products_services.count': 'Taxminan nechta mahsulot/xizmat bo‘ladi?',
  'admin_panel.needed': 'Kontentni o‘zingiz tahrirlaydigan admin panel kerakmi?',
  'admin_panel.roles': 'Admin panelda qanday rollar bo‘lsin?',
  'design.style': 'Dizayn uslubi qanday bo‘lsin? Ranglar, kayfiyat, misollar.',
  'design.logo_assets': 'Logo va brend materiallari bormi?',
  'content.languages': 'Kontent qaysi tillarda tayyorlanadi?',
  'content.texts_ready': 'Matnlarni kim tayyorlaydi — siz berasizmi yoki biz yozamizmi?',
  'seo.needed': 'Qidiruv tizimlari uchun SEO sozlash kerakmi?',
  'seo.keywords': 'Qaysi so‘zlar bo‘yicha topilishni xohlaysiz?',
  'integrations.list': 'Qanday tashqi tizimlar bilan bog‘lanish kerak? (Instagram, xarita, CRM…)',
  'integrations.google_analytics': 'Statistika uchun Google Analytics kerakmi?',
  'security.requirements': 'Xavfsizlik bo‘yicha alohida talablaringiz bormi?',
  'hosting.preference': 'Hosting va domen bo‘yicha tanlovingiz bormi?',
  'domain.name': 'Domen nomi bormi yoki tanlash kerakmi?',
  'budget.range': 'Budjet oralig‘i qanday? (past / o‘rta / yuqori)',
  'deadline.expected': 'Qachonga tayyor bo‘lishi kerak?',
  'deadline.hard_date': 'Qat’iy muddat yoki sana bormi?',
  'menu.kind': 'Menyu qanday ko‘rsatilsin — rasmlar va narxlar bilanmi?',
  'menu.categories_count': 'Menyu nechta bo‘limdan iborat bo‘ladi?',
  'reservations.enabled': 'Stol bron qilish funksiyasi kerakmi?',
  'reservations.confirmation': 'Bron qanday tasdiqlanadi — telefonmi, avtomatikmi?',
  'delivery.enabled': 'Yetkazib berish xizmati bormi?',
  'delivery.zone': 'Yetkazib berish hududi qayerlarni qamrab oladi?',
  'branches.count': 'Nechta filialingiz bor?',
  'branches.hours': 'Ish vaqti qanday?',
  'online_ordering.enabled': 'Onlayn buyurtma qabul qilinadimi?',
  'location.map': 'Xaritada joylashuvni ko‘rsatish kerakmi?',
};

/**
 * The exact question text the scripted client uses for a field. Tests use it to find "the
 * question about design.style" without depending on the wording of a real model.
 */
export function questionTextFor(fieldPath: string): string {
  return canonicalQuestion(fieldPath);
}

function canonicalQuestion(target: string): string {
  return QUESTION_TEXT[target] ?? `${target.split('.').pop()!.replace(/_/g, ' ')} bo‘yicha aniqroq aytib bera olasizmi?`;
}

/** The client's own words, used only when `useClientAnswer` is on (interactive demo). */
function lastClientText(view: PromptView): string | null {
  const segments = view.clientBlock.split(/--- message \d+/).slice(1);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const match = /CLIENT:\s*([\s\S]*)$/.exec(segments[i]!);
    if (match) return match[1]!.trim();
  }
  return null;
}

/** "menu.kind: Rasm bilan" → "Rasm bilan" (the demo driver and humans both prefix answers). */
function stripFieldPrefix(text: string, fieldPath: string): string {
  const prefix = `${fieldPath}:`;
  const trimmed = text.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed.slice(prefix.length).trim() : trimmed;
}

/**
 * The id of the last message the CLIENT wrote — exactly what a real model has to put into
 * `sourceMessageId` (our own messages do not carry an id in the prompt).
 */
function lastClientMessageId(view: PromptView): string | null {
  const pattern = /--- message \d+ \(([^)]*)\) ---\n\s*(CLIENT|US):/g;
  let cursor: RegExpExecArray | null;
  let last: string | null = null;
  while ((cursor = pattern.exec(view.clientBlock)) !== null) {
    if (cursor[2] === 'CLIENT') last = /id: ([0-9a-f-]{36})/i.exec(cursor[1]!)?.[1] ?? last;
  }
  return last;
}

/** A model that always claims the interview is complete — the engine must refuse (§10). */
export function createCompleteClaimerLlm(): ScriptedLlm {
  return createScriptedLlm((): string =>
    requirementsTurn({
      turnType: 'COMPLETE',
      internalSummaryMd: '# Ichki xulosa\n\nJuda qisqa, lekin "tayyor".',
      vision: { clientConfirmed: [], aiInferred: [], notSpecified: [] },
    }),
  );
}

/** A model that marks a field CLIENT_CONFIRMED without a real client message (§10A). */
export function createBogusSourceLlm(): ScriptedLlm {
  return createScriptedLlm((request: LlmRequest): string => {
    const view = readPrompt(request);
    const target = targetField(view.task);
    return requirementsTurn({
      turnType: 'ACKNOWLEDGE_AND_ASK',
      question: target ? { fieldPath: target, text: canonicalQuestion(target), quickReplies: ['Ha', 'Yo‘q'] } : undefined,
      fieldUpdates: [
        { fieldPath: 'design.style', value: 'neon', status: 'CLIENT_CONFIRMED', sourceMessageId: 'not-a-real-message-id' },
      ],
      vision: { clientConfirmed: [], aiInferred: [], notSpecified: [] },
    });
  });
}

/** A model that never answers with valid JSON (NEEDS_REVIEW path, docs/06 §5). */
export function createHopelessLlm(): ScriptedLlm {
  return createScriptedLlm((): string => 'I am not going to answer in JSON, sorry.');
}

