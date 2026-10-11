/**
 * Deterministic rendering of the Technical Specification (§15) to Markdown.
 *
 * The agent decides the *content*; this renderer decides the *shape of the document* on disk, so
 * the artifact a human reviews never depends on the model's markdown mood, and the traceability
 * matrix (§16) is always appended by us rather than written by the model.
 */
import type { SpecDocument, TraceabilityRow } from './traceability.js';

export function renderSpecMarkdown(
  spec: SpecDocument,
  meta: { version: number; projectName?: string | null; traceability?: TraceabilityRow[] },
): string {
  const l: string[] = [];
  l.push(`# Texnik spetsifikatsiya — v${meta.version}`);
  l.push('');
  l.push(`- **Loyiha:** ${meta.projectName ?? spec.meta.projectType}`);
  l.push(`- **Turi:** ${spec.meta.projectType}`);
  l.push(`- **Manba:** requirements v${spec.meta.generatedFromRequirementsVersion}`);
  if (spec.meta.sectionsIncluded?.length) l.push(`- **Kiritilgan bo‘limlar:** ${spec.meta.sectionsIncluded.join(', ')}`);
  if (spec.meta.sectionsOmitted?.length) l.push(`- **Atoqli o‘tkazib yuborilgan bo‘limlar:** ${spec.meta.sectionsOmitted.join(', ')}`);
  l.push('');

  const section = (title: string, body: string | null | undefined) => {
    if (!body || body.trim().length === 0) return;
    l.push(`## ${title}`, '', body.trim(), '');
  };
  const listSection = (title: string, items: string[] | undefined) => {
    if (!items || items.length === 0) return;
    l.push(`## ${title}`, '', ...items.map((i) => `- ${i}`), '');
  };

  section('1. Umumiy tavsif', spec.overview ?? undefined);
  listSection('2. Biznes maqsadlari', spec.businessGoals);
  listSection('3. Maqsadli foydalanuvchilar', spec.targetUsers);
  listSection('4. Sayt xaritasi (sitemap)', spec.sitemap);

  if (spec.pages && spec.pages.length > 0) {
    l.push('## 5. Sahifalar', '');
    for (const page of spec.pages) {
      l.push(`### ${page.name}`, '', page.purpose, '');
      if (page.sections?.length) l.push(`Bo‘limlar: ${page.sections.join(', ')}`, '');
    }
  }

  l.push('## 6. Talablar va qabul mezonlari (traceability §16)', '');
  for (const req of spec.requirements) {
    l.push(`### ${req.code} — ${req.title}`);
    l.push('');
    l.push(`- **Bo‘lim:** ${req.section}`);
    l.push(`- **Muhimlik:** ${req.priority}`);
    l.push(`- **Manba (requirement field):** ${req.originReqField ?? '— (AI-initiated, not client-confirmed)'}`);
    if (req.originMessageIds?.length) l.push(`- **Manba xabarlar:** ${req.originMessageIds.join(', ')}`);
    l.push('');
    l.push(req.description.trim());
    l.push('');
    l.push('**Qabul mezonlari:**');
    for (const ac of req.acceptanceCriteria) {
      l.push(`- ${ac.code}${ac.testable ? '' : ' (NOT TESTABLE)'}${ac.verificationHint ? ` [${ac.verificationHint}]` : ''}: ${ac.text}`);
    }
    if (req.verificationExpectation) l.push('', `_Tekshirish:_ ${req.verificationExpectation}`);
    l.push('');
  }

  if (spec.nonFunctional && Object.keys(spec.nonFunctional).length > 0) {
    section('7. Nofunksional talablar', Object.entries(spec.nonFunctional).map(([k, v]) => `${k}: ${String(v)}`).join('\n'));
  }
  listSection('8. Integratsiyalar', spec.integrations);
  section('9. Ma’lumotlar bazasi', spec.databaseNotes ?? undefined);
  section('10. Joylashtirish (deployment)', spec.deploymentRequirements ?? undefined);
  listSection('11. Tayyorlik ta’rifi (Definition of Done)', spec.definitionOfDone);
  listSection('12. Ma’lum taxminlar', spec.knownAssumptions);

  if (spec.openQuestions.length > 0) {
    l.push('## 13. Ochiq savollar', '');
    for (const q of spec.openQuestions) {
      l.push(`- ${q.blocking ? '**[BLOCKING]** ' : ''}${q.question}${q.relatedField ? ` (${q.relatedField})` : ''}`);
    }
    l.push('');
  }
  listSection('14. Kelgusi ishlar (future scope)', spec.futureScope);

  if (meta.traceability && meta.traceability.length > 0) {
    l.push('## 15. Traceability matritsasi (REQ → SPEC-REQ → AC)', '');
    l.push('| SPEC-REQ | Manba field | Bo‘lim | Muhimlik | AC | Hammasi testable |');
    l.push('|---|---|---|---|---|---|');
    for (const row of meta.traceability) {
      l.push(`| ${row.specReqCode} | ${row.originReqField ?? '—'} | ${row.section} | ${row.priority} | ${row.acceptanceCriteria.join(', ') || '—'} | ${row.allTestable ? '✅' : '❌'} |`);
    }
    l.push('');
  }

  return l.join('\n');
}
