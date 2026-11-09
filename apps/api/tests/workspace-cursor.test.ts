import { describe, expect, it } from 'vitest';

import { BadRequestError } from '../src/core/errors/app-error.js';
import {
  decodeMemberCursor,
  decodeWorkspaceCursor,
  encodeMemberCursor,
  encodeWorkspaceCursor,
} from '../src/modules/workspaces/workspace-cursor.js';
import { workspaceParamsSchema } from '../src/modules/workspaces/workspace.validators.js';

const ID = '01a14e7b-cea3-700d-aeda-085cd44166ed';

describe('pagination cursors', () => {
  it('round-trip for each list', () => {
    expect(decodeWorkspaceCursor(encodeWorkspaceCursor(ID))).toBe(ID);
    expect(decodeMemberCursor(encodeMemberCursor(ID))).toBe(ID);
  });

  it('are opaque base64url tokens', () => {
    expect(encodeMemberCursor(ID)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeMemberCursor(ID)).not.toContain(ID);
  });

  it('cannot be used across lists', () => {
    expect(() => decodeMemberCursor(encodeWorkspaceCursor(ID))).toThrow(BadRequestError);
    expect(() => decodeWorkspaceCursor(encodeMemberCursor(ID))).toThrow(BadRequestError);
  });

  it.each(['', '!!!', 'bm90IGEgY3Vyc29y', Buffer.from('wm1:not-a-uuid').toString('base64url')])(
    'rejects malformed cursor %j',
    (cursor) => {
      expect(() => decodeMemberCursor(cursor)).toThrow('Invalid pagination cursor');
    },
  );
});

describe('workspaceParamsSchema', () => {
  it('accepts UUIDs and lower-cases them', () => {
    expect(workspaceParamsSchema.parse({ workspaceId: ID.toUpperCase() })).toEqual({
      workspaceId: ID,
    });
  });

  it.each(['123', 'not-a-uuid', `${ID}x`, "' OR 1=1 --"])('rejects %j', (workspaceId) => {
    expect(workspaceParamsSchema.safeParse({ workspaceId }).success).toBe(false);
  });
});
