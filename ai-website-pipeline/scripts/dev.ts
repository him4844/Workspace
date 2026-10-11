/**
 * Local development runner: API + worker in one terminal.
 *
 *   npm run dev
 *
 * With the default PGlite driver the worker loop is embedded in the API process —
 * PGlite is a single-process embedded database and refuses a second process on the
 * same data dir. With DB_DRIVER=postgres the two run as separate processes, exactly
 * like the containers on the server.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger, loadConfig } from '@wpp/infra';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

interface Managed {
  name: string;
  child: ChildProcess;
}

const processes: Managed[] = [];

function start(name: string, args: string[]): void {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });
  processes.push({ name, child });
  child.on('exit', (code, signal) => {
    logger.warn({ name, code, signal }, 'child process exited');
    if (!shuttingDown) void shutdown(`child ${name} exited`);
  });
  logger.info({ name, pid: child.pid }, 'started');
}

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'stopping dev processes');
  for (const { child } of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 1500);
}

async function main(): Promise<void> {
  logger.info(
    {
      db: config.DB_DRIVER,
      dataDir: config.DB_DRIVER === 'pglite' ? config.PGLITE_DIR : undefined,
      simulator: config.CHANNEL_SIMULATOR_ENABLED,
    },
    'dev mode: api + worker',
  );

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (config.DB_DRIVER === 'pglite' || config.EMBEDDED_WORKER) {
    logger.info('pglite/embedded mode: the API process also runs the worker loop');
    start('api+worker', ['node_modules/tsx/dist/cli.mjs', 'apps/api/src/index.ts']);
    return;
  }

  start('api', ['node_modules/tsx/dist/cli.mjs', 'apps/api/src/index.ts']);
  start('worker', ['node_modules/tsx/dist/cli.mjs', 'apps/worker/src/index.ts']);
}

main().catch((err) => {
  // stderr on purpose: this is the dev runner's own fatal path, and it may have failed while
  // starting the child processes whose output it forwards.
  console.error('dev runner failed:', err);
  process.exit(1);
});
