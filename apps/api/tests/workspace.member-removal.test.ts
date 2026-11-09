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

describe('DELETE /api/v1/workspaces/:workspaceId/members/:userId', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let other: Account;
  let outsider: Account;
  let ws: string;

  const remove = (requester: Account, workspaceId: string, userId: string) =>
    request(ctx.app)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${userId}`)
      .set('Cookie', requester.cookie)
      .set('X-CSRF-Token', requester.csrfToken);
  const rows = () => ctx.workspaces.members.map((m) => `${m.userId}:${m.role}`).sort();

  beforeEach(async () => {
    ctx = await setup();
    owner = await ctx.signUp('owner@example.com');
    member = await ctx.signUp('member@example.com');
    other = await ctx.signUp('other@example.com');
    outsider = await ctx.signUp('outsider@example.com');
    ws = (
      await request(ctx.app)
        .post('/api/v1/workspaces')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Token', owner.csrfToken)
        .send({ name: 'Team' })
    ).body.data.workspace.id;
    ctx.workspaces.addMember(ws, member.id);
    ctx.workspaces.addMember(ws, other.id);
  });

  it('owner removes a MEMBER: 200 { removed: true }, only that row goes', async () => {
    const res = await remove(owner, ws, member.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { removed: true } });
    expect(rows()).toEqual([`${other.id}:MEMBER`, `${owner.id}:OWNER`].sort());
  });

  it.each([
    ['a MEMBER requester', () => remove(member, ws, other.id), 403, 'FORBIDDEN'],
    ['an outsider', () => remove(outsider, ws, member.id), 404, 'NOT_FOUND'],
    ['an unknown workspace', () => remove(owner, UNKNOWN, member.id), 404, 'NOT_FOUND'],
    ['a target with no membership', () => remove(owner, ws, outsider.id), 404, 'NOT_FOUND'],
    ['the requester themselves', () => remove(owner, ws, owner.id), 409, 'CONFLICT'],
  ])('rejects %s', async (_label, call, status, code) => {
    const before = rows();
    const res = await call();

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(rows()).toEqual(before);
  });

  it('never removes an OWNER', async () => {
    ctx.workspaces.addMember(ws, outsider.id, WorkspaceRole.OWNER);
    const before = rows();

    const res = await remove(owner, ws, outsider.id);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Workspace owners cannot be removed.');
    expect(rows()).toEqual(before);
  });

  it.each([
    ['malformed workspace id', () => remove(owner, 'nope', member.id)],
    ['malformed user id', () => remove(owner, ws, 'nope')],
    ['a query parameter', () => remove(owner, ws, member.id).query({ force: 'true' })],
    ['a body field', () => remove(owner, ws, member.id).send({ role: 'OWNER' })],
  ])('rejects %s with 400', async (_label, call) => {
    const before = rows();
    expect((await call()).status).toBe(400);
    expect(rows()).toEqual(before);
  });

  it('requires a session, the CSRF token and an allowed Origin', async () => {
    const before = rows();
    const path = `/api/v1/workspaces/${ws}/members/${member.id}`;

    expect((await request(ctx.app).delete(path)).status).toBe(401);
    expect((await request(ctx.app).delete(path).set('Cookie', owner.cookie)).status).toBe(403);
    expect((await remove(owner, ws, member.id).set('Origin', 'https://evil.example')).status).toBe(
      403,
    );
    expect(rows()).toEqual(before);
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    const failing = await setup(true);
    const account = await failing.signUp('carol@example.com');
    const res = await request(failing.app)
      .delete(`/api/v1/workspaces/${UNKNOWN}/members/${UNKNOWN}`)
      .set('Cookie', account.cookie)
      .set('X-CSRF-Token', account.csrfToken);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
  });
});
