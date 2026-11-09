import type { DatabaseClient } from '../../infrastructure/database/prisma.js';

/** Data-access contract for health checks; lets the service stay DB-agnostic. */
export interface HealthRepository {
  pingDatabase(): Promise<void>;
}

export class PrismaHealthRepository implements HealthRepository {
  constructor(private readonly db: DatabaseClient) {}

  async pingDatabase(): Promise<void> {
    await this.db.$queryRaw`SELECT 1`;
  }
}
