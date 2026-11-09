import { describe, expect, it } from 'vitest';

import {
  DatabaseTimeoutError,
  isDatabaseUnavailableError,
  summarizeDatabaseError,
} from '../src/infrastructure/database/database-errors.js';

/** Shape of the error Prisma 7 throws via @prisma/adapter-pg (captured from a real failure). */
function prismaDriverError(cause: Record<string, unknown>) {
  return Object.assign(new Error('Invalid `prisma.$queryRaw()` invocation: Raw query failed.'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { name: 'DriverAdapterError', cause } },
  });
}

describe('isDatabaseUnavailableError', () => {
  it.each([
    ['unreachable host', prismaDriverError({ kind: 'DatabaseNotReachable', host: 'db' })],
    [
      'bad credentials',
      prismaDriverError({ kind: 'AuthenticationFailed', originalCode: '28P01', user: 'x' }),
    ],
    ['too many connections', prismaDriverError({ kind: 'TooManyConnections' })],
    ['pg connect timeout', new Error('Connection terminated due to connection timeout')],
    ['socket refused', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['probe timeout', new DatabaseTimeoutError('Database ping', 100)],
    ['init error', Object.assign(new Error('init'), { name: 'PrismaClientInitializationError' })],
    // Shapes captured from Prisma 7.10 + adapter-pg (P2039 for a lock timeout).
    ['lock timeout', prismaDriverError({ kind: 'postgres', originalCode: '55P03', code: '55P03' })],
    ['serialization failure', prismaDriverError({ kind: 'postgres', originalCode: '40001' })],
    ['deadlock', prismaDriverError({ kind: 'postgres', originalCode: '40P01' })],
    // Captured under load (Step 17 verify): interactive transaction couldn't start in maxWait.
    [
      'transaction start timeout',
      Object.assign(
        new Error('Transaction API error: Unable to start a transaction in the given time.'),
        { name: 'PrismaClientKnownRequestError', code: 'P2028' },
      ),
    ],
    [
      'pool wait timeout',
      Object.assign(new Error('Timed out fetching a new connection from the connection pool.'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2024',
      }),
    ],
  ])('treats %s as unavailable', (_label, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(true);
  });

  it.each([
    ['unique violation', prismaDriverError({ kind: 'UniqueConstraintViolation' })],
    ['other postgres error', prismaDriverError({ kind: 'postgres', originalCode: '22P02' })],
    [
      'other Prisma request error',
      Object.assign(new Error('Record not found'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2025',
      }),
    ],
    ['plain bug', new TypeError('x is undefined')],
    ['non-error', 'boom'],
  ])('does not treat %s as unavailable', (_label, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(false);
  });
});

describe('summarizeDatabaseError', () => {
  it('extracts kind and SQLSTATE from driver errors', () => {
    const summary = summarizeDatabaseError(
      prismaDriverError({
        kind: 'AuthenticationFailed',
        originalCode: '28P01',
        originalMessage: 'password authentication failed for user "app"',
      }),
    );

    expect(summary).toEqual({
      kind: 'AuthenticationFailed',
      code: '28P01',
      message: 'password authentication failed for user "app"',
    });
  });

  it('removes connection strings from messages', () => {
    const summary = summarizeDatabaseError(
      new Error('failed for postgresql://admin:hunter2@db.internal:5432/app (retrying)'),
    );

    expect(summary.message).toBe('failed for [redacted-url] (retrying)');
    expect(JSON.stringify(summary)).not.toContain('hunter2');
  });

  it('labels probe timeouts', () => {
    expect(summarizeDatabaseError(new DatabaseTimeoutError('Database ping', 50)).kind).toBe(
      'Timeout',
    );
  });
});
