import { describe, expect, it } from 'vitest';

import { ForbiddenError, NotFoundError } from '../src/core/errors/app-error.js';
import {
  authorizeMembership,
  WorkspaceAccess,
  WorkspaceRole,
  type Membership,
} from '../src/modules/workspaces/index.js';
import { createWorkspaceBodySchema } from '../src/modules/workspaces/workspace.validators.js';
import { WorkspaceService } from '../src/modules/workspaces/workspace.service.js';
import { InMemoryWorkspaceRepository } from './helpers.js';

describe('createWorkspaceBodySchema', () => {
  const parse = (body: unknown) => createWorkspaceBodySchema.safeParse(body);
  const messages = (body: unknown) => {
    const result = parse(body);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it('trims and NFC-normalizes the name', () => {
    expect(parse({ name: '  Platform Team  ' }).data).toEqual({ name: 'Platform Team' });
    expect(parse({ name: 'Café' }).data?.name).toBe('Café');
  });

  it('accepts names at the boundaries (1 and 100 characters)', () => {
    expect(parse({ name: 'x' }).success).toBe(true);
    expect(parse({ name: 'x'.repeat(100) }).success).toBe(true);
  });

  it.each([
    ['missing', {}, 'Name is required'],
    ['empty', { name: '' }, 'Name is required'],
    ['only whitespace', { name: '     ' }, 'Name is required'],
    ['too long', { name: 'x'.repeat(101) }, 'Name must be at most 100 characters'],
    ['control character', { name: 'Team\u0000X' }, 'Name must not contain control characters'],
    ['newline inside', { name: 'Team\nX' }, 'Name must not contain control characters'],
    ['not a string', { name: 42 }, 'Name must be a string'],
  ])('rejects a %s name', (_label, body, message) => {
    expect(messages(body)).toEqual([message]);
  });

  it.each(['ownerId', 'userId', 'role', 'id', 'members'])(
    'rejects the client-supplied field %s',
    (field) => {
      const result = parse({ name: 'Team', [field]: 'x' });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(field);
    },
  );
});

describe('WorkspaceService.create', () => {
  it('makes the given (session) user the OWNER', async () => {
    const repo = new InMemoryWorkspaceRepository();
    const result = await new WorkspaceService(repo, new WorkspaceAccess(repo)).create({
      userId: 'user-1',
      name: 'Team',
    });

    expect(result.membership).toEqual({
      workspaceId: result.workspace.id,
      userId: 'user-1',
      role: 'OWNER',
    });
    expect(repo.members).toHaveLength(1);
  });
});

describe('workspace authorization (deny by default)', () => {
  const owner: Membership = { workspaceId: 'w', userId: 'u', role: WorkspaceRole.OWNER };
  const member: Membership = { ...owner, role: WorkspaceRole.MEMBER };

  it('treats "no membership" as not found, so existence is not revealed', () => {
    expect(() => authorizeMembership(null, [WorkspaceRole.OWNER])).toThrow(NotFoundError);
  });

  it('rejects members whose role is not allowed', () => {
    expect(() => authorizeMembership(member, [WorkspaceRole.OWNER])).toThrow(ForbiddenError);
    expect(() => authorizeMembership(member, [])).toThrow(ForbiddenError);
  });

  it('allows permitted roles', () => {
    expect(authorizeMembership(owner, [WorkspaceRole.OWNER])).toBe(owner);
    expect(authorizeMembership(member, [WorkspaceRole.OWNER, WorkspaceRole.MEMBER])).toBe(member);
  });

  it('WorkspaceAccess looks up the caller’s own membership only', async () => {
    const repo = new InMemoryWorkspaceRepository();
    const { workspace } = await repo.createWithOwner({ name: 'Team', ownerId: 'alice' });
    const access = new WorkspaceAccess(repo);

    await expect(access.requireMembership(workspace.id, 'alice')).resolves.toMatchObject({
      role: 'OWNER',
    });
    await expect(access.requireMembership(workspace.id, 'bob')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(access.requireMembership('unknown-id', 'alice')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
