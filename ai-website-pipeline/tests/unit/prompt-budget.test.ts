/**
 * The free-tier budget guard (D-040, §58): the specification call could not run on an 8 000 TPM
 * free tier because its prompt was 7.1k tokens + a 4k output cap. These tests make the fix a
 * contract: compact rendering, cosmetic schema keys dropped, and the assembled spec prompt of a
 * realistic 39-field project must fit `FREE_TPM_BUDGET` together with its output cap.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assemblePrompt, budgetReport, compactJson, estimatePromptTokens, estimateTokens, promptBudgetFromEnv, slimSchema,
} from '@wpp/agents';

const specContract = JSON.parse(readFileSync('docs/contracts/specification-output.json', 'utf8')) as Record<string, unknown>;

function field(i: number, status: string) {
  return {
    fieldPath: `section_${i}.field_${i}`,
    category: i % 2 === 0 ? 'BRAND' : null,
    status,
    priority: i % 3 === 0 ? 'MUST' : 'NICE_TO_HAVE',
    mandatory: i % 2 === 0,
    value: 'Osh Baraka — milliy taomlar, 3 filial, har kuni 10:00–22:00',
    sourceMessageId: `01J${i}ABCDEFGHJKMNPQRSTVWXYZ`,
  };
}

const specLikeData = {
  projectType: 'LANDING_PAGE',
  requirementsVersion: 1,
  requirementFields: Array.from({ length: 39 }, (_, i) => field(i, i < 31 ? 'CLIENT_CONFIRMED' : 'UNKNOWN')),
  contradictions: [],
  internalRequirementsSummary: '# Talablar\n' + 'Ma’lumot '.repeat(120),
  revision: null,
  traceabilityRule: 'originReqField must be one of the fieldPath values above.',
};

describe('prompt budget (§58, D-040)', () => {
  it('compact JSON carries the same data with fewer tokens', () => {
    const pretty = JSON.stringify(specLikeData, null, 2);
    const compact = compactJson(specLikeData);
    expect(compact).not.toContain('\n');
    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty));
    expect(estimateTokens(compact)).toBeLessThan(estimateTokens(pretty) * 0.85);
  });

  it('slimSchema drops annotations but keeps every property the model must produce', () => {
    const slim = slimSchema(specContract) as Record<string, unknown>;
    // dropped from the prompt copy: documentation and the deliberately invalid example
    expect(slim['$schema']).toBeUndefined();
    expect(slim.description).toBeUndefined();
    expect(slim.exampleInvalid).toBeUndefined();
    expect(slim.required).toEqual(specContract.required);
    expect(Object.keys(slim.properties as object)).toEqual(Object.keys(specContract.properties as object));
    expect(compactJson(slim).length).toBeLessThan(compactJson(specContract).length);

    // THE trap this test exists for: a requirement field NAMED `description` is data, not an
    // annotation — deleting it would ask the model for a different object than the contract.
    const requirement = (specContract.properties as any).spec.properties.requirements.items;
    expect(Object.keys(requirement.properties)).toContain('description');
    const slimRequirement = (slim.properties as any).spec.properties.requirements.items;
    expect(Object.keys(slimRequirement.properties)).toEqual(Object.keys(requirement.properties));
    expect(slimRequirement.required).toEqual(requirement.required);
  });

  it('a realistic specification prompt fits an 8 000 TPM window with its output cap', () => {
    const messages = assemblePrompt({
      systemInstructions: 'Siz texnik spetsifikatsiya agentisiz. '.repeat(40),
      task: 'Produce specification v1 for this project. '.repeat(60),
      projectData: specLikeData,
      clientMessages: [{ id: 'msg-1', at: '2026-10-08T10:00:00Z', text: 'Salom, restoran uchun sayt kerak' }],
      outputSchema: specContract,
    });
    const report = budgetReport(messages, 3000, 8000);
    expect(report.fits).toBe(true);
    expect(report.reservedTokens).toBeLessThan(8000);
    expect(report.promptTokens).toBe(estimatePromptTokens(messages));
  });

  it('over-budget requests are reported with the exact overflow', () => {
    const messages = assemblePrompt({
      systemInstructions: 'x'.repeat(20000), task: 'y'.repeat(20000),
      projectData: {}, clientMessages: [], outputSchema: { type: 'object' },
    });
    const report = budgetReport(messages, 3000, 8000);
    expect(report.fits).toBe(false);
    expect(report.overBy).toBe(report.reservedTokens - 8000);
  });

  it('the budget comes from the environment, with the documented default', () => {
    expect(promptBudgetFromEnv({})).toBe(8000);
    expect(promptBudgetFromEnv({ FREE_TPM_BUDGET: '12000' })).toBe(12000);
    expect(promptBudgetFromEnv({ FREE_TPM_BUDGET: 'nonsense' })).toBe(8000);
  });
});
