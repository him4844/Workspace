/**
 * Scripted Specification Agent + client-intent classifier (docs/14 §4).
 *
 * Like the requirements persona, this replaces only the network call: the prompt is parsed, the
 * output is a real contract-shaped object, and the deterministic audits in packages/core decide
 * whether it is accepted. The generator is written the way a careful model would have to write it —
 * every client-confirmed field becomes a SPEC-REQ with a testable AC, and the client summary is
 * derived FROM those same entities, so the §16/§17/§19 audits pass honestly rather than by
 * bypassing them.
 */
import { classifyIntentHint, type SpecDocument, type SpecRequirement } from '@wpp/core';
import { createPersonaLlm, readPrompt, RESTAURANT_PERSONA, type PromptView } from './persona.js';
import { createScriptedLlm, type ScriptedLlm } from './scripted-llm.js';
import type { LlmClient, LlmRequest } from '@wpp/agents';

/** Human titles for the requirement fields a scripted run is expected to confirm. */
const TITLES: Record<string, string> = {
  'business_purpose.purpose': 'Loyiha maqsadi',
  'business_purpose.company_name': 'Brend nomi',
  'target_audience.primary': 'Maqsadli mijozlar',
  'target_audience.languages': 'Sayt tillari',
  'website_type.type': 'Sayt turi',
  'pages.list': 'Sahifalar ro‘yxati',
  'features.core': 'Asosiy funksiyalar',
  'products_services.description': 'Mahsulot va xizmatlar',
  'products_services.count': 'Katalog hajmi',
  'authentication.needed': 'Ro‘yxatdan o‘tish',
  'payments.needed': 'Onlayn to‘lov',
  'admin_panel.needed': 'Boshqaruv paneli',
  'admin_panel.roles': 'Panel rollari',
  'design.style': 'Dizayn uslubi',
  'design.logo_assets': 'Brend materiallari',
  'content.languages': 'Kontent tillari',
  'content.texts_ready': 'Matnlar manbasi',
  'seo.needed': 'Qidiruvga moslashtirish',
  'seo.keywords': 'Kalit so‘zlar',
  'integrations.list': 'Tashqi xizmatlar',
  'integrations.google_analytics': 'Statistika xizmati',
  'security.requirements': 'Xavfsizlik talablari',
  'hosting.preference': 'Joylashtirish tanlovi',
  'domain.name': 'Domen nomi',
  'budget.range': 'Budjet oralig‘i',
  'deadline.expected': 'Muddat kutilmasi',
  'deadline.hard_date': 'Qat’iy muddat',
  'menu.kind': 'Menyu ko‘rinishi',
  'menu.categories_count': 'Menyu bo‘limlari',
  'reservations.enabled': 'Stol bron qilish',
  'reservations.confirmation': 'Bron tasdiqlash',
  'delivery.enabled': 'Yetkazib berish',
  'delivery.zone': 'Yetkazish hududi',
  'branches.count': 'Filiallar soni',
  'branches.hours': 'Ish vaqti',
  'online_ordering.enabled': 'Onlayn buyurtma',
  'location.map': 'Xarita',
};

const SECTION_FOR: Array<{ match: RegExp; section: string }> = [
  { match: /^pages\.|^website_type\./, section: 'Page Specifications' },
  { match: /^features\.|^reservations\.|^online_ordering\.|^delivery\.|^menu\./, section: 'Feature Specifications' },
  { match: /^design\.|^content\./, section: 'UI/UX Requirements' },
  { match: /^seo\./, section: 'SEO' },
  { match: /^security\./, section: 'Security' },
  { match: /^admin_panel\.|^authentication\./, section: 'Admin Panel' },
  { match: /^integrations\.|^location\./, section: 'Third-party Integrations' },
  { match: /^hosting\.|^domain\./, section: 'Deployment Requirements' },
  { match: /^budget\.|^deadline\./, section: 'Project Overview' },
  { match: /^business_purpose\.|^target_audience\./, section: 'Business Goals' },
];

const PRIORITY_FOR: Array<{ match: RegExp; priority: 'MUST' | 'NICE_TO_HAVE' | 'LATER' }> = [
  { match: /^payments\.|^seo\.keywords|^integrations\.google_analytics|^menu\.categories_count/, priority: 'NICE_TO_HAVE' },
  { match: /^deadline\.hard_date|^design\.logo_assets/, priority: 'LATER' },
];

