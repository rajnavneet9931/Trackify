import type { Logger } from '../../config/logger.js';
import { summarizeDatabaseError } from '../../infrastructure/database/database-errors.js';
import {
  ReminderDeliveryError,
  type ClaimedReminder,
  type ReminderRepository,
} from './reminder.repository.js';

export interface ReminderRunResult {
  sent: number;
  failed: number;
  cancelled: number;
  /** Delivery attempts that threw (will be retried until the attempt limit). */
  errors: number;
}

export interface ReminderProcessorOptions {
  /**
   * Delivery side effect for a claimed reminder, run inside its transaction.
   * The in-app notification is always created by the repository in that
   * transaction; this is the seam for future channels such as email.
   */
  deliver?: (reminder: ClaimedReminder) => Promise<void>;
  /** At most this many reminders per run, so one run stays short. */
  batchSize?: number;
  /** Failed delivery attempts before a reminder is marked FAILED. */
  maxAttempts?: number;
  now?: () => Date;
}

/**
 * Delivers due task reminders, in process, without any queue or extra
 * infrastructure. Safe with any number of API instances: each reminder is
 * claimed with `FOR UPDATE SKIP LOCKED` and settled in that transaction, so it
 * is delivered exactly once. Reminders that came due while no instance was
 * running are simply picked up by the next run (they are still PENDING with
 * a past `remind_at`). Runs never overlap and never block HTTP requests (all
 * work is asynchronous I/O on the timer).
 */
export class ReminderProcessor {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<ReminderRunResult> | undefined;
  private readonly deliver: (reminder: ClaimedReminder) => Promise<void>;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly reminders: ReminderRepository,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>,
    options: ReminderProcessorOptions = {},
  ) {
    this.deliver = options.deliver ?? (async () => undefined);
    this.batchSize = options.batchSize ?? 50;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.now = options.now ?? (() => new Date());
  }

  /** Processes due reminders once. Concurrent calls share the run in progress. */
  runOnce(): Promise<ReminderRunResult> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<ReminderRunResult> {
    const result: ReminderRunResult = { sent: 0, failed: 0, cancelled: 0, errors: 0 };
    const skip: string[] = []; // reminders that failed in this run: retried next run
    const now = this.now();
    for (let i = 0; i < this.batchSize; i++) {
      try {
        const settled = await this.reminders.processNext(now, skip, this.deliver);
        if (!settled) break;
        if (settled.outcome === 'SENT') result.sent += 1;
        else if (settled.outcome === 'FAILED') result.failed += 1;
        else result.cancelled += 1;
      } catch (error) {
        if (!(error instanceof ReminderDeliveryError)) {
          // e.g. database unavailable: stop this run, try again on the next tick.
          this.logger.warn({ db: summarizeDatabaseError(error) }, 'Reminder run interrupted');
          break;
        }
        result.errors += 1;
        skip.push(error.reminderId);
        const message = summarizeDatabaseError(error.cause).message || 'Delivery failed';
        try {
          await this.reminders.recordFailure(error.reminderId, message, this.maxAttempts);
        } catch (recordError) {
          this.logger.error(
            { db: summarizeDatabaseError(recordError) },
            'Could not record reminder failure',
          );
        }
      }
    }
    if (result.sent + result.failed + result.cancelled + result.errors > 0) {
      this.logger.info({ reminders: result }, 'Reminder run finished');
    }
    return result;
  }

  /** Runs now (catching up missed reminders) and then every `intervalMs`. */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    const tick = () => {
      this.runOnce().catch((error: unknown) =>
        this.logger.error({ err: error }, 'Reminder run failed'),
      );
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref(); // never keeps the process alive on its own
  }

  /** Stops the timer and waits for a run in progress to finish. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}
