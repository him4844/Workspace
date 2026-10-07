import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '@wpp/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
  '@wpp/infra': fileURLToPath(new URL('./packages/infra/src/index.ts', import.meta.url)),
  '@wpp/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
  '@wpp/channels': fileURLToPath(new URL('./packages/channels/src/index.ts', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // PGlite instances are memory-heavy and each file boots its own database:
    // run the files one after another inside a single pool.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ['default'],
  },
});
