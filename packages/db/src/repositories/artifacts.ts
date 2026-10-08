/**
 * Artifact rows (docs/03 §7; SPEC §45, D-019). File content is written by packages/infra;
 * this repository records the row that makes it queryable and audit-proof.
 */
import { desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@wpp/infra';
import type { Executor } from '../client.js';
import { artifacts } from '../schema.js';

export type ArtifactRow = typeof artifacts.$inferSelect;

export async function createArtifact(
  ex: Executor,
  params: {
    orgId: string;
    projectId?: string | null;
    kind: string;
    path: string;
    sha256: string;
    sizeBytes: number;
    mime?: string | null;
    version?: number | null;
    createdByRunId?: string | null;
  },
): Promise<ArtifactRow> {
  const row: ArtifactRow = {
    id: uuidv7(),
    orgId: params.orgId,
    projectId: params.projectId ?? null,
    kind: params.kind,
    path: params.path,
    sha256: params.sha256,
    sizeBytes: params.sizeBytes,
    mime: params.mime ?? null,
    version: params.version ?? null,
    createdByRunId: params.createdByRunId ?? null,
    createdAt: new Date(),
  };
  await ex.insert(artifacts).values(row);
  return row;
}

export async function getArtifact(ex: Executor, id: string): Promise<ArtifactRow | null> {
  const rows = await ex.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listArtifacts(ex: Executor, projectId: string): Promise<ArtifactRow[]> {
  return ex.select().from(artifacts).where(eq(artifacts.projectId, projectId)).orderBy(desc(artifacts.createdAt));
}
