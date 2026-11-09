/**
 * Project details, editing, archival, restoration and permanent deletion
 * against the real, isolated test database: persistence, the optimistic
 * concurrency precondition, idempotent status changes, real concurrent
 * requests, workspace isolation, and the in-transaction role re-check (a
 * demotion committed while a mutation waits is honored). Rows are tagged with a
 * per-run email domain / workspace-name prefix and removed afterwards.
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import type { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import {
  assertIsTestDatabase,
  assertTestDatabaseName,
  buildAppWithDatabase,
  testConfig,
} from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
let counter = 0;
const workspaceName = () => `it-${RUN} lifecycle ${++counter}`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('project lifecycle with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let raw: pg.Client;
  let owner: Account;
  let coOwner: Account;
  let member: Account;
  let outsider: Account;

  const signUp = async (local: string): Promise<Account> => {
    const email = `${local}@${RUN_DOMAIN}`;
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return {
      id: registered.body.data.user.id,
      email,
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
  const newProject = (workspaceId: string, name = 'Website Redesign', createdById = owner.id) =>
    db.project.create({ data: { workspaceId, name, description: 'Original', createdById } });

  const path = (ws: string, id: string) => `/api/v1/workspaces/${ws}/projects/${id}`;
  const authed = <T extends request.Test>(req: T, who: Account) =>
    req.set('Cookie', who.cookie).set('X-CSRF-Token', who.csrfToken);
  const get = (who: Account, ws: string, id: string) =>
    request(app).get(path(ws, id)).set('Cookie', who.cookie);
  const patch = (who: Account, ws: string, id: string, body: object) =>
    authed(request(app).patch(path(ws, id)), who).send(body);
  const act = (who: Account, ws: string, id: string, verb: 'archive' | 'restore') =>
    authed(request(app).post(`${path(ws, id)}/${verb}`), who);
  const remove = (who: Account, ws: string, id: string) =>
    authed(request(app).delete(path(ws, id)), who);
  const current = (id: string) => db.project.findUnique({ where: { id } });
  const seen = async (id: string) => ({
    expectedUpdatedAt: (await current(id))!.updatedAt.toISOString(),
  });

  /** Polls until a statement matching `pattern` is waiting on a lock. */
  async function waitForLockWait(pattern: string) {
    for (let i = 0; i < 80; i++) {
      const [row] = await db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
      if (row!.waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`no statement matching ${pattern} waited on a lock`);
  }

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '8',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
    raw = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await raw.connect();
    const { rows } = await raw.query<{ name: string }>('SELECT current_database() AS name');
    assertTestDatabaseName(rows[0]!.name);

    owner = await signUp('owner');
    coOwner = await signUp('coowner');
    member = await signUp('member');
    outsider = await signUp('outsider');
  }, 120_000);

  afterAll(async () => {
    await raw?.end();
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('details: members see it (archived too); outsiders, unknown and foreign get 404', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const other = await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const foreign = await newProject(other, 'Theirs', outsider.id);

    for (const who of [owner, member]) {
      const res = await get(who, ws, project.id);
      expect(res.status).toBe(200);
      expect(res.body.data.project).toMatchObject({
        id: project.id,
        workspaceId: ws,
        status: 'ACTIVE',
      });
      expect(res.body.data.creator).toEqual({ id: owner.id, email: owner.email });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session|token/i);
    }
    expect((await get(outsider, ws, project.id)).status).toBe(404);
    expect((await get(owner, randomUUID(), project.id)).status).toBe(404);
    expect((await get(owner, ws, randomUUID())).status).toBe(404);
    const crossed = await get(owner, ws, foreign.id);
    expect(crossed.status).toBe(404);
    expect(JSON.stringify(crossed.body)).not.toContain('Theirs');

    await db.project.update({ where: { id: project.id }, data: { status: 'ARCHIVED' } });
    expect((await get(member, ws, project.id)).body.data.project.status).toBe('ARCHIVED');
  }, 60_000);

  it('edit: persists name/description, moves updatedAt strictly forward, keeps the rest', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const project = await newProject(ws);
    let last = project.updatedAt.getTime();

    // Rapid successive edits: each one must get a strictly newer updatedAt.
    for (const [i, change] of [
      { name: '  Renamed  ' },
      { description: 'New description' },
      { name: 'Both', description: '' },
    ].entries()) {
      const res = await patch(owner, ws, project.id, { ...change, ...(await seen(project.id)) });
      expect(res.status, `edit ${i}`).toBe(200);
      const next = new Date(res.body.data.project.updatedAt).getTime();
      expect(next).toBeGreaterThan(last);
      last = next;
    }

    const row = await current(project.id);
    expect(row).toMatchObject({
      name: 'Both',
      description: null,
      status: 'ACTIVE',
      workspaceId: ws,
      createdById: owner.id,
      createdAt: project.createdAt,
    });
    expect(row!.updatedAt.getTime()).toBe(last);
  }, 60_000);

  it('edit: concurrent edits from the same version → exactly one wins, the rest get 409', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [coOwner, 'OWNER'],
    ]);
    const project = await newProject(ws);
    const version = await seen(project.id);

    const results = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name, i) =>
        patch(i % 2 ? coOwner : owner, ws, project.id, { name, ...version }),
      ),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200)!.body.data.project.name;
    expect((await current(project.id))!.name).toBe(winner);
  }, 60_000);

  it('edit: refused for members (403), outsiders (404), archived projects (409) and bad input', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);
    const before = await current(project.id);

    expect(
      (await patch(member, ws, project.id, { name: 'X', ...(await seen(project.id)) })).status,
    ).toBe(403);
    expect(
      (await patch(outsider, ws, project.id, { name: 'X', ...(await seen(project.id)) })).status,
    ).toBe(404);
    for (const body of [
      { name: '   ' },
      { name: 'x'.repeat(121) },
      { description: 'd'.repeat(2001) },
      {},
      { name: 'X', status: 'ARCHIVED' },
      { name: 'X', workspaceId: randomUUID() },
      { name: 'X', createdById: member.id },
    ]) {
      expect(
        (await patch(owner, ws, project.id, { ...body, ...(await seen(project.id)) })).status,
      ).toBe(400);
    }
    expect(await current(project.id)).toEqual(before);

    await act(owner, ws, project.id, 'archive');
    const archived = await current(project.id);
    const res = await patch(owner, ws, project.id, { name: 'X', ...(await seen(project.id)) });
    expect(res.status).toBe(409);
    expect(await current(project.id)).toEqual(archived);
  }, 60_000);

  it('archive/restore: record kept, idempotent repeats, members and outsiders refused', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const project = await newProject(ws);

    expect((await act(member, ws, project.id, 'archive')).status).toBe(403);
    expect((await act(outsider, ws, project.id, 'archive')).status).toBe(404);
    expect((await current(project.id))!.status).toBe('ACTIVE');

    const archived = await act(owner, ws, project.id, 'archive');
    expect(archived.body.data).toMatchObject({ changed: true, project: { status: 'ARCHIVED' } });
    const archivedRow = await current(project.id);
    expect(archivedRow).toMatchObject({
      status: 'ARCHIVED',
      name: project.name,
      description: project.description,
      createdAt: project.createdAt,
    });

    const again = await act(owner, ws, project.id, 'archive');
    expect(again.body.data.changed).toBe(false);
    expect(await current(project.id)).toEqual(archivedRow); // nothing written

    expect((await act(member, ws, project.id, 'restore')).status).toBe(403);
    const restored = await act(owner, ws, project.id, 'restore');
    expect(restored.body.data).toMatchObject({ changed: true, project: { status: 'ACTIVE' } });
    expect((await current(project.id))!.updatedAt.getTime()).toBeGreaterThan(
      archivedRow!.updatedAt.getTime(),
    );
    expect((await act(owner, ws, project.id, 'restore')).body.data.changed).toBe(false);
  }, 60_000);

  it('archive/restore: concurrent bursts never corrupt the state', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [coOwner, 'OWNER'],
    ]);
    const project = await newProject(ws);

    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(
        ['archive', 'restore', 'archive', 'restore', 'archive', 'restore'].map((verb, i) =>
          act(i % 2 ? coOwner : owner, ws, project.id, verb as 'archive' | 'restore'),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      const row = await current(project.id);
      expect(['ACTIVE', 'ARCHIVED']).toContain(row!.status);
      expect(row).toMatchObject({ name: project.name, workspaceId: ws, createdById: owner.id });
    }
  }, 120_000);

  it('delete: removes exactly that project; everything else stays; repeats get 404', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    const other = await workspaceWith([[outsider, 'OWNER']]);
    const project = await newProject(ws);
    const sibling = await newProject(ws, 'Sibling');
    const foreign = await newProject(other, 'Theirs', outsider.id);
    const invitation = await db.workspaceInvitation.create({
      data: {
        workspaceId: ws,
        inviterId: owner.id,
        email: `invitee@${RUN_DOMAIN}`,
        tokenHash: Buffer.from(randomUUID().replace(/-/g, '').repeat(2), 'hex'),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    expect((await remove(member, ws, project.id)).status).toBe(403);
    expect((await remove(outsider, ws, project.id)).status).toBe(404);
    expect((await remove(owner, ws, foreign.id)).status).toBe(404); // cross-workspace
    expect((await remove(outsider, other, project.id)).status).toBe(404);
    expect(await current(project.id)).not.toBeNull();

    const res = await remove(owner, ws, project.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { deleted: true } });
    expect(await current(project.id)).toBeNull();
    expect(await current(sibling.id)).not.toBeNull();
    expect(await current(foreign.id)).not.toBeNull();
    expect(await db.workspace.findUnique({ where: { id: ws } })).not.toBeNull();
    expect(await db.workspaceMember.count({ where: { workspaceId: ws } })).toBe(2);
    expect(
      await db.workspaceInvitation.findUnique({ where: { id: invitation.id } }),
    ).not.toBeNull();
    expect(await db.user.count({ where: { id: { in: [owner.id, member.id] } } })).toBe(2);

    const again = await remove(owner, ws, project.id);
    expect(again.status).toBe(404);
    expect(again.body.error.message).toBe('Project not found');
  }, 60_000);

  it('delete: concurrent deletes → exactly one 200, the others 404', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [coOwner, 'OWNER'],
    ]);
    const project = await newProject(ws);

    const results = await Promise.all([
      remove(owner, ws, project.id),
      remove(coOwner, ws, project.id),
      remove(owner, ws, project.id),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    expect(await current(project.id)).toBeNull();
  }, 60_000);

  it('re-checks the role inside the transaction: a demotion committed while waiting wins', async () => {
    const ws = await workspaceWith([
      [owner, 'OWNER'],
      [coOwner, 'OWNER'],
    ]);
    const project = await newProject(ws);

    // Another transaction is demoting `owner` and holds their membership row.
    await raw.query('BEGIN');
    await raw.query(
      `UPDATE workspace_members SET role = 'MEMBER' WHERE workspace_id = $1 AND user_id = $2`,
      [ws, owner.id],
    );
    const pending = remove(owner, ws, project.id).then((res) => res);
    await waitForLockWait('%FROM workspace_members%FOR SHARE%');
    expect(await current(project.id)).not.toBeNull();
    await raw.query('COMMIT');

    const res = await pending;
    expect(res.status).toBe(403); // saw the committed demotion
    expect(await current(project.id)).not.toBeNull();
  }, 60_000);

  it('a mutation that cannot get the membership lock in time rolls back with 503', async () => {
    const ws = await workspaceWith([[owner, 'OWNER']]);
    const project = await newProject(ws);
    const before = await current(project.id);

    await raw.query('BEGIN');
    await raw.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE',
      [ws, owner.id],
    );
    try {
      const res = await act(owner, ws, project.id, 'archive');
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|sql|55P03|lock/i);
    } finally {
      await raw.query('ROLLBACK');
    }
    expect(await current(project.id)).toEqual(before);
  }, 60_000);
});
