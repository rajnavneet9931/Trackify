import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceRole } from '../src/modules/workspaces/index.js';
import {
  buildTestApp,
  InMemorySessionRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableWorkspaceRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const UNKNOWN = '01a14e7b-cea3-700d-aeda-0000000000ff';

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

async function setup(failing = false) {
  const users = new InMemoryUserRepository();
  const workspaces = new InMemoryWorkspaceRepository(users);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: new InMemorySessionRepository(users),
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
  });
  const signUp = async (email: string): Promise<Account> => {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return {
      id: registered.body.data.user.id,
      cookie: ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!,
      csrfToken: login.body.data.csrfToken,
    };
  };
  return { app, workspaces, signUp };
}

describe('PATCH /api/v1/workspaces/:workspaceId/members/:userId/role', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;

  const patch = (requester: Account, workspaceId: string, userId: string, body: unknown) =>
    request(ctx.app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${userId}/role`)
      .set('Cookie', requester.cookie)
      .set('X-CSRF-Token', requester.csrfToken)
      .send(body as object);
  const rows = () =>
    ctx.workspaces.members
      .filter((m) => m.workspaceId === ws)
      .map((m) => `${m.userId}:${m.role}`)
      .sort();
  const roleOf = (userId: string) =>
    ctx.workspaces.members.find((m) => m.workspaceId === ws && m.userId === userId)?.role;

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    ws = (
      await request(ctx.app)
        .post('/api/v1/workspaces')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Token', owner.csrfToken)
        .send({ name: 'Team' })
    ).body.data.workspace.id;
    ctx.workspaces.addMember(ws, member.id);
  });

  it('promotes a MEMBER to OWNER', async () => {
    const res = await patch(owner, ws, member.id, { role: 'OWNER' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { member: { userId: member.id, role: 'OWNER' }, changed: true },
    });
    expect(roleOf(member.id)).toBe('OWNER');
  });

  it('demotes an OWNER when another owner remains', async () => {
    await patch(owner, ws, member.id, { role: 'OWNER' });

    const res = await patch(owner, ws, member.id, { role: 'MEMBER' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ member: { userId: member.id, role: 'MEMBER' }, changed: true });
    expect(roleOf(member.id)).toBe('MEMBER');
  });

  it('lets an owner demote themselves when another owner remains', async () => {
    await patch(owner, ws, member.id, { role: 'OWNER' });

    const res = await patch(owner, ws, owner.id, { role: 'MEMBER' });

    expect(res.status).toBe(200);
    expect(roleOf(owner.id)).toBe('MEMBER');
  });

  it('never demotes the last owner (409), including themselves', async () => {
    const before = rows();
    const res = await patch(owner, ws, owner.id, { role: 'MEMBER' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'A workspace must have at least one owner.',
    });
    expect(rows()).toEqual(before);
  });

  it('treats setting the current role as an idempotent no-op', async () => {
    const before = rows();
    const asMember = await patch(owner, ws, member.id, { role: 'MEMBER' });
    const lastOwnerAsOwner = await patch(owner, ws, owner.id, { role: 'OWNER' });

    expect(asMember.status).toBe(200);
    expect(asMember.body.data).toEqual({
      member: { userId: member.id, role: 'MEMBER' },
      changed: false,
    });
    expect(lastOwnerAsOwner.status).toBe(200);
    expect(lastOwnerAsOwner.body.data.changed).toBe(false);
    expect(rows()).toEqual(before);
  });

  it.each([
    ['a MEMBER requester', () => patch(member, ws, owner.id, { role: 'MEMBER' }), 403, 'FORBIDDEN'],
    ['an outsider', () => patch(outsider, ws, member.id, { role: 'OWNER' }), 404, 'NOT_FOUND'],
    [
      'an unknown workspace',
      () => patch(owner, UNKNOWN, member.id, { role: 'OWNER' }),
      404,
      'NOT_FOUND',
    ],
    ['an unknown target', () => patch(owner, ws, outsider.id, { role: 'OWNER' }), 404, 'NOT_FOUND'],
  ])('rejects %s', async (_label, call, status, code) => {
    const before = rows();
    const res = await call();

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(rows()).toEqual(before);
  });

  it('cannot promote themselves as a MEMBER (403)', async () => {
    const res = await patch(member, ws, member.id, { role: 'OWNER' });
    expect(res.status).toBe(403);
    expect(roleOf(member.id)).toBe('MEMBER');
  });

  it('uses the same 404 for outsiders and unknown workspaces', async () => {
    const a = await patch(outsider, ws, member.id, { role: 'OWNER' });
    const b = await patch(owner, UNKNOWN, member.id, { role: 'OWNER' });
    expect({ ...a.body.error, requestId: 0 }).toEqual({ ...b.body.error, requestId: 0 });
    expect(a.body.error.message).toBe('Workspace not found');
  });

  it.each([
    ['an invalid role', { role: 'ADMIN' }],
    ['a lower-case role', { role: 'owner' }],
    ['a missing role', {}],
    ['a non-string role', { role: 1 }],
    ['an extra field', { role: 'OWNER', userId: UNKNOWN }],
    ['a workspaceId field', { role: 'OWNER', workspaceId: UNKNOWN }],
  ])('rejects %s with 400', async (_label, body) => {
    const before = rows();
    const res = await patch(owner, ws, member.id, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(rows()).toEqual(before);
  });

  it.each([
    ['malformed workspace id', () => patch(owner, 'nope', member.id, { role: 'OWNER' })],
    ['malformed user id', () => patch(owner, ws, 'nope', { role: 'OWNER' })],
    [
      'a query parameter',
      () => patch(owner, ws, member.id, { role: 'OWNER' }).query({ force: 'true' }),
    ],
  ])('rejects %s with 400', async (_label, call) => {
    expect((await call()).status).toBe(400);
    expect(roleOf(member.id)).toBe('MEMBER');
  });

  it('rejects non-JSON bodies with 415', async () => {
    const res = await patch(owner, ws, member.id, 'role=OWNER').type('form');
    expect(res.status).toBe(415);
  });

  it('requires a session, the CSRF token and an allowed Origin', async () => {
    const path = `/api/v1/workspaces/${ws}/members/${member.id}/role`;

    expect((await request(ctx.app).patch(path).send({ role: 'OWNER' })).status).toBe(401);
    expect(
      (await request(ctx.app).patch(path).set('Cookie', owner.cookie).send({ role: 'OWNER' }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app)
          .patch(path)
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Token', member.csrfToken)
          .send({ role: 'OWNER' })
      ).status,
    ).toBe(403);
    expect(
      (await patch(owner, ws, member.id, { role: 'OWNER' }).set('Origin', 'https://evil.example'))
        .status,
    ).toBe(403);
    expect(roleOf(member.id)).toBe('MEMBER');
  });

  it('changes the role only in the specified workspace', async () => {
    const other = (
      await request(ctx.app)
        .post('/api/v1/workspaces')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Token', owner.csrfToken)
        .send({ name: 'Other' })
    ).body.data.workspace.id;
    ctx.workspaces.addMember(other, member.id);

    await patch(owner, ws, member.id, { role: 'OWNER' });

    const roleIn = (workspaceId: string) =>
      ctx.workspaces.members.find((m) => m.workspaceId === workspaceId && m.userId === member.id)
        ?.role;
    expect(roleIn(ws)).toBe(WorkspaceRole.OWNER);
    expect(roleIn(other)).toBe(WorkspaceRole.MEMBER);
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    const failing = await setup(true);
    const account = await failing.signUp('carol@example.com');
    const res = await request(failing.app)
      .patch(`/api/v1/workspaces/${UNKNOWN}/members/${UNKNOWN}/role`)
      .set('Cookie', account.cookie)
      .set('X-CSRF-Token', account.csrfToken)
      .send({ role: 'OWNER' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
  });
});
