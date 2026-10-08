/**
 * Artifact store (SPEC §45, D-019): the database row is the source of truth, the file on
 * disk is a regenerable projection. `data/` is runtime, never source (docs/11 §2).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export interface ArtifactWriteResult {
  path: string;      // repo-relative path stored in the artifacts table
  sha256: string;
  sizeBytes: number;
}

export interface ArtifactStoreOptions {
  /** filesystem root for artifacts, e.g. `data` */
  rootDir?: string;
}

/**
 * Write an artifact under `<root>/projects/<projectId>/<kind>/<version>.<ext>`.
 * Deterministic location: re-running a phase overwrites only that version's file.
 */
export function writeArtifact(
  params: {
    projectId: string;
    kind: string;
    version: number;
    content: string;
    extension?: string;
  },
  options: ArtifactStoreOptions = {},
): ArtifactWriteResult {
  const root = options.rootDir ?? 'data';
  const extension = params.extension ?? 'md';
  const relPath = join('projects', params.projectId, params.kind, `v${params.version}.${extension}`);
  const absPath = join(root, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, params.content, 'utf8');
  const bytes = readFileSync(absPath);
  return {
    path: join(root, relPath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  };
}

/** Read an artifact back (used by the inspector API and by later phases). */
export function readArtifact(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function artifactRelativePath(fromDir: string, target: string): string {
  return relative(fromDir, target);
}
