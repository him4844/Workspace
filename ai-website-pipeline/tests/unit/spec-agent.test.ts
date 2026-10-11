import { describe, expect, it } from 'vitest';
import { buildSpecProjectData, buildSpecTaskBlock, validateSpecification } from '@wpp/agents';

const base = {
  projectType: 'RESTAURANT',
  requirementsVersion: 1,
  fields: [
    { fieldPath: 'menu.kind', value: 'Uzbek cuisine', status: 'CLIENT_CONFIRMED' as const, priority: 'MUST' as const, mandatory: true },
    { fieldPath: 'branches.hours', value: '09:00-22:00', status: 'CLIENT_APPROVED_DEFAULT' as const, priority: 'MUST' as const, mandatory: true },
    { fieldPath: 'seo.keywords', value: null, status: 'UNCLEAR' as const, priority: 'NICE_TO_HAVE' as const, mandatory: false },
  ],
  contradictions: [],
  internalSummaryMd: null,
  revision: null,
  language: 'uz',
  approveLabel: 'Ha, tasdiqlayman',
  requestChangesLabel: 'O‘zgartirish kerak',
};

describe('spec agent — explicit coverage and bounded repair input', () => {
  it('lists every and only client-confirmed field path for exact traceability', () => {
    const task = buildSpecTaskBlock(base);
    expect(task).toContain('there are 2 client-confirmed requirement fields');
    expect(task).toContain('- menu.kind');
    expect(task).toContain('- branches.hours');
    expect(task).not.toContain('- seo.keywords');
    expect(task).toContain('## Maqsad · ## Sahifalar · ## Imkoniyatlar · ## Dizayn');
  });

  it('includes the failed candidate in project data so repair revises rather than regenerates blind', () => {
    const repairDraft = {
      spec: {
        meta: { projectType: 'RESTAURANT', generatedFromRequirementsVersion: 1 },
        requirements: [{
          code: 'SPEC-REQ-001', originReqField: 'menu.kind', section: 'Menu', title: 'Taomlar',
          description: 'Confirmed menu type is Uzbek cuisine.', priority: 'MUST' as const,
          acceptanceCriteria: [{ code: 'AC-001', text: 'The menu displays Uzbek dishes.', testable: true, verificationHint: 'VISUAL' as const }],
        }],
        openQuestions: [],
      },
      clientSummary: { markdown: 'Maqsad: restoran sayti.', assumptionsShown: [] },
    };
    const params = {
      ...base,
      repairDraft,
      repairGaps: [{ kind: 'UNTRACEABLE' as const, detail: 'client summary omits the MUST menu requirement' }],
    };
    const projectData = buildSpecProjectData(params) as { repairDraft: unknown };
    expect(projectData.repairDraft).toEqual(repairDraft);
    const task = buildSpecTaskBlock(params);
    expect(task).toContain('Revise THAT exact candidate');
    expect(task).toContain('client summary omits the MUST menu requirement');

    // AC code is globally unique in the DB and Code Checker contract: a duplicate must fail schema
    // validation (and enter the runtime's JSON repair) before any SQL unique-index crash.
    const duplicateAc = structuredClone(repairDraft);
    duplicateAc.spec.requirements.push({
      ...duplicateAc.spec.requirements[0]!,
      code: 'SPEC-REQ-002',
      originReqField: 'branches.hours',
      title: 'Opening hours',
    });
    expect(validateSpecification(duplicateAc).ok).toBe(false);
  });
});
