/**
 * Member removal against the real, isolated test database. Asserts HTTP
 * responses AND database state, including collateral data that must survive
 * (account, sessions, invitations, other memberships) and a real concurrent
 * role change. Every row is tagged with a per-run email domain / workspace
 * name prefix and removed afterwards (workspaces first, then users).
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
const name = (label: string) => `it-${RUN} ${label}`;

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('member removal with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;
  let counter = 0;

  const signUp = async (local: string): Promise<Account> => {
    const email = `${local}-${++counter}@${RUN_DOMAIN}`;
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
  const createWorkspace = async (owner: Account, label: string): Promise<string> =>
    (
      await request(app)
        .post('/api/v1/workspaces')
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Token', owner.csrfToken)
        .send({ name: name(label) })
    ).body.data.workspace.id;
  const addMember = (
    workspaceId: string,
    userId: string,
    role: WorkspaceRole = WorkspaceRole.MEMBER,
  ) => db.workspaceMember.create({ data: { workspaceId, userId, role } });
  const remove = (requester: Account, workspaceId: string, userId: string) =>
    request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${userId}`)
      .set('Cookie', requester.cookie)
      .set('X-CSRF-Token', requester.csrfToken);
  const membership = (workspaceId: string, userId: string) =>
    db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  /** All memberships of the run's users, as "workspaceId:userId:role", sorted. */
  const snapshot = async () =>
    (
      await db.workspaceMember.findMany({
        where: { user: { email: { endsWith: `@${RUN_DOMAIN}` } } },
        select: { workspaceId: true, userId: true, role: true },
      })
    )
      .map((m) => `${m.workspaceId}:${m.userId}:${m.role}`)
      .sort();

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '6',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  describe('authorization and outcomes', () => {
    let owner: Account;
    let alice: Account; // MEMBER, also in another workspace and invited to a third
    let bob: Account; // MEMBER
    let coOwner: Account; // second OWNER (inserted directly: no role API yet)
    let outsider: Account;
    let otherOwner: Account;
    let ws: string;
    let otherWs: string;
    let thirdWs: string;

    beforeEach(async () => {
      owner = await signUp('owner');
      alice = await signUp('alice');
      bob = await signUp('bob');
      coOwner = await signUp('coowner');
      outsider = await signUp('outsider');
      otherOwner = await signUp('otherowner');
      ws = await createWorkspace(owner, 'Main');
      otherWs = await createWorkspace(otherOwner, 'Other');
      thirdWs = await createWorkspace(otherOwner, 'Third');
      await addMember(ws, alice.id);
      await addMember(ws, bob.id);
      await addMember(ws, coOwner.id, WorkspaceRole.OWNER);
      await addMember(otherWs, alice.id);
      await db.workspaceInvitation.create({
        data: {
          workspaceId: thirdWs,
          inviterId: otherOwner.id,
          email: alice.email,
          tokenHash: new Uint8Array(randomBytes(32)),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
    }, 120_000);

    it('owner removes a MEMBER; only that membership row disappears', async () => {
      const before = await snapshot();
      const sessionsBefore = await db.session.count({ where: { userId: alice.id } });
      const invitationsBefore = await db.workspaceInvitation.count();

      const res = await remove(owner, ws, alice.id);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { removed: true } });
      expect(await membership(ws, alice.id)).toBeNull();
      expect(await snapshot()).toEqual(before.filter((m) => m !== `${ws}:${alice.id}:MEMBER`));
      // Collateral data is untouched.
      expect(await db.user.findUnique({ where: { id: alice.id } })).not.toBeNull();
      expect(await db.session.count({ where: { userId: alice.id } })).toBe(sessionsBefore);
      expect(await db.workspaceInvitation.count()).toBe(invitationsBefore);
      expect(await membership(otherWs, alice.id)).toMatchObject({ role: 'MEMBER' });

      // Effect: access to this workspace ends; everything else still works.
      const get = (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', alice.cookie);
      expect((await get(`/workspaces/${ws}`)).status).toBe(404);
      expect((await get(`/workspaces/${otherWs}`)).status).toBe(200);
      expect((await get('/auth/me')).status).toBe(200);
    }, 60_000);

    it('a repeated removal is a 404 and deletes nothing', async () => {
      expect((await remove(owner, ws, alice.id)).status).toBe(200);
      const after = await snapshot();

      const again = await remove(owner, ws, alice.id);

      expect(again.status).toBe(404);
      expect(again.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Member not found' });
      expect(await snapshot()).toEqual(after);
    }, 60_000);

    it('a MEMBER cannot remove another member (403)', async () => {
      const before = await snapshot();
      const res = await remove(bob, ws, alice.id);

      expect(res.status).toBe(403);
      expect(await snapshot()).toEqual(before);
    }, 60_000);

    it('outsiders and unknown workspaces get the same 404', async () => {
      const before = await snapshot();
      const outsiderRes = await remove(outsider, ws, alice.id);
      const unknownRes = await remove(owner, randomUUID(), alice.id);

      expect([outsiderRes.status, unknownRes.status]).toEqual([404, 404]);
      expect({ ...outsiderRes.body.error, requestId: 0 }).toEqual({
        ...unknownRes.body.error,
        requestId: 0,
      });
      expect(outsiderRes.body.error.message).toBe('Workspace not found');
      expect(await snapshot()).toEqual(before);
    }, 60_000);

    it('a target without membership in this workspace is a 404', async () => {
      const before = await snapshot();
      expect((await remove(owner, ws, outsider.id)).status).toBe(404);
      expect((await remove(owner, ws, randomUUID())).status).toBe(404);
      expect(await snapshot()).toEqual(before);
    }, 60_000);

    it('owners cannot be removed (409)', async () => {
      const before = await snapshot();
      const res = await remove(owner, ws, coOwner.id);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe('Workspace owners cannot be removed.');
      expect(await membership(ws, coOwner.id)).toMatchObject({ role: 'OWNER' });
      expect(await snapshot()).toEqual(before);
    }, 60_000);

    it('the requester cannot remove themselves (409)', async () => {
      const before = await snapshot();
      const res = await remove(owner, ws, owner.id);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe('You cannot remove yourself from the workspace.');
      expect(await snapshot()).toEqual(before);
    }, 60_000);

    it('cannot reach across workspaces', async () => {
      const before = await snapshot();
      // Owner of ws targets someone who is only in otherWs, via ws.
      expect((await remove(owner, ws, otherOwner.id)).status).toBe(404);
      // Owner of ws targets alice's membership in otherWs (not their workspace).
      expect((await remove(owner, otherWs, alice.id)).status).toBe(404);
      expect(await snapshot()).toEqual(before);
    }, 60_000);

    it('rejects malformed IDs and extra input with 400', async () => {
      const before = await snapshot();
      const bad = [
        await remove(owner, 'not-a-uuid', alice.id),
        await remove(owner, ws, 'not-a-uuid'),
        await remove(owner, ws, alice.id).query({ role: 'OWNER' }),
        await remove(owner, ws, alice.id).send({ role: 'OWNER' }),
      ];

      expect(bad.map((r) => r.status)).toEqual([400, 400, 400, 400]);
      expect(await snapshot()).toEqual(before);
    }, 60_000);

    it('enforces session, CSRF and Origin', async () => {
      const before = await snapshot();
      const path = `/api/v1/workspaces/${ws}/members/${alice.id}`;
      const noSession = await request(app).delete(path);
      const noCsrf = await request(app).delete(path).set('Cookie', owner.cookie);
      const wrongCsrf = await request(app)
        .delete(path)
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Token', alice.csrfToken);
      const evilOrigin = await remove(owner, ws, alice.id).set('Origin', 'https://evil.example');

      expect([noSession.status, noCsrf.status, wrongCsrf.status, evilOrigin.status]).toEqual([
        401, 403, 403, 403,
      ]);
      expect(await snapshot()).toEqual(before);
    }, 60_000);
  });

  describe('concurrency', () => {
    it('concurrent removals of the same member: exactly one succeeds', async () => {
      const owner = await signUp('c-owner');
      const target = await signUp('c-target');
      const bystander = await signUp('c-bystander');
      const ws = await createWorkspace(owner, 'Concurrent');
      await addMember(ws, target.id);
      await addMember(ws, bystander.id);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => remove(owner, ws, target.id)),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([200, 404, 404, 404, 404, 404]);
      expect(await membership(ws, target.id)).toBeNull();
      expect(await membership(ws, bystander.id)).not.toBeNull();
      expect(await membership(ws, owner.id)).toMatchObject({ role: 'OWNER' });
    }, 60_000);

    describe('a concurrent role change cannot bypass owner protection', () => {
      let raw: pg.Client;

      beforeAll(async () => {
        raw = new pg.Client({ connectionString: TEST_DATABASE_URL });
        await raw.connect();
        const { rows } = await raw.query<{ name: string }>('SELECT current_database() AS name');
        assertTestDatabaseName(rows[0]!.name);
      }, 30_000);

      afterAll(async () => {
        await raw?.end();
      });

      /** Waits until the API's DELETE is blocked on our row lock. */
      async function waitForBlockedDelete() {
        for (let i = 0; i < 60; i++) {
          const [row] = await db.$queryRaw<{ waiting: number }[]>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE 'DELETE FROM%workspace_members%'`;
          if (row!.waiting > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error('DELETE never waited on the row lock');
      }

      async function race(outcome: 'COMMIT' | 'ROLLBACK') {
        const owner = await signUp(`r-owner-${outcome}`);
        const target = await signUp(`r-target-${outcome}`);
        const ws = await createWorkspace(owner, `Race ${outcome}`);
        await addMember(ws, target.id);

        await raw.query('BEGIN');
        await raw.query(
          `UPDATE workspace_members SET role = 'OWNER' WHERE workspace_id = $1 AND user_id = $2`,
          [ws, target.id],
        );
        // Start the removal; it must block on the locked row.
        const pending = remove(owner, ws, target.id).then((res) => res);
        await waitForBlockedDelete();
        await raw.query(outcome);
        return { res: await pending, ws, target };
      }

      it('promotion committed while the DELETE waits → 409, target kept as OWNER', async () => {
        const { res, ws, target } = await race('COMMIT');

        expect(res.status).toBe(409);
        expect(res.body.error.message).toBe('Workspace owners cannot be removed.');
        expect(await membership(ws, target.id)).toMatchObject({ role: 'OWNER' });
      }, 60_000);

      it('promotion rolled back while the DELETE waits → removal proceeds', async () => {
        const { res, ws, target } = await race('ROLLBACK');

        expect(res.status).toBe(200);
        expect(await membership(ws, target.id)).toBeNull();
      }, 60_000);
    });
  });
});
