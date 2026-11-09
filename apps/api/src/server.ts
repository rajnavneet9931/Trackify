import type { Server } from 'node:http';

import { createApp } from './app.js';
import { ConfigError, loadConfig, type AppConfig } from './config/env.js';
import { createLogger, type Logger } from './config/logger.js';
import { summarizeDatabaseError } from './infrastructure/database/database-errors.js';
import { createDatabaseClient, type DatabaseClient } from './infrastructure/database/prisma.js';
import { PrismaReminderRepository, ReminderProcessor } from './modules/reminders/index.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Logs whether the database is reachable at boot. Deliberately non-fatal: the
 * API keeps serving liveness, readiness reports 503 until the database is back,
 * and the pool reconnects on its own.
 */
async function checkDatabaseOnStartup(db: DatabaseClient, logger: Logger): Promise<void> {
  const startedAt = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    logger.info({ durationMs: Date.now() - startedAt }, 'Database connection verified');
  } catch (error) {
    logger.warn(
      { db: summarizeDatabaseError(error) },
      'Database unreachable at startup; readiness will report not_ready until it recovers',
    );
  }
}

function bootstrap(): void {
  const config = readConfigOrExit();
  const logger = createLogger(config);
  const db = createDatabaseClient(config.database, {
    onPoolError: (err) =>
      logger.error({ db: summarizeDatabaseError(err) }, 'Database connection error'),
  });
  const app = createApp({ config, logger, db });
  // Background reminder delivery (in-app). Safe on several instances; 0 disables it.
  const reminders = new ReminderProcessor(new PrismaReminderRepository(db), logger);

  const server: Server = app.listen(config.port, config.host, () => {
    logger.info(`Trackify API listening on http://${config.host}:${config.port}`);
    void checkDatabaseOnStartup(db, logger);
    // Starts with an immediate run, which also delivers reminders missed while down.
    reminders.start(config.reminders.pollIntervalMs);
  });

  server.on('error', (error) => {
    logger.fatal({ err: error }, 'HTTP server failed to start');
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(async (closeError) => {
      try {
        await reminders.stop();
        await db.$disconnect();
      } catch (error) {
        logger.error({ err: error }, 'Error disconnecting from database');
      }
      if (closeError) logger.error({ err: closeError }, 'Error closing HTTP server');
      logger.info('Shutdown complete');
      process.exit(closeError ? 1 : exitCode);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    shutdown('uncaughtException', 1);
  });
}

bootstrap();
