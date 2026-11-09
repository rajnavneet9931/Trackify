import { BadRequestError } from '../../core/errors/app-error.js';

/**
 * Opaque cursor for GET /workspaces/:id/projects (created_at DESC, id DESC).
 * Unlike the workspace/member cursors, which hold a UUIDv7 alone, it carries
 * the position's timestamp and id, because the list is ordered by created_at
 * first. Versioned prefix `p1:`, so cursors from other lists are rejected.
 *
 * The cursor only sets a position; the workspace filter is applied separately
 * from the authorized route parameter, so a cursor taken from another
 * workspace (or edited by hand) can never return that workspace's projects.
 */
export interface ProjectCursor {
  createdAt: Date;
  id: string;
}

const PREFIX = 'p1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Milliseconds since the epoch: the column is timestamptz(3), so this is exact.
const EPOCH_MS = /^(0|[1-9][0-9]{0,15})$/;

export function encodeProjectCursor({ createdAt, id }: ProjectCursor): string {
  return Buffer.from(`${PREFIX}${createdAt.getTime()}|${id}`, 'utf8').toString('base64url');
}

/** Returns the position to continue after; any malformed cursor is a 400. */
export function decodeProjectCursor(cursor: string): ProjectCursor {
  const decoded = /^[A-Za-z0-9_-]+$/.test(cursor)
    ? Buffer.from(cursor, 'base64url').toString('utf8')
    : '';
  const [ms = '', id = '', ...rest] = decoded.startsWith(PREFIX)
    ? decoded.slice(PREFIX.length).split('|')
    : [];
  const createdAt = new Date(EPOCH_MS.test(ms) ? Number(ms) : Number.NaN);
  if (rest.length > 0 || !UUID.test(id) || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestError('Invalid pagination cursor', [
      { location: 'query', path: 'cursor', message: 'Invalid cursor' },
    ]);
  }
  return { createdAt, id };
}
