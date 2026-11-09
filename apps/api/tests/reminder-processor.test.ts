import { describe, expect, it, vi } from 'vitest';

import {
  ReminderDeliveryError,
  ReminderProcessor,
  type ClaimedReminder,
  type ReminderRepository,
} from '../src/modules/reminders/index.js';

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A fake queue of due reminder IDs; claiming removes one (like a committed SENT). */
function fakeRepository(ids: string[], failing = new Set<string>()) {
  const queue = [...ids];
  const failures: string[] = [];
  const repo: ReminderRepository = {
    processNext: vi.fn(async (_now, skip, deliver) => {
      const id = queue.find((candidate) => !skip.includes(candidate));
      if (!id) return null;
      const reminder: ClaimedReminder = { id, taskId: 't', remindAt: new Date(), recipientId: 'u' };
      if (failing.has(id)) throw new ReminderDeliveryError(id, new Error('boom'));
      await deliver(reminder);
      queue.splice(queue.indexOf(id), 1);
      return { id, outcome: 'SENT' as const };
    }),
    recordFailure: vi.fn(async (id) => {
      failures.push(id);
    }),
  };
  return { repo, queue, failures };
}

describe('ReminderProcessor', () => {
  it('delivers due reminders and stops when none are left', async () => {
    const { repo, queue } = fakeRepository(['a', 'b', 'c']);
    const result = await new ReminderProcessor(repo, silent).runOnce();
    expect(result).toEqual({ sent: 3, failed: 0, cancelled: 0, errors: 0 });
    expect(queue).toEqual([]);
  });

  it('shares a run in progress instead of starting an overlapping one', async () => {
    const { repo } = fakeRepository(['a', 'b']);
    const processor = new ReminderProcessor(repo, silent);
    const [first, second] = await Promise.all([processor.runOnce(), processor.runOnce()]);
    expect(first).toBe(second);
    expect(first.sent).toBe(2);
  });

  it('respects the batch size so one run stays short', async () => {
    const { repo, queue } = fakeRepository(['a', 'b', 'c']);
    await new ReminderProcessor(repo, silent, { batchSize: 2 }).runOnce();
    expect(queue).toEqual(['c']);
  });

  it('records a failed delivery and skips that reminder for the rest of the run', async () => {
    const { repo, failures, queue } = fakeRepository(['bad', 'good'], new Set(['bad']));
    const result = await new ReminderProcessor(repo, silent, { maxAttempts: 3 }).runOnce();
    expect(result).toMatchObject({ sent: 1, errors: 1 });
    expect(failures).toEqual(['bad']);
    expect(repo.recordFailure).toHaveBeenCalledWith('bad', 'boom', 3);
    expect(queue).toEqual(['bad']); // still pending: retried on a later run
  });

  it('stops a run quietly when the database is unavailable', async () => {
    const repo: ReminderRepository = {
      processNext: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
      recordFailure: vi.fn(),
    };
    const result = await new ReminderProcessor(repo, silent).runOnce();
    expect(result).toEqual({ sent: 0, failed: 0, cancelled: 0, errors: 0 });
    expect(repo.recordFailure).not.toHaveBeenCalled();
  });

  it('start() runs immediately (catch-up), then on the interval; 0 disables it; stop() ends it', async () => {
    vi.useFakeTimers();
    try {
      const { repo } = fakeRepository([]);
      const processor = new ReminderProcessor(repo, silent);
      processor.start(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(repo.processNext).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(repo.processNext).toHaveBeenCalledTimes(4);
      await processor.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(repo.processNext).toHaveBeenCalledTimes(4);

      const disabled = fakeRepository([]);
      new ReminderProcessor(disabled.repo, silent).start(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(disabled.repo.processNext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
