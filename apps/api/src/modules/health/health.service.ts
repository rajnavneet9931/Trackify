import type { Logger } from '../../config/logger.js';
import {
  DatabaseTimeoutError,
  summarizeDatabaseError,
} from '../../infrastructure/database/database-errors.js';
import type { HealthRepository } from './health.repository.js';

export type DependencyStatus = 'up' | 'down';

export interface LivenessReport {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: { database: DependencyStatus };
  timestamp: string;
}

export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly dbTimeoutMs = 5000,
  ) {}

  /** Liveness: the process is up and serving requests. No dependency checks. */
  getLiveness(): LivenessReport {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: dependencies required to serve traffic are reachable. */
  async getReadiness(): Promise<ReadinessReport> {
    const database = await this.checkDatabase();

    return {
      status: database === 'up' ? 'ready' : 'not_ready',
      checks: { database },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Never throws: failures are reduced to 'down' for the client, while the
   * cause is logged server-side without connection details.
   */
  private async checkDatabase(): Promise<DependencyStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DatabaseTimeoutError('Database ping', this.dbTimeoutMs)),
        this.dbTimeoutMs,
      );
    });

    try {
      await Promise.race([this.repository.pingDatabase(), timeout]);
      return 'up';
    } catch (error) {
      this.logger.warn({ db: summarizeDatabaseError(error) }, 'Readiness: database unavailable');
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
