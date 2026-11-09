/**
 * Project creation against the real, isolated test database: persistence,
 * server-decided fields, authorization, workspace isolation and the foreign-key
 * policies. Rows are tagged with a per-run email domain / workspace-name prefix
 * and removed afterwards: workspaces first (cascading to their projects, which
 * releases the RESTRICT on project creators), then users.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} projects ${++counter}`;

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('project creation with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  let otherOwner: Account;

  const signUp = async (local: string): Promise<Account> => {
    const email = `${local}@${RUN_DOMAIN}`;
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
  const workspaceWith = async (members: [Account, WorkspaceRole][]) => {
    const ws = await db.workspace.create({ data: { name: workspaceName() } });
    for (const [account, role] of members) {
      await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: account.id, role } });
    }
    return ws.id;
  };
  const create = (requester: Account, workspaceId: string, body: unknown) =>
    request(app)
      .post(`/api/v1/workspaces/${workspaceId}/projects`)
      .set('Cookie', requester.cookie)
      .set('X-CSRF-Token', requester.csrfToken)
      .send(body as object);
  const projectsIn = (workspaceId: string) =>
    db.project.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  const runProjectCount = () =>
    db.project.count({ where: { workspace: { name: { startsWith: `it-${RUN} ` } } } });

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '5',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
    owner = await signUp('owner');
    member = await signUp('member');
    outsider = await signUp('outsider');
    otherOwner = await signUp('otherowner');
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('owner creates a project: stored in the route workspace, by the session user, ACTIVE', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);

    const res = await create(owner, ws, {
      name: '  Website Redesign  ',
      description: '  Redesign the company website\nPhase 1  ',
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: {
        project: {
          id: expect.any(String),
          workspaceId: ws,
          name: 'Website Redesign',
          description: 'Redesign the company website\nPhase 1',
          status: 'ACTIVE',
          createdById: owner.id,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      },
    });

    const [row] = await projectsIn(ws);
    expect(row).toMatchObject({
      id: res.body.data.project.id,
      workspaceId: ws,
      createdById: owner.id,
      name: 'Website Redesign',
      description: 'Redesign the company website\nPhase 1',
      status: 'ACTIVE',
    });
  }, 60_000);

  it('stores NULL for a missing, null or blank description', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);

    for (const body of [
      { name: 'A' },
      { name: 'B', description: null },
      { name: 'C', description: '   ' },
    ]) {
      const res = await create(owner, ws, body);
      expect(res.status).toBe(201);
      expect(res.body.data.project.description).toBeNull();
    }
    expect((await projectsIn(ws)).map((p) => p.description)).toEqual([null, null, null]);
  }, 60_000);

  it('supports several projects per workspace and keeps workspaces isolated', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const other = await workspaceWith([[otherOwner, 'OWNER']]);

    for (const name of ['One', 'Two', 'Three']) {
      expect((await create(owner, ws, { name })).status).toBe(201);
    }
    expect((await create(otherOwner, other, { name: 'Elsewhere' })).status).toBe(201);

    expect((await projectsIn(ws)).map((p) => p.name)).toEqual(['One', 'Two', 'Three']);
    expect((await projectsIn(other)).map((p) => [p.name, p.createdById])).toEqual([
      ['Elsewhere', otherOwner.id],
    ]);
    // An owner of one workspace cannot create in another.
    expect((await create(owner, other, { name: 'Intrusion' })).status).toBe(404);
    expect(await projectsIn(other)).toHaveLength(1);
  }, 60_000);

  it('refuses members (403), outsiders and unknown workspaces (same 404); nothing is stored', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const before = await runProjectCount();

    const byMember = await create(member, ws, { name: 'Nope' });
    const byOutsider = await create(outsider, ws, { name: 'Nope' });
    const unknown = await create(owner, randomUUID(), { name: 'Nope' });

    expect([byMember.status, byOutsider.status, unknown.status]).toEqual([403, 404, 404]);
    expect({ ...byOutsider.body.error, requestId: 0 }).toEqual({
      ...unknown.body.error,
      requestId: 0,
    });
    expect(await runProjectCount()).toBe(before);
  }, 60_000);

  it('rejects client-supplied server fields and invalid input; nothing is stored', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const other = await workspaceWith([[otherOwner, 'OWNER']]);
    const before = await runProjectCount();

    const attempts = [
      { name: 'X', createdById: otherOwner.id },
      { name: 'X', workspaceId: other },
      { name: 'X', status: 'ARCHIVED' },
      { name: 'X', id: randomUUID() },
      {},
      { name: '   ' },
      { name: 'x'.repeat(121) },
      { name: 'X', description: 'd'.repeat(2001) },
    ];
    for (const body of attempts) {
      expect((await create(owner, ws, body)).status).toBe(400);
    }
    expect(await runProjectCount()).toBe(before);

    // Boundaries are accepted.
    expect(
      (await create(owner, ws, { name: 'x'.repeat(120), description: 'd'.repeat(2000) })).status,
    ).toBe(201);
  }, 60_000);

  it('enforces session, CSRF, Origin and UUID validation', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const path = `/api/v1/workspaces/${ws}/projects`;
    const before = await runProjectCount();

    const statuses = [
      (await request(app).post(path).send({ name: 'X' })).status,
      (await request(app).post(path).set('Cookie', owner.cookie).send({ name: 'X' })).status,
      (
        await request(app)
          .post(path)
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Token', member.csrfToken)
          .send({ name: 'X' })
      ).status,
      (await create(owner, ws, { name: 'X' }).set('Origin', 'https://evil.example')).status,
      (await create(owner, 'not-a-uuid', { name: 'X' })).status,
    ];

    expect(statuses).toEqual([401, 403, 403, 403, 400]);
    expect(await runProjectCount()).toBe(before);
  }, 60_000);

  it('applies the foreign-key policies: workspace cascade, creator restrict', async () => {
    const creator = await signUp('creator');
    const ws = await workspaceWith([[creator, 'OWNER']]);
    expect((await create(creator, ws, { name: 'Audit me' })).status).toBe(201);
    const [project] = await projectsIn(ws);

    // Removing the creator from the workspace does not lose authorship...
    await db.workspaceMember.deleteMany({ where: { workspaceId: ws, userId: creator.id } });
    // ...and their account cannot be deleted while it is recorded as a creator.
    await expect(db.user.delete({ where: { id: creator.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await db.project.findUnique({ where: { id: project!.id } })).toMatchObject({
      createdById: creator.id,
    });

    // Deleting the workspace deletes its projects only.
    await db.workspace.delete({ where: { id: ws } });
    expect(await db.project.count({ where: { id: project!.id } })).toBe(0);
    expect(await db.user.findUnique({ where: { id: creator.id } })).not.toBeNull();
  }, 60_000);
});
