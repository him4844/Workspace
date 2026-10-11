/**
 * Phase 3 helpers: one router LLM drives the whole pipeline in tests and demos.
 *
 * The pipeline now talks to two different agents (requirements, specification) plus the intent
 * classifier, all through the same `LlmClient` interface. The router sends each request to the
 * scripted persona that can honestly answer it — determined by the task block the runtime built,
 * not by call order, so a retry or a repair cannot desynchronise the personas.
 */
import { createScriptedLlm, type PipelineLlmOptions } from '@wpp/testing';

export * from './phase2.js';
export {
  buildSpecOutput, createSpecPersonaLlm, createPipelineLlm, isSpecTask, titleFor,
  type PipelineLlmOptions, type SpecPersonaOptions,
} from '@wpp/testing';

/** Back-compat alias used by the Phase-3 tests: the pipeline-wide scripted LLM. */
export { createPipelineLlm as createRouterLlm } from '@wpp/testing';

export type RouterLlmOptions = PipelineLlmOptions;

/** A fixed-response LLM for the failure paths (contract violation, human review, …). */
export function createRawLlm(responses: string[], provider = 'fake') {
  return createScriptedLlm(responses, provider);
}
