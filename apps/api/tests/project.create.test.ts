import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  InMemoryProjectRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableProjectRepository,
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
  const projects = new InMemoryProjectRepository();
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: new InMemorySessionRepository(users),
    workspaceRepository: failing ? unreachableWorkspaceRepository : workspaces,
    projectRepository: failing ? unreachableProjectRepository : projects,
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
  return { app, workspaces, projects, signUp };
}

describe('POST /api/v1/workspaces/:workspaceId/projects', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let ws: string;

  const create = (requester: Account, workspaceId: string, body: string | object) =>
    request(ctx.app)
      .post(`/api/v1/workspaces/${workspaceId}/projects`)
      .set('Cookie', requester.cookie)
      .set('X-CSRF-Token', requester.csrfToken)
      .send(body);

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

  it('owner creates a project: 201 with safe fields decided by the server', async () => {
    const res = await create(owner, ws, {
      name: '  Website Redesign  ',
      description: '  Redesign the company website  ',
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: {
        project: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          workspaceId: ws,
          name: 'Website Redesign',
          description: 'Redesign the company website',
          status: 'ACTIVE',
          createdById: owner.id,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      },
    });
    expect(ctx.projects.rows).toHaveLength(1);
    expect(ctx.projects.rows[0]).toMatchObject({ workspaceId: ws, createdById: owner.id });
  });

  it('lower-cases the workspace id from the route', async () => {
    const res = await create(owner, ws.toUpperCase(), { name: 'Upper' });
    expect(res.status).toBe(201);
    expect(res.body.data.project.workspaceId).toBe(ws);
  });

  it.each([
    ['missing', { name: 'A' }],
    ['null', { name: 'A', description: null }],
    ['empty', { name: 'A', description: '' }],
    ['whitespace-only', { name: 'A', description: '  \n ' }],
  ])('normalizes a %s description to null', async (_label, body) => {
    const res = await create(owner, ws, body);
    expect(res.status).toBe(201);
    expect(res.body.data.project.description).toBeNull();
  });

  it('accepts the length boundaries and keeps line breaks in descriptions', async () => {
    const res = await create(owner, ws, {
      name: 'n'.repeat(120),
      description: `line 1\nline 2${'d'.repeat(1987)}`,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.project.name).toHaveLength(120);
    expect(res.body.data.project.description).toHaveLength(2000);
  });

  it.each([
    ['a MEMBER', () => create(member, ws, { name: 'Nope' }), 403, 'FORBIDDEN'],
    ['an outsider', () => create(outsider, ws, { name: 'Nope' }), 404, 'NOT_FOUND'],
    ['an unknown workspace', () => create(owner, UNKNOWN, { name: 'Nope' }), 404, 'NOT_FOUND'],
  ])('refuses %s and creates nothing', async (_label, call, status, code) => {
    const res = await call();
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(ctx.projects.rows).toHaveLength(0);
  });

  it('answers outsiders and unknown workspaces identically', async () => {
    const a = await create(outsider, ws, { name: 'Nope' });
    const b = await create(owner, UNKNOWN, { name: 'Nope' });
    expect({ ...a.body.error, requestId: 0 }).toEqual({ ...b.body.error, requestId: 0 });
  });

  it.each([
    ['a missing name', {}],
    ['an empty name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a name over 120 characters', { name: 'n'.repeat(121) }],
    ['a name with control characters', { name: 'Bad\nname' }],
    ['a non-string name', { name: 42 }],
    ['a description over 2000 characters', { name: 'A', description: 'd'.repeat(2001) }],
    ['a non-string description', { name: 'A', description: 7 }],
    ['an unknown field', { name: 'A', color: 'red' }],
    ['a client createdById', { name: 'A', createdById: UNKNOWN }],
    ['a client workspaceId', { name: 'A', workspaceId: UNKNOWN }],
    ['a client status', { name: 'A', status: 'ARCHIVED' }],
    ['a client id', { name: 'A', id: UNKNOWN }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await create(owner, ws, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(ctx.projects.rows).toHaveLength(0);
  });

  it('rejects a malformed workspace id with 400', async () => {
    expect((await create(owner, 'not-a-uuid', { name: 'A' })).status).toBe(400);
    expect(ctx.projects.rows).toHaveLength(0);
  });

  it('rejects non-JSON bodies with 415', async () => {
    const res = await create(owner, ws, 'name=A').type('form');
    expect(res.status).toBe(415);
    expect(ctx.projects.rows).toHaveLength(0);
  });

  it('requires a session, a valid CSRF token and an allowed Origin', async () => {
    const path = `/api/v1/workspaces/${ws}/projects`;

    expect((await request(ctx.app).post(path).send({ name: 'A' })).status).toBe(401);
    expect(
      (await request(ctx.app).post(path).set('Cookie', owner.cookie).send({ name: 'A' })).status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app)
          .post(path)
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Token', member.csrfToken)
          .send({ name: 'A' })
      ).status,
    ).toBe(403);
    expect(
      (await create(owner, ws, { name: 'A' }).set('Origin', 'https://evil.example')).status,
    ).toBe(403);
    expect(ctx.projects.rows).toHaveLength(0);
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    const failing = await setup(true);
    const account = await failing.signUp('carol@example.com');
    const res = await request(failing.app)
      .post(`/api/v1/workspaces/${UNKNOWN}/projects`)
      .set('Cookie', account.cookie)
      .set('X-CSRF-Token', account.csrfToken)
      .send({ name: 'A' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001|sql/i);
  });
});
