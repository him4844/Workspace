/**
 * Specification rules that are not traceability: summary ↔ spec consistency (§19), version and
 * lock rules (§34/§35) and the two-step approval state derivation (§18).
 */
import type { ClientSummary, SpecDocument, SpecStatus } from './traceability.js';

// ---------------------------------------------------------------- §19 consistency

export interface ConsistencyIssue {
  kind: 'SUMMARY_MENTIONS_UNKNOWN_PAGE' | 'SUMMARY_MENTIONS_UNKNOWN_FEATURE' | 'SUMMARY_MISSING_REQUIRED_HEADING' | 'SUMMARY_TOO_TECHNICAL' | 'SUMMARY_EMPTY';
  detail: string;
}

/** Words a client-facing summary must not need help understanding (§18: simple language). */
const TECHY_MARKERS = [
  'api', 'api endpoint', 'json', 'json schema', 'postgres', 'database', 'database schema',
  'backend', 'frontend', 'server', 'orm', 'ci/cd', 'docker', 'endpoint', 'webhook', 'crud',
  'stack trace', 'typescript', 'react', 'next.js', 'sql', 'repository', 'deploy',
];

const REQUIRED_SUMMARY_SECTIONS: Array<{ label: string; patterns: RegExp[] }> = [
  { label: 'purpose', patterns: [/maqsad/i, /purpose/i, /nima uchun/i, /goal/i] },
  { label: 'pages', patterns: [/sahifa/i, /pages/i, /bo‘lim/i, /section/i] },
  { label: 'features', patterns: [/funksiya/i, /feature/i, /imkoniyat/i] },
  { label: 'design', patterns: [/dizayn/i, /design/i, /uslub/i] },
];

/**
 * "Client Summary and Technical Spec never contradict each other" (phase acceptance check),
 * implemented structurally: every page/feature *named* by the summary must exist in the spec,
 * and the summary must cover the four things §18 requires (purpose, pages, features, design).
 * We do not compare prose — that is the Spec Auditor's job in Phase 4 — we compare entities.
 */