export function titleFor(fieldPath: string): string {
  return TITLES[fieldPath] ?? humanize(fieldPath);
}

function humanize(fieldPath: string): string {
  const last = fieldPath.split('.').pop() ?? fieldPath;
  const words = last.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sectionFor(fieldPath: string): string {
  return SECTION_FOR.find((s) => s.match.test(fieldPath))?.section ?? 'Functional Requirements';
}

function priorityFor(fieldPath: string, mandatory: boolean): 'MUST' | 'NICE_TO_HAVE' | 'LATER' {
  return PRIORITY_FOR.find((p) => p.match.test(fieldPath))?.priority ?? (mandatory ? 'MUST' : 'NICE_TO_HAVE');
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function firstToken(text: string): string {
  return text.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)[0] ?? '';
}

export interface SpecPersonaOptions {
  /** title for a requirement the summary deliberately omits (consistency-audit test) */
  omitFromSummary?: string;
  /** name a page in the summary that the spec does not have (consistency-audit test) */
  inventPage?: string;
  /** skip the SPEC-REQ entry for this field (traceability-audit test) */
  dropField?: string;
  /** produce a non-testable AC for this field (lint test) */
  untestableField?: string;
}

export function buildSpecOutput(view: PromptView, options: SpecPersonaOptions = {}): { spec: SpecDocument; clientSummary: { markdown: string; assumptionsShown: string[]; approveLabel: string; requestChangesLabel: string } } {
  const data = view.projectData as unknown as {
    projectType: string;
    requirementsVersion: number;
    requirementFields: Array<{ fieldPath: string; value: unknown; status: string; priority: string; mandatory: boolean }>;
    internalRequirementsSummary?: string | null;
    revision?: { changeRequestText: string; previousVersion?: number | null } | null;
  };

  const confirmed = data.requirementFields.filter((f) => f.status === 'CLIENT_CONFIRMED' || f.status === 'CLIENT_APPROVED_DEFAULT');
  const inferred = data.requirementFields.filter((f) => f.status === 'AI_INFERRED');
  const fieldValue = (path: string): unknown => data.requirementFields.find((f) => f.fieldPath === path)?.value ?? null;

  let counter = 0;
  const requirements: SpecRequirement[] = confirmed
    .filter((f) => f.fieldPath !== options.dropField)
    .map((field) => {
      counter += 1;
      const code = `SPEC-REQ-${String(counter).padStart(3, '0')}`;
      const title = titleFor(field.fieldPath);
      const value = asText(field.value);
      const untestable = options.untestableField === field.fieldPath;
      return {
        code,
        originReqField: field.fieldPath,
        originMessageIds: [],
        section: sectionFor(field.fieldPath),
        title,
        description: `${title}: mijoz tomonidan tasdiqlangan qiymat — ${value}. Shu asosda sahifa/funksiya ishlab chiqiladi va kontent ${field.fieldPath} qiymatiga mos bo‘lishi kerak.`,
        priority: priorityFor(field.fieldPath, field.mandatory),
        acceptanceCriteria: [
          {
            code: `AC-${String(counter).padStart(3, '0')}`,
            text: untestable
              ? `${title} chiroyli va zamonaviy ko‘rinadi.`
              : `Tekshiruv: ${field.fieldPath} bo‘yicha "${value}" ko‘rinishi interfeys orqali tasdiqlanadi.`,
            testable: !untestable,
            verificationHint: untestable ? 'VISUAL' : 'E2E',
          },
        ],
        verificationExpectation: `E2E: ${field.fieldPath} holatini ochib tekshirish.`,
      } satisfies SpecRequirement;
    });

  // A revision must not silently drop what the client already saw: keep the existing entries and
  // incorporate the requested change. The change is traced to the requirement field it touches when
  // there is a clear match; otherwise it is recorded as a NICE_TO_HAVE entry — per §16 a MUST
  // requirement must trace back to a client-confirmed field, and the change has no such field yet.
  if (data.revision) {
    counter += 1;
    const changeText = data.revision.changeRequestText;
    const words = changeText.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    const match = confirmed.find((f) => {
      const haystack = `${f.fieldPath} ${titleFor(f.fieldPath)} ${asText(f.value)}`.toLowerCase();
      return words.some((w) => haystack.includes(w));
    });
    const code = `SPEC-REQ-${String(counter).padStart(3, '0')}`;
    requirements.push({
      code,
      originReqField: match?.fieldPath ?? null,
      section: 'Functional Requirements',
      title: match ? `${titleFor(match.fieldPath)} — yangilangan` : 'Mijoz so‘ragan o‘zgartirish',
      description: match
        ? `Mijoz o‘zgartirishi (${match.fieldPath}) asosida yangilandi: ${changeText}`
        : `Mijoz o‘zgartirishi (requirement fieldga hali bog‘lanmagan): ${changeText}`,
      priority: match ? 'MUST' : 'NICE_TO_HAVE',
      acceptanceCriteria: [
        {
          code: `AC-${String(counter).padStart(3, '0')}`,
          text: `O‘zgartirish bo‘yicha yangi holat interfeysda tekshiriladi: ${changeText.slice(0, 120)}`,
          testable: true,
          verificationHint: 'E2E',
        },
      ],
      verificationExpectation: 'E2E: o‘zgargan qismni ochib tekshirish.',
    });
  }

  const pagesValue = fieldValue('pages.list');
  const pages = (Array.isArray(pagesValue) ? pagesValue.map((p) => String(p)) : String(pagesValue ?? 'Bosh sahifa').split(',').map((s) => s.trim()))
    .filter(Boolean)
    .map((name) => ({ name, purpose: `${name} bo‘limi mijozga kerakli ma’lumotni ko‘rsatadi.`, sections: ['asosiy kontent'] }));

  const mustTitles = requirements.filter((r) => r.priority === 'MUST').map((r) => r.title);
  const featureTitles = requirements.filter((r) => r.section === 'Feature Specifications').map((r) => r.title);
  const lines: string[] = [];
  lines.push('## Maqsad');
  lines.push(asText(fieldValue('business_purpose.purpose')));
  lines.push('');
  lines.push('## Sahifalar');
  for (const page of pages) {
    if (options.omitFromSummary && options.omitFromSummary === page.name) continue;
    lines.push(`- ${/sahifa/i.test(page.name) ? page.name : `${page.name} sahifasi`}`);
  }
  if (options.inventPage) lines.push(`- ${options.inventPage} sahifasi`);
  lines.push('');
  lines.push('## Funksiyalar');
  for (const title of featureTitles) {
    if (options.omitFromSummary === title) continue;
    lines.push(`- ${title}`);
  }
  const mustExtras = mustTitles.filter((t) => !featureTitles.includes(t) && t !== options.omitFromSummary);
  for (const title of mustExtras) lines.push(`- ${title}`);
  if (data.revision) lines.push(`- Siz so‘ragan o‘zgartirish: ${data.revision.changeRequestText.slice(0, 160)}`);
  lines.push('');
  lines.push('## Dizayn');
  lines.push(asText(fieldValue('design.style')));
  lines.push('');
  lines.push('## Taxminlar');
  lines.push('- Menyu va matnlar ishga tushirilganda tayyor bo‘ladi.');
  for (const inf of inferred.slice(0, 3)) lines.push(`- ${titleFor(inf.fieldPath)} hozircha taxmin sifatida qabul qilindi.`);
  lines.push('');
  lines.push('Agar shu tavsif to‘g‘ri bo‘lsa, tasdiqlashingizni so‘raymiz.');

  const spec: SpecDocument = {
    meta: {
      projectType: data.projectType,
      generatedFromRequirementsVersion: data.requirementsVersion,
      sectionsIncluded: ['Project Overview', 'Page Specifications', 'Functional Requirements', 'Acceptance Criteria'],
      sectionsOmitted: ['Payment Requirements', 'Database Design'],
    },
    overview: `Mijoz: ${asText(fieldValue('business_purpose.company_name'))}. Maqsad: ${asText(fieldValue('business_purpose.purpose'))}`,
    businessGoals: [asText(fieldValue('business_purpose.purpose'))],
    targetUsers: [asText(fieldValue('target_audience.primary'))],
    sitemap: pages.map((p) => p.name),
    pages,
    requirements,
    nonFunctional: { performance: 'Sahifalar tez yuklanishi kerak', accessibility: 'Kontrast va shrift o‘lchamlari qulay bo‘lishi kerak' },
    integrations: (Array.isArray(fieldValue('integrations.list')) ? fieldValue('integrations.list') as unknown[] : []).map((i) => String(i)),
    databaseNotes: null,
    deploymentRequirements: asText(fieldValue('hosting.preference')),
    definitionOfDone: ['Barcha MUST talablar ishlaydi', 'Mobil va desktopda tekshiriladi', 'Mijoz tasdiqlagan kontent joylangan'],
    knownAssumptions: inferred.map((f) => `${titleFor(f.fieldPath)} — AI taxmini, mijoz hali tasdiqlamagan`),
    openQuestions: [],
    futureScope: ['Onlayn to‘lov keyingi bosqichda qo‘shilishi mumkin'],
  };

  return {
    spec,
    clientSummary: {
      markdown: lines.join('\n'),
      assumptionsShown: (spec.knownAssumptions ?? ['Menyu va matnlar ishga tushirilganda tayyor bo‘ladi.']),
      approveLabel: 'Ha, tasdiqlayman',
      requestChangesLabel: 'O‘zgartirish kerak',
    },
  };
}

/** The scripted Specification Agent: generation, revision and client-intent classification. */
export function createSpecPersonaLlm(options: SpecPersonaOptions = {}): ScriptedLlm {
  let sawRevision = false;
  return createScriptedLlm((request: LlmRequest): string => {
    const view = readPrompt(request);
    if (/Classify the client/i.test(view.task)) {
      const last = lastClientMessage(view);
      const hint = classifyIntentHint(last);
      if (hint) {
        return JSON.stringify({
          intent: hint.intent,
          confidence: hint.confidence,
          changeItems: hint.intent === 'REQUEST_CHANGES' ? [{ description: last.slice(0, 200), likelyFieldPath: null, likelySpecSection: null }] : [],
          language: 'uz',
        });
      }
      if (/\?$/.test(last.trim())) return JSON.stringify({ intent: 'QUESTION', confidence: 0.7, language: 'uz' });
      if (last.trim().length === 0) return JSON.stringify({ intent: 'SMALL_TALK', confidence: 0.6, language: 'uz' });
      return JSON.stringify({ intent: 'UNCLEAR', confidence: 0.4, language: 'uz' });
    }
    if (!sawRevision && /REVISION/i.test(view.task)) sawRevision = true;
    void firstToken;
    return JSON.stringify(buildSpecOutput(view, options));
  });
}

function lastClientMessage(view: PromptView): string {
  const segments = view.clientBlock.split(/--- message \d+/).slice(1);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const match = /CLIENT:\s*([\s\S]*)$/.exec(segments[i]!);
    if (match) return match[1]!.trim();
  }
  return '';
}


