/**
 * Workspace creation against the real, isolated test database. Every row is
 * tagged with a per-run email domain / name prefix and removed afterwards
 * (workspaces first: user → membership is ON DELETE RESTRICT).
 */
import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotFoundError, ForbiddenError } from '../../src/core/errors/app-error.js';
import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import {
  PrismaWorkspaceRepository,
  WorkspaceAccess,
  WorkspaceRole,
} from '../../src/modules/workspaces/index.js';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
const name = (label: string) => `it-${RUN} ${label}`;

interface Account {
  id: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('workspaces with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;

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
  const create = (account: Account, body: object) =>
    request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', account.cookie)
      .set('X-CSRF-Token', account.csrfToken)
      .send(body);

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '5',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
      }),
    ));
    await assertIsTestDatabase(db);
    const [table] = await db.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public.workspace_members') IS NOT NULL AS "exists"`;
    if (!table?.exists)
      throw new Error('Test database is not migrated. Run: npm run db:test:deploy');
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('creates the workspace and an OWNER membership for the session user', async () => {
    const alice = await signUp('alice');
    const res = await create(alice, { name: `  ${name('Alpha')}  ` });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      workspace: { id: expect.any(String), name: name('Alpha'), createdAt: expect.any(String) },
      membership: { role: 'OWNER' },
    });

    const row = await db.workspace.findUniqueOrThrow({
      where: { id: res.body.data.workspace.id },
      include: { members: true },
    });
    expect(row.name).toBe(name('Alpha'));
    expect(row.members).toEqual([
      expect.objectContaining({ userId: alice.id, role: 'OWNER', workspaceId: row.id }),
    ]);
  }, 30_000);

  it('rejects client-supplied ownership and creates nothing', async () => {
    const mallory = await signUp('mallory');
    const victim = await signUp('victim');

    for (const extra of [{ ownerId: victim.id }, { userId: victim.id }, { role: 'OWNER' }]) {
      const res = await create(mallory, { name: name('Hijack'), ...extra });
      expect(res.status).toBe(400);
    }
    expect(await db.workspace.count({ where: { name: name('Hijack') } })).toBe(0);
    expect(await db.workspaceMember.count({ where: { userId: victim.id } })).toBe(0);
  }, 30_000);

  it('keeps two users’ workspaces and memberships isolated', async () => {
    const alice = await signUp('iso-alice');
    const bob = await signUp('iso-bob');
    const a = (await create(alice, { name: name('Alice Co') })).body.data.workspace.id as string;
    const b = (await create(bob, { name: name('Bob Co') })).body.data.workspace.id as string;

    expect(
      await db.workspaceMember.findMany({
        where: { userId: alice.id },
        select: { workspaceId: true, role: true },
      }),
    ).toEqual([{ workspaceId: a, role: 'OWNER' }]);
    expect(
      await db.workspaceMember.findMany({
        where: { userId: bob.id },
        select: { workspaceId: true, role: true },
      }),
    ).toEqual([{ workspaceId: b, role: 'OWNER' }]);

    const access = new WorkspaceAccess(new PrismaWorkspaceRepository(db));
    await expect(access.requireMembership(a, alice.id)).resolves.toMatchObject({ role: 'OWNER' });
    await expect(access.requireMembership(b, alice.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(access.requireMembership(a, bob.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(access.requireMembership(randomUUID(), alice.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  }, 30_000);

  it('enforces one membership per user per workspace in the database', async () => {
    const owner = await signUp('dup-owner');
    const { id } = (await create(owner, { name: name('Dup') })).body.data.workspace;

    await expect(
      db.workspaceMember.create({
        data: { workspaceId: id, userId: owner.id, role: WorkspaceRole.MEMBER },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.workspaceMember.count({ where: { workspaceId: id } })).toBe(1);
  }, 30_000);

  it('rolls back the workspace when the owner membership cannot be created', async () => {
    const repository = new PrismaWorkspaceRepository(db);

    // A non-existent user makes the second INSERT fail (foreign key violation).
    await expect(
      repository.createWithOwner({ name: name('Rollback'), ownerId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'P2003' });

    expect(await db.workspace.count({ where: { name: name('Rollback') } })).toBe(0);
  }, 30_000);

  it('only accepts the defined roles (database enum)', async () => {
    const owner = await signUp('enum-owner');
    const other = await signUp('enum-other');
    const { id } = (await create(owner, { name: name('Enum') })).body.data.workspace;

    await expect(
      db.$executeRaw`INSERT INTO workspace_members (id, workspace_id, user_id, role)
                     VALUES (${randomUUID()}::uuid, ${id}::uuid, ${other.id}::uuid, 'ADMIN')`,
    ).rejects.toThrow();
    expect(await db.workspaceMember.count({ where: { workspaceId: id } })).toBe(1);
  }, 30_000);

  it('applies role checks to non-owner members', async () => {
    const owner = await signUp('role-owner');
    const member = await signUp('role-member');
    const { id } = (await create(owner, { name: name('Roles') })).body.data.workspace;
    await db.workspaceMember.create({
      data: { workspaceId: id, userId: member.id, role: WorkspaceRole.MEMBER },
    });

    const access = new WorkspaceAccess(new PrismaWorkspaceRepository(db));
    await expect(access.requireMembership(id, member.id)).resolves.toMatchObject({
      role: 'MEMBER',
    });
    await expect(
      access.requireMembership(id, member.id, [WorkspaceRole.OWNER]),
    ).rejects.toBeInstanceOf(ForbiddenError);
  }, 30_000);

  it('has deliberate delete behaviour: users with memberships are protected, workspaces cascade', async () => {
    const owner = await signUp('delete-owner');
    const { id } = (await create(owner, { name: name('Delete') })).body.data.workspace;

    await expect(db.user.delete({ where: { id: owner.id } })).rejects.toMatchObject({
      code: 'P2003',
    });

    await db.workspace.delete({ where: { id } });
    expect(await db.workspaceMember.count({ where: { workspaceId: id } })).toBe(0);
    await db.user.delete({ where: { id: owner.id } });
  }, 30_000);

  describe('GET /api/v1/workspaces', () => {
    const list = (account: Account, query = '') =>
      request(app).get(`/api/v1/workspaces${query}`).set('Cookie', account.cookie);
    const names = (res: request.Response) =>
      res.body.data.workspaces.map((w: { name: string }) => w.name) as string[];

    it('returns an empty list for a user with no memberships', async () => {
      const loner = await signUp('list-loner');
      const res = await list(loner);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { workspaces: [] }, meta: { limit: 20, nextCursor: null } });
    }, 30_000);

    it('lists owned and member workspaces with roles, and nothing else', async () => {
      const alice = await signUp('list-alice');
      const bob = await signUp('list-bob');
      await create(alice, { name: name('L Alice 1') });
      await create(alice, { name: name('L Alice 2') });
      const bobOnly = (await create(bob, { name: name('L Bob Private') })).body.data.workspace.id;
      const shared = (await create(bob, { name: name('L Bob Shared') })).body.data.workspace.id;
      // No invitation API yet: add Alice to one of Bob's workspaces directly.
      await db.workspaceMember.create({
        data: { workspaceId: shared, userId: alice.id, role: WorkspaceRole.MEMBER },
      });

      const aliceView = (await list(alice)).body.data.workspaces;
      expect(aliceView.map((w: { name: string; role: string }) => [w.name, w.role])).toEqual([
        [name('L Bob Shared'), 'MEMBER'],
        [name('L Alice 2'), 'OWNER'],
        [name('L Alice 1'), 'OWNER'],
      ]);
      expect(aliceView.map((w: { id: string }) => w.id)).not.toContain(bobOnly);
      expect(Object.keys(aliceView[0]).sort()).toEqual(['createdAt', 'id', 'name', 'role']);

      expect(names(await list(bob))).toEqual([name('L Bob Shared'), name('L Bob Private')]);
    }, 60_000);

    it('pages deterministically with no gaps or duplicates', async () => {
      const pager = await signUp('list-pager');
      const created: string[] = [];
      for (let i = 1; i <= 5; i++) {
        created.unshift(name(`Page ${i}`));
        await create(pager, { name: name(`Page ${i}`) });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await list(pager, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        seen.push(...names(res));
        cursor = res.body.meta.nextCursor;
        pages++;
      } while (cursor && pages < 10);

      expect(seen).toEqual(created);
      expect(pages).toBe(3);
      // Same request, same answer.
      expect(names(await list(pager, '?limit=5'))).toEqual(created);
    }, 60_000);

    it('rejects an invalid cursor with 400', async () => {
      const someone = await signUp('list-cursor');
      const res = await list(someone, '?cursor=bogus');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Invalid pagination cursor');
    }, 30_000);

    it('uses a constant number of SQL statements per page (no N+1)', async () => {
      const owner = await signUp('list-queries');
      for (let i = 1; i <= 4; i++) await create(owner, { name: name(`Q ${i}`) });

      const logged = new PrismaClient({
        adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
        log: [{ emit: 'event', level: 'query' }],
      });
      try {
        await assertIsTestDatabase(logged);
        const statements: string[] = [];
        logged.$on('query', (event) => statements.push(event.query));

        const rows = await new PrismaWorkspaceRepository(logged).listForUser({
          userId: owner.id,
          take: 5,
        });

        expect(rows).toHaveLength(4);
        // Memberships page + one IN (...) lookup of the workspaces, independent of page size.
        expect(statements).toHaveLength(2);
        expect(statements[0]).toMatch(/FROM "public"\."workspace_members" WHERE .*"user_id" = \$1/);
      } finally {
        await logged.$disconnect();
      }
    }, 30_000);
  });

  describe('workspace details and members', () => {
    const get = (account: Account, path: string) =>
      request(app).get(`/api/v1/workspaces${path}`).set('Cookie', account.cookie);

    let owner: Account;
    let member: Account;
    let outsider: Account;
    let workspaceId: string;

    beforeAll(async () => {
      owner = await signUp('detail-owner');
      member = await signUp('detail-member');
      outsider = await signUp('detail-outsider');
      workspaceId = (await create(owner, { name: name('Detail') })).body.data.workspace.id;
      await create(outsider, { name: name('Outsider Only') });
      await db.workspaceMember.create({
        data: { workspaceId, userId: member.id, role: WorkspaceRole.MEMBER },
      });
    }, 60_000);

    it('returns details and the caller’s role to members', async () => {
      const asOwner = await get(owner, `/${workspaceId}`);
      const asMember = await get(member, `/${workspaceId}`);

      expect(asOwner.status).toBe(200);
      expect(asOwner.body.data).toEqual({
        workspace: { id: workspaceId, name: name('Detail'), createdAt: expect.any(String) },
        membership: { role: 'OWNER' },
      });
      expect(asMember.body.data.membership).toEqual({ role: 'MEMBER' });
    }, 30_000);

    it('gives non-members and unknown IDs the same 404, and invalid IDs a 400', async () => {
      const notMember = await get(outsider, `/${workspaceId}`);
      const unknown = await get(outsider, `/${randomUUID()}`);

      expect([notMember.status, unknown.status]).toEqual([404, 404]);
      expect({ ...notMember.body.error, requestId: 0 }).toEqual({
        ...unknown.body.error,
        requestId: 0,
      });
      expect((await get(owner, '/not-a-uuid')).status).toBe(400);
      expect((await get(owner, '/not-a-uuid/members')).status).toBe(400);
    }, 30_000);

    it('lists members with only user ID, name, email, role and join date', async () => {
      const res = await get(member, `/${workspaceId}/members`);

      expect(res.status).toBe(200);
      expect(res.body.data.members).toEqual([
        {
          userId: owner.id,
          name: null,
          email: `detail-owner@${RUN_DOMAIN}`,
          role: 'OWNER',
          joinedAt: expect.any(String),
        },
        {
          userId: member.id,
          name: null,
          email: `detail-member@${RUN_DOMAIN}`,
          role: 'MEMBER',
          joinedAt: expect.any(String),
        },
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|password|hash|session|token/i);
      expect(JSON.stringify(res.body)).not.toContain('detail-outsider');
    }, 30_000);

    it('hides members from non-members (404)', async () => {
      const res = await get(outsider, `/${workspaceId}/members`);

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(RUN_DOMAIN);
    }, 30_000);

    it('pages members deterministically with no gaps or duplicates', async () => {
      const pagedOwner = await signUp('page-owner');
      const pagedId = (await create(pagedOwner, { name: name('Paged') })).body.data.workspace.id;
      const expected = [`page-owner@${RUN_DOMAIN}`];
      for (const n of [1, 2, 3, 4]) {
        const extra = await signUp(`page-m${n}`);
        await db.workspaceMember.create({ data: { workspaceId: pagedId, userId: extra.id } });
        expected.push(`page-m${n}@${RUN_DOMAIN}`);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(
          pagedOwner,
          `/${pagedId}/members?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(res.status).toBe(200);
        seen.push(...res.body.data.members.map((m: { email: string }) => m.email));
        cursor = res.body.meta.nextCursor;
        pages++;
      } while (cursor && pages < 10);

      expect(seen).toEqual(expected);
      expect(pages).toBe(3);
      expect((await get(pagedOwner, `/${pagedId}/members?cursor=bogus`)).status).toBe(400);
    }, 120_000);

    it('uses a constant number of SQL statements per member page (no N+1)', async () => {
      const logged = new PrismaClient({
        adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
        log: [{ emit: 'event', level: 'query' }],
      });
      try {
        await assertIsTestDatabase(logged);
        const statements: string[] = [];
        logged.$on('query', (event) => statements.push(event.query));

        const rows = await new PrismaWorkspaceRepository(logged).listMembers({
          workspaceId,
          take: 21,
        });

        expect(rows).toHaveLength(2);
        expect(statements).toHaveLength(2); // member page + one IN (...) lookup of users
        // Only id, email and name are ever read from users (never password_hash).
        expect(statements[1]).toMatch(
          /SELECT "public"\."users"\."id", "public"\."users"\."email", "public"\."users"\."name" FROM/,
        );
        expect(statements.join('\n')).not.toMatch(/password_hash/);
      } finally {
        await logged.$disconnect();
      }
    }, 30_000);
  });
});