export function auditSummaryConsistency(spec: SpecDocument, summary: ClientSummary): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const markdown = summary.markdown ?? '';
  if (markdown.trim().length === 0) {
    return [{ kind: 'SUMMARY_EMPTY', detail: 'client summary is empty' }];
  }
  const lower = markdown.toLowerCase();

  const pageNames = new Set((spec.pages ?? []).map((p) => p.name.toLowerCase()));
  const sitemap = new Set((spec.sitemap ?? []).map((s) => s.toLowerCase()));
  for (const page of spec.pages ?? []) {
    if (!lower.includes(page.name.toLowerCase())) continue; // omission is allowed, invention is not
    pageNames.add(page.name.toLowerCase());
  }

  // A summary that names a page must name a page the spec has: scan capitalised "X page" phrases.
  const mentionedPages = [...markdown.matchAll(/([\p{Lu}][\p{L}‘’' -]{2,30})\s+(?:sahifasi|sahifada|sahifa|page)\b/gu)].map((m) => m[1]!.trim().toLowerCase());
  for (const mentioned of mentionedPages) {
    const known = [...pageNames, ...sitemap].some((name) => name.includes(mentioned) || mentioned.includes(name));
    if (!known) {
      issues.push({ kind: 'SUMMARY_MENTIONS_UNKNOWN_PAGE', detail: `summary names the page "${mentioned}" which the specification does not contain` });
    }
  }

  // Every MUST feature title must be recognisable in the summary (same words, either language is
  // acceptable for short titles, so we compare on the first significant token).
  for (const req of spec.requirements.filter((r) => r.priority === 'MUST')) {
    const token = firstSignificantToken(req.title);
    const descriptionToken = firstSignificantToken(req.description);
    const mentioned = (token && lower.includes(token)) || (descriptionToken && lower.includes(descriptionToken));
    if (!mentioned) {
      issues.push({
        kind: 'SUMMARY_MENTIONS_UNKNOWN_FEATURE',
        detail: `MUST requirement ${req.code} ("${req.title}") is not mentioned in the client summary`,
      });
    }
  }

  for (const required of REQUIRED_SUMMARY_SECTIONS) {
    if (!required.patterns.some((re) => re.test(markdown))) {
      issues.push({ kind: 'SUMMARY_MISSING_REQUIRED_HEADING', detail: `the summary does not cover "${required.label}" (§18)` });
    }
  }

  const techy = TECHY_MARKERS.filter((marker) => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(lower);
  });
  if (techy.length > 0) {
    issues.push({ kind: 'SUMMARY_TOO_TECHNICAL', detail: `technical wording leaked into the client summary: ${techy.join(', ')}` });
  }
  return issues;
}

function firstSignificantToken(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !['uchun', 'bilan', 'sayti', 'sayt', 'page', 'section', 'sahifa'].includes(w));
  return words[0] ?? null;
}

// ---------------------------------------------------------------- §34/§35 versioning & lock

export const EDITABLE_SPEC_STATUSES: readonly SpecStatus[] = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED'];

export function isSpecEditable(status: SpecStatus): boolean {
  return EDITABLE_SPEC_STATUSES.includes(status);
}

export type SpecWriteRefusal = { ok: false; code: 'SPEC_IS_LOCKED' | 'SPEC_IS_APPROVED'; message: string } | { ok: true };

/** Any in-place write to a spec version must pass this (§19 "never silently modify an approved specification"). */
export function assertSpecWritable(status: SpecStatus): SpecWriteRefusal {
  if (status === 'LOCKED' || status === 'APPROVED') {
    return {
      ok: false,
      code: status === 'LOCKED' ? 'SPEC_IS_LOCKED' : 'SPEC_IS_APPROVED',
      message: 'approved specifications are immutable — create a change request (SPEC §35)',
    };
  }
  return { ok: true };
}

export interface SpecVersionLike {
  version: number;
  status: SpecStatus;
}

export function nextSpecVersion(existing: SpecVersionLike[]): number {
  return existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;
}

/** The version the project currently works with: the newest non-superseded one. */
export function currentSpecVersion<T extends SpecVersionLike>(versions: T[]): T | null {
  const candidates = versions.filter((v) => v.status !== 'SUPERSEDED');
  return candidates.length === 0 ? null : candidates.reduce((a, b) => (b.version > a.version ? b : a));
}

/** The version the client approved (if any) — Phase 4 audits exactly this one. */
export function approvedSpecVersion<T extends SpecVersionLike>(versions: T[]): T | null {
  return versions.find((v) => v.status === 'LOCKED' || v.status === 'APPROVED') ?? null;
}

// ---------------------------------------------------------------- §18 two-step approval

export type ApprovalStep = 'SEND_SUMMARY' | 'AWAIT_SUMMARY_ACK' | 'SEND_APPROVAL_REQUEST' | 'AWAIT_DECISION' | 'DECIDED';

export interface ApprovalProgress {
  summarySentAt: Date | null;
  approvalRequestedAt: Date | null;
  decidedAt: Date | null;
}

/**
 * The human chose a two-step flow: the summary goes out first, the explicit approve/change request
 * is only asked once the client has replied to the summary (any reply — even a small talk message —
 * counts as "they saw it", but a change request skips straight to the change path).
 */
export function deriveApprovalStep(progress: ApprovalProgress): ApprovalStep {
  if (progress.decidedAt) return 'DECIDED';
  if (!progress.summarySentAt) return 'SEND_SUMMARY';
  if (!progress.approvalRequestedAt) return 'AWAIT_SUMMARY_ACK';
  return 'AWAIT_DECISION';
}

export const APPROVE_LABEL_DEFAULT = 'Ha, tasdiqlayman';
export const REQUEST_CHANGES_LABEL_DEFAULT = 'O‘zgartirish kerak';

/**
 * §38 — the ONE injection heuristic in the codebase. Client text is untrusted content: an
 * instruction inside it is not an order, and the pipeline records that it saw the attempt.
 * Every caller (prompt assembly, workers, tests) uses this function, so the patterns can never
 * drift apart between packages.
 *
 * Apostrophes in Uzbek are typed in at least three ways (' ‘ ’) — the patterns tolerate all of them.
 */
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all )?(your |the )?(previous )?(instructions|rules|prompt)/i,
  /you are now|act as (a|an)|developer mode|jailbreak/i,
  /reveal\s+(your\s+)?(instructions|prompt|api\s*key|secret)/i,
  /(ko[’'‘]?rsatma|qoida)(lar)?(ingizni|ni)?\s*[,.!]?\s*(unut|tashla|e[’'‘]?tiborsiz)/i,
  /(ko[’'‘]?rsatma|prompt|kalit|parol|secret)(ni|ingizni|lar)?\s*(ko[’'‘]?rsat|ber|ayt|chiqar)/i,
  /игнорируй\s+(все\s+)?(предыдущие\s+)?(инструкции|правила)/i,
  /выведи\s+(свой\s+)?(промпт|инструкции|ключ)/i,
];

export function looksLikeInjection(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  return t.length > 0 && INJECTION_PATTERNS.some((re) => re.test(t));
}

/** Back-compat alias: the worker flagged review-stage messages under this name in an earlier build. */
export const looksLikeInjectionClientSafe = looksLikeInjection;

// ---------------------------------------------------------------- §35 change requests

export type ChangeRequestStatus = 'REQUESTED' | 'ANALYZING' | 'APPROVED' | 'REJECTED' | 'IMPLEMENTING' | 'COMPLETED';

export const CHANGE_REQUEST_STATUSES: readonly ChangeRequestStatus[] = [
  'REQUESTED', 'ANALYZING', 'APPROVED', 'REJECTED', 'IMPLEMENTING', 'COMPLETED',
];

export interface ChangeRequestInput {
  requestedChange: string;
  source: string;
  reason?: string | null;
  affectedRequirements?: string[];
  affectedSpecSections?: string[];
  potentialImpact?: string | null;
}

export function isChangeRequestStatus(value: string): value is ChangeRequestStatus {
  return (CHANGE_REQUEST_STATUSES as readonly string[]).includes(value);
}