export interface PipelineLlmOptions extends SpecPersonaOptions {
  /** replace the client persona answering the requirements interview */
  requirements?: LlmClient;
}

/** Does this request belong to the Specification Agent (generation, revision) or the intent classifier? */
export function isSpecTask(task: string): boolean {
  return /^\s*(Produce specification|Classify the client)/.test(task);
}

/**
 * One scripted LLM for the whole pipeline: the routing decision is made from the task block the
 * runtime built (never from call order), so a retry or a repair cannot desynchronise the personas.
 * Used by the Phase-3 e2e tests and by `npm run simulate:phase3`.
 */
export function createPipelineLlm(options: PipelineLlmOptions = {}): ScriptedLlm & { calls: LlmRequest[] } {
  const specLlm = createSpecPersonaLlm(options);
  const requirementsLlm = options.requirements ?? createPersonaLlm(RESTAURANT_PERSONA, { useClientAnswer: true });
  const calls: LlmRequest[] = [];
  return {
    provider: 'scripted-router',
    calls,
    remaining: () => Number.POSITIVE_INFINITY,
    async complete(request: LlmRequest) {
      calls.push(request);
      const target = isSpecTask(readPrompt(request).task) ? specLlm : requirementsLlm;
      return target.complete(request);
    },
  };
}
