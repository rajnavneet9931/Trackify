import { BadRequestError } from '../../core/errors/app-error.js';

/**
 * Opaque pagination cursors. Clients must treat them as tokens: the format is
 * versioned so it can change without breaking callers. A cursor only sets a
 * position in a list whose filters (user, workspace) are applied separately,
 * so a cursor taken from someone else reveals nothing. Each list has its own
 * prefix, so a cursor from one list is rejected by another.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cursorCodec(prefix: string) {
  return {
    encode(membershipId: string): string {
      return Buffer.from(`${prefix}${membershipId}`, 'utf8').toString('base64url');
    },
    /** Returns the membership ID to continue after; any malformed cursor is a 400. */
    decode(cursor: string): string {
      const decoded = /^[A-Za-z0-9_-]+$/.test(cursor)
        ? Buffer.from(cursor, 'base64url').toString('utf8')
        : '';
      const id = decoded.startsWith(prefix) ? decoded.slice(prefix.length) : '';
      if (!UUID.test(id)) {
        throw new BadRequestError('Invalid pagination cursor', [
          { location: 'query', path: 'cursor', message: 'Invalid cursor' },
        ]);
      }
      return id;
    },
  };
}

/** GET /workspaces (the caller's memberships, newest first). */
const workspaceListCursor = cursorCodec('m1:');
/** GET /workspaces/:id/members (a workspace's memberships, oldest first). */
const memberListCursor = cursorCodec('wm1:');

export const encodeWorkspaceCursor = workspaceListCursor.encode;
export const decodeWorkspaceCursor = workspaceListCursor.decode;
export const encodeMemberCursor = memberListCursor.encode;
export const decodeMemberCursor = memberListCursor.decode;
