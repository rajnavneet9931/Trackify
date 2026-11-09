/**
 * Role management against the real, isolated test database. Concurrency is
 * tested with genuinely simultaneous HTTP requests and raw row locks, and every
 * test asserts the database invariant (≥ 1 OWNER per workspace), not only
 * status codes. Rows are tagged with a per-run email domain / workspace-name
 * prefix and removed afterwards (workspaces first, then users).
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { WorkspaceRole } from '../../src/modules/workspaces/index.js';
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
let workspaceCounter = 0;
const nextName = () => `it-${RUN} roles ${++workspaceCounter}`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('role management with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let raw: pg.Client;
  let alice: Account; // owner in every fixture workspace
  let bob: Account; // second owner where needed
  let carol: Account; // regular member
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
  /** Fixture workspace inserted directly (fast); roles as given. */
  const workspaceWith = async (members: [Account, WorkspaceRole][]) => {
    const ws = await db.workspace.create({ data: { name: nextName() } });
    for (const [account, role] of members) {
      await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: account.id, role } });
    }
    return ws.id;
  };
  const setRole = (requester: Account, workspaceId: string, userId: string, role: string) =>
    request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${userId}/role`)
      .set('Cookie', requester.cookie)
      .set('X-CSRF-Token', requester.csrfToken)
      .send({ role });
  const remove = (requester: Account, workspaceId: string, userId: string) =>
    request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${userId}`)
      .set('Cookie', requester.cookie)
      .set('X-CSRF-Token', requester.csrfToken);
  const roles = async (workspaceId: string) =>
    Object.fromEntries(
      (
        await db.workspaceMember.findMany({
          where: { workspaceId },
          select: { userId: true, role: true },
        })
      ).map((m) => [m.userId, m.role]),
    ) as Record<string, WorkspaceRole>;
  const ownerCount = (workspaceId: string) =>
    db.workspaceMember.count({ where: { workspaceId, role: WorkspaceRole.OWNER } });

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

    alice = await signUp('alice');
    bob = await signUp('bob');
    carol = await signUp('carol');
    outsider = await signUp('outsider');
  }, 120_000);

  afterAll(async () => {
    await raw?.end();
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  describe('single requests (HTTP + database state)', () => {
    it('promotes and demotes, touching only that membership row', async () => {
      const ws = await workspaceWith([
        [alice, 'OWNER'],
        [carol, 'MEMBER'],
      ]);
      const elsewhere = await workspaceWith([
        [bob, 'OWNER'],
        [carol, 'MEMBER'],
      ]);
      await db.workspaceInvitation.create({
        data: {
          workspaceId: elsewhere,
          inviterId: bob.id,
          email: outsider.email,
          tokenHash: new Uint8Array(randomBytes(32)),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const collateral = async () => ({
        users: await db.user.count({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } }),
        sessions: await db.session.count({
          where: { user: { email: { endsWith: `@${RUN_DOMAIN}` } } },
        }),
        invitations: await db.workspaceInvitation.count({ where: { workspaceId: elsewhere } }),
        elsewhere: await roles(elsewhere),
      });
      const before = await collateral();

      const promoted = await setRole(alice, ws, carol.id, 'OWNER');
      expect(promoted.status).toBe(200);
      expect(promoted.body.data).toEqual({
        member: { userId: carol.id, role: 'OWNER' },
        changed: true,
      });
      expect(await roles(ws)).toEqual({ [alice.id]: 'OWNER', [carol.id]: 'OWNER' });

      const demoted = await setRole(alice, ws, carol.id, 'MEMBER');
      expect(demoted.status).toBe(200);
      expect(await roles(ws)).toEqual({ [alice.id]: 'OWNER', [carol.id]: 'MEMBER' });

      // Only the target workspace changed.
      expect(await collateral()).toEqual(before);
    }, 60_000);

    it('refuses to demote the last owner (409) and leaves the row unchanged', async () => {
      const ws = await workspaceWith([
        [alice, 'OWNER'],
        [carol, 'MEMBER'],
      ]);

      const res = await setRole(alice, ws, alice.id, 'MEMBER');

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe('A workspace must have at least one owner.');
      expect(await roles(ws)).toEqual({ [alice.id]: 'OWNER', [carol.id]: 'MEMBER' });
    }, 60_000);

    it('same-role requests are idempotent (200, changed: false)', async () => {
      const ws = await workspaceWith([
        [alice, 'OWNER'],
        [carol, 'MEMBER'],
      ]);

      const res = await setRole(alice, ws, carol.id, 'MEMBER');

      expect(res.status).toBe(200);
      expect(res.body.data.changed).toBe(false);
      expect(await roles(ws)).toEqual({ [alice.id]: 'OWNER', [carol.id]: 'MEMBER' });
    }, 60_000);

    it('authorization: 403 for members, the same 404 for outsiders and unknown workspaces', async () => {
      const ws = await workspaceWith([
        [alice, 'OWNER'],
        [carol, 'MEMBER'],
      ]);
      const before = await roles(ws);

      const byMember = await setRole(carol, ws, carol.id, 'OWNER');
      const byOutsider = await setRole(outsider, ws, carol.id, 'OWNER');
      const unknownWs = await setRole(alice, randomUUID(), carol.id, 'OWNER');
      const unknownTarget = await setRole(alice, ws, outsider.id, 'OWNER');

      expect([byMember.status, byOutsider.status, unknownWs.status, unknownTarget.status]).toEqual([
        403, 404, 404, 404,
      ]);
      expect({ ...byOutsider.body.error, requestId: 0 }).toEqual({
        ...unknownWs.body.error,
        requestId: 0,
      });
      expect(unknownTarget.body.error.message).toBe('Member not found');
      expect(await roles(ws)).toEqual(before);
    }, 60_000);

    it('rejects bad input and missing security headers without changing anything', async () => {
      const ws = await workspaceWith([
        [alice, 'OWNER'],
        [carol, 'MEMBER'],
      ]);
      const path = `/api/v1/workspaces/${ws}/members/${carol.id}/role`;
      const before = await roles(ws);

      const statuses = [
        (await setRole(alice, ws, carol.id, 'ADMIN')).status,
        (
          await request(app)
            .patch(path)
            .set('Cookie', alice.cookie)
            .set('X-CSRF-Token', alice.csrfToken)
            .send({ role: 'OWNER', userId: alice.id })
        ).status,
        (await setRole(alice, 'not-a-uuid', carol.id, 'OWNER')).status,
        (await request(app).patch(path).send({ role: 'OWNER' })).status,
        (await request(app).patch(path).set('Cookie', alice.cookie).send({ role: 'OWNER' })).status,
        (await setRole(alice, ws, carol.id, 'OWNER').set('Origin', 'https://evil.example')).status,
      ];

      expect(statuses).toEqual([400, 400, 400, 401, 403, 403]);
      expect(await roles(ws)).toEqual(before);
    }, 60_000);
  });

  describe('concurrency', () => {
    it('mutual demotion of the only two owners always leaves exactly one owner', async () => {
      for (let round = 0; round < 4; round++) {
        const ws = await workspaceWith([
          [alice, 'OWNER'],
          [bob, 'OWNER'],
        ]);

        const [aliceDemotesBob, bobDemotesAlice] = await Promise.all([
          setRole(alice, ws, bob.id, 'MEMBER'),
          setRole(bob, ws, alice.id, 'MEMBER'),
        ]);

        // Serialized by the workspace lock: the second request sees that its
        // requester has just lost the OWNER role.
        expect([aliceDemotesBob.status, bobDemotesAlice.status].sort()).toEqual([200, 403]);
        expect(await ownerCount(ws)).toBe(1);
        const winner = aliceDemotesBob.status === 200 ? alice : bob;
        expect((await roles(ws))[winner.id]).toBe('OWNER');
      }
    }, 180_000);

    it('simultaneous self-demotions of the only two owners leave exactly one owner', async () => {
      for (let round = 0; round < 3; round++) {
        const ws = await workspaceWith([
          [alice, 'OWNER'],
          [bob, 'OWNER'],
        ]);

        const results = await Promise.all([
          setRole(alice, ws, alice.id, 'MEMBER'),
          setRole(bob, ws, bob.id, 'MEMBER'),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await ownerCount(ws)).toBe(1);
      }
    }, 180_000);

    it('a burst of mixed promotions and demotions never removes the last owner', async () => {
      for (let round = 0; round < 3; round++) {
        const ws = await workspaceWith([
          [alice, 'OWNER'],
          [bob, 'OWNER'],
          [carol, 'MEMBER'],
        ]);

        const results = await Promise.all([
          setRole(alice, ws, bob.id, 'MEMBER'),
          setRole(bob, ws, alice.id, 'MEMBER'),
          setRole(alice, ws, carol.id, 'OWNER'),
          setRole(bob, ws, carol.id, 'OWNER'),
          setRole(alice, ws, alice.id, 'MEMBER'),
          setRole(bob, ws, bob.id, 'MEMBER'),
        ]);

        // 503 = a lock or transaction-start timeout under load: rolled back, safe to retry.
        for (const r of results) expect([200, 403, 409, 503]).toContain(r.status);
        const final = await roles(ws);
        expect(
          Object.values(final).filter((role) => role === 'OWNER').length,
        ).toBeGreaterThanOrEqual(1);
        // Every successful change is reflected: no reported success was lost.
        expect(Object.keys(final).sort()).toEqual([alice.id, bob.id, carol.id].sort());
      }
    }, 240_000);

    it('member removal and the requester’s concurrent demotion are serialized', async () => {
      for (let round = 0; round < 3; round++) {
        const ws = await workspaceWith([
          [alice, 'OWNER'],
          [bob, 'OWNER'],
          [carol, 'MEMBER'],
        ]);

        const [removal, demotion] = await Promise.all([
          remove(alice, ws, carol.id),
          setRole(bob, ws, alice.id, 'MEMBER'),
        ]);

        const final = await roles(ws);
        expect(demotion.status).toBe(200);
        expect(final[alice.id]).toBe('MEMBER');
        if (removal.status === 200) {
          expect(final[carol.id]).toBeUndefined(); // removal ran first, while Alice was an owner
        } else {
          expect(removal.status).toBe(403); // demotion ran first: Alice was no longer an owner
          expect(final[carol.id]).toBe('MEMBER');
        }
      }
    }, 180_000);

    it('role changes wait for the workspace lock (coordination point)', async () => {
      const ws = await workspaceWith([
        [alice, 'OWNER'],
        [carol, 'MEMBER'],
      ]);

      await raw.query('BEGIN');
      await raw.query('SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [ws]);
      const pending = setRole(alice, ws, carol.id, 'OWNER').then((res) => res);
      await waitForLockWait('SELECT 1 FROM workspaces%FOR NO KEY UPDATE');
      expect((await roles(ws))[carol.id]).toBe('MEMBER');
      await raw.query('COMMIT');

      const res = await pending;
      expect(res.status).toBe(200);
      expect((await roles(ws))[carol.id]).toBe('OWNER');
    }, 60_000);

    it('rolls back and answers 503 when a lock cannot be obtained in time', async () => {
      const ws = await workspaceWith([
        [alice, 'OWNER'],
        [bob, 'OWNER'],
      ]);
      const target = await db.workspaceMember.findUniqueOrThrow({
        where: { workspaceId_userId: { workspaceId: ws, userId: bob.id } },
      });

      // Hold Bob's membership row longer than the 5 s lock_timeout.
      await raw.query('BEGIN');
      await raw.query('SELECT 1 FROM workspace_members WHERE id = $1 FOR UPDATE', [target.id]);
      const started = Date.now();
      const res = await setRole(alice, ws, bob.id, 'MEMBER');
      const elapsed = Date.now() - started;
      await raw.query('ROLLBACK');

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/lock|55P03|prisma|sql/i);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(20_000);
      // Nothing changed, and the workspace lock was released: a retry works.
      expect(await roles(ws)).toEqual({ [alice.id]: 'OWNER', [bob.id]: 'OWNER' });
      const retry = await setRole(alice, ws, bob.id, 'MEMBER');
      expect(retry.status).toBe(200);
      expect(await roles(ws)).toEqual({ [alice.id]: 'OWNER', [bob.id]: 'MEMBER' });
    }, 90_000);
  });
});
