import { BadRequestError } from '../../core/errors/app-error.js';

/**
 * Opaque cursor for GET …/tasks/:taskId/activities (created_at ASC, id ASC),
 * **bound to its task**: a cursor issued for one task is rejected (400) when
 * used with another.
 */
export interface ActivityCursor {
  createdAt: Date;
  id: string;
}

const PREFIX = 'a1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Milliseconds since the epoch: the column is timestamptz(3), so this is exact.
const EPOCH_MS = /^(0|[1-9][0-9]{0,15})$/;

export function encodeActivityCursor(taskId: string, { createdAt, id }: ActivityCursor): string {
  return Buffer.from(`${PREFIX}${taskId}|${createdAt.getTime()}|${id}`, 'utf8').toString(
    'base64url',
  );
}

/** Returns the position to continue after; malformed or foreign cursors are a 400. */
export function decodeActivityCursor(cursor: string, taskId: string): ActivityCursor {
  const decoded = /^[A-Za-z0-9_-]+$/.test(cursor)
    ? Buffer.from(cursor, 'base64url').toString('utf8')
    : '';
  const [forTask = '', ms = '', id = '', ...rest] = decoded.startsWith(PREFIX)
    ? decoded.slice(PREFIX.length).split('|')
    : [];
  const createdAt = new Date(EPOCH_MS.test(ms) ? Number(ms) : Number.NaN);
  if (
    rest.length > 0 ||
    forTask !== taskId ||
    !UUID.test(id) ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new BadRequestError('Invalid pagination cursor', [
      { location: 'query', path: 'cursor', message: 'Invalid cursor' },
    ]);
  }
  return { createdAt, id };
}
