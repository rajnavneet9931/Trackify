import type { Router } from 'express';

import type { Logger } from '../../config/logger.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { HealthController } from './health.controller.js';
import { PrismaHealthRepository, type HealthRepository } from './health.repository.js';
import { createHealthRouter } from './health.routes.js';
import { HealthService } from './health.service.js';

export interface HealthModuleDeps {
  db: DatabaseClient;
  logger: Logger;
  dbTimeoutMs: number;
  /** Override for tests. Defaults to the Prisma-backed implementation. */
  repository?: HealthRepository | undefined;
}

/** Composition root for the health module: wires repository → service → controller → router. */
export function createHealthModule({
  db,
  logger,
  dbTimeoutMs,
  repository,
}: HealthModuleDeps): Router {
  const service = new HealthService(
    repository ?? new PrismaHealthRepository(db),
    logger.child({ module: 'health' }),
    dbTimeoutMs,
  );
  return createHealthRouter(new HealthController(service));
}
