/**
 * Invitation lifecycle against the real, isolated test database: token
 * hashing, the partial unique index, transactions and concurrency. Rows are
 * tagged with a per-run email domain / workspace-name prefix and removed
 * afterwards (workspaces first: their deletion cascades to invitations and
 * memberships).
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { WorkspaceRole } from '../../src/modules/workspaces/index.js';
import { assertIsTestDatabase, buildAppWithDatabase, testConfig } from '../support/database.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const PASSWORD = 'correct horse battery staple';
const RUN = randomUUID().slice(0, 8);
const RUN_DOMAIN = `int-${RUN}.trackify.test`;
const name = (label: string) => `it-${RUN} ${label}`;
const emailOf = (local: string) => `${local}@${RUN_DOMAIN}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

describe.skipIf(!TEST_DATABASE_URL)('invitations with real PostgreSQL', () => {
  let app: Express;
  let db: DatabaseClient;

  const signUp = async (local: string): Promise<Account> => {
    const email = emailOf(local);
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
  const post = (account: Account, path: string, body?: object) => {
    const req = request(app)
      .post(`/api/v1${path}`)
      .set('Cookie', account.cookie)
      .set('X-CSRF-Token', account.csrfToken);
    return body ? req.send(body) : req;
  };
  const createWorkspace = async (owner: Account, label: string): Promise<string> =>
    (await post(owner, '/workspaces', { name: name(label) })).body.data.workspace.id;
  const invite = (owner: Account, workspaceId: string, email: string) =>
    post(owner, `/workspaces/${workspaceId}/invitations`, { email });
  const tokenFrom = (res: request.Response): string =>
    String(res.body.data.delivery.devAcceptPath).split('#token=')[1]!;
  const membershipsIn = (workspaceId: string, userId: string) =>
    db.workspaceMember.findMany({ where: { workspaceId, userId } });

  beforeAll(async () => {
    ({ app, db } = buildAppWithDatabase(
      testConfig(TEST_DATABASE_URL, {
        DATABASE_POOL_MAX: '5',
        DATABASE_CONNECT_TIMEOUT_MS: '15000',
        INVITATION_DEV_LINKS: 'true',
      }),
    ));
    await assertIsTestDatabase(db);
    const [table] = await db.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public.workspace_invitations') IS NOT NULL AS "exists"`;
    if (!table?.exists)
      throw new Error('Test database is not migrated. Run: npm run db:test:deploy');
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { name: { startsWith: `it-${RUN} ` } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${RUN_DOMAIN}` } } });
    await db.$disconnect();
  });

  it('owner invites a registered user; only the token hash is stored', async () => {
    const owner = await signUp('owner1');
    await signUp('invitee1');
    const workspaceId = await createWorkspace(owner, 'Invite 1');

    const before = Date.now();
    const res = await invite(owner, workspaceId, `  ${emailOf('INVITEE1')} `);

    expect(res.status).toBe(201);
    expect(res.body.data.invitation).toEqual({
      id: expect.any(String),
      workspaceId,
      email: emailOf('invitee1'),
      status: 'PENDING',
      expiresAt: expect.any(String),
      createdAt: expect.any(String),
    });
    expect(res.body.data.delivery).toEqual({
      emailSent: false,
      devAcceptPath: expect.stringMatching(/^\/invitations\/accept#token=[A-Za-z0-9_-]{43}$/),
    });

    const token = tokenFrom(res);
    const row = await db.workspaceInvitation.findUniqueOrThrow({
      where: { id: res.body.data.invitation.id },
    });
    expect(Buffer.from(row.tokenHash).equals(sha256(token))).toBe(true);
    expect(
      JSON.stringify(row, (_k, v) =>
        v instanceof Uint8Array ? Buffer.from(v).toString('base64url') : v,
      ),
    ).not.toContain(token);
    expect(row).toMatchObject({
      inviterId: owner.id,
      status: 'PENDING',
      email: emailOf('invitee1'),
    });
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600 * 1000 + 60_000);
  }, 60_000);

  it('enforces owner-only creation and anti-enumeration', async () => {
    const owner = await signUp('owner2');
    const member = await signUp('member2');
    const outsider = await signUp('outsider2');
    await signUp('target2');
    const workspaceId = await createWorkspace(owner, 'Invite 2');
    await db.workspaceMember.create({
      data: { workspaceId, userId: member.id, role: WorkspaceRole.MEMBER },
    });

    expect((await invite(member, workspaceId, emailOf('target2'))).status).toBe(403);
    expect((await invite(outsider, workspaceId, emailOf('target2'))).status).toBe(404);
    expect((await invite(owner, randomUUID(), emailOf('target2'))).status).toBe(404);
    expect((await invite(owner, 'not-a-uuid', emailOf('target2'))).status).toBe(400);
    expect((await invite(owner, workspaceId, 'not-an-email')).status).toBe(400);
    expect(
      (
        await post(owner, `/workspaces/${workspaceId}/invitations`, {
          email: emailOf('target2'),
          role: 'OWNER',
        })
      ).status,
    ).toBe(400);
    expect(await db.workspaceInvitation.count({ where: { workspaceId } })).toBe(0);
  }, 60_000);

  it('rejects unregistered emails, existing members and duplicate pending invitations', async () => {
    const owner = await signUp('owner3');
    const member = await signUp('member3');
    await signUp('target3');
    const workspaceId = await createWorkspace(owner, 'Invite 3');
    await db.workspaceMember.create({ data: { workspaceId, userId: member.id } });

    const unregistered = await invite(owner, workspaceId, emailOf('nobody3'));
    expect(unregistered.status).toBe(422);
    expect((await invite(owner, workspaceId, member.email)).status).toBe(409);
    expect((await invite(owner, workspaceId, owner.email)).status).toBe(409);

    expect((await invite(owner, workspaceId, emailOf('target3'))).status).toBe(201);
    const duplicate = await invite(owner, workspaceId, emailOf('TARGET3'));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toBe(
      'A pending invitation already exists for this email address.',
    );
  }, 60_000);

  it('allows exactly one pending invitation under concurrent creation', async () => {
    const owner = await signUp('owner4');
    await signUp('target4');
    const workspaceId = await createWorkspace(owner, 'Invite 4');

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => invite(owner, workspaceId, emailOf('target4'))),
    );

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await db.workspaceInvitation.count({ where: { workspaceId, status: 'PENDING' } })).toBe(
      1,
    );
  }, 60_000);

  it('accepts once: exactly one MEMBER membership, single-use token', async () => {
    const owner = await signUp('owner5');
    const invitee = await signUp('invitee5');
    const other = await signUp('other5');
    const workspaceId = await createWorkspace(owner, 'Invite 5');
    const created = await invite(owner, workspaceId, invitee.email);
    const token = tokenFrom(created);

    const wrongUser = await post(other, '/invitations/accept', { token });
    expect(wrongUser.status).toBe(403);
    expect(wrongUser.body.error.message).toBe(
      'This invitation was sent to a different email address.',
    );
    expect(await membershipsIn(workspaceId, other.id)).toHaveLength(0);

    const accepted = await post(invitee, '/invitations/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toEqual({
      workspace: { id: workspaceId, name: name('Invite 5'), createdAt: expect.any(String) },
      membership: { role: 'MEMBER' },
    });
    expect(await membershipsIn(workspaceId, invitee.id)).toEqual([
      expect.objectContaining({ role: 'MEMBER' }),
    ]);
    const row = await db.workspaceInvitation.findUniqueOrThrow({
      where: { id: created.body.data.invitation.id },
    });
    expect(row.status).toBe('ACCEPTED');

    const again = await post(invitee, '/invitations/accept', { token });
    expect(again.status).toBe(409);
    expect((await post(invitee, '/invitations/decline', { token })).status).toBe(409);

    const list = await request(app).get('/api/v1/workspaces').set('Cookie', invitee.cookie);
    expect(list.body.data.workspaces).toEqual([
      expect.objectContaining({ id: workspaceId, role: 'MEMBER' }),
    ]);
  }, 60_000);

  it('lets exactly one of several concurrent acceptances succeed', async () => {
    const owner = await signUp('owner6');
    const invitee = await signUp('invitee6');
    const workspaceId = await createWorkspace(owner, 'Invite 6');
    const token = tokenFrom(await invite(owner, workspaceId, invitee.email));

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => post(invitee, '/invitations/accept', { token })),
    );

    // Under heavy load a request may be refused with the retryable 503 (rolled
    // back, nothing written); every other outcome must be 200 or 409, never two
    // successes, and the database must reflect exactly the reported success.
    const statuses = responses.map((r) => r.status);
    for (const status of statuses) expect([200, 409, 503]).toContain(status);
    const successes = statuses.filter((s) => s === 200).length;
    expect(successes).toBeLessThanOrEqual(1);
    if (!statuses.includes(503)) expect(successes).toBe(1);
    expect(await membershipsIn(workspaceId, invitee.id)).toHaveLength(successes);
  }, 60_000);

  it('declines, and declined invitations cannot be used', async () => {
    const owner = await signUp('owner7');
    const invitee = await signUp('invitee7');
    const workspaceId = await createWorkspace(owner, 'Invite 7');
    const created = await invite(owner, workspaceId, invitee.email);
    const token = tokenFrom(created);

    expect((await post(invitee, '/invitations/decline', { token })).status).toBe(200);
    expect(
      (
        await db.workspaceInvitation.findUniqueOrThrow({
          where: { id: created.body.data.invitation.id },
        })
      ).status,
    ).toBe('DECLINED');
    expect((await post(invitee, '/invitations/accept', { token })).status).toBe(409);
    expect(await membershipsIn(workspaceId, invitee.id)).toHaveLength(0);
  }, 60_000);

  it('owner can inspect and revoke; revoked invitations cannot be accepted', async () => {
    const owner = await signUp('owner8');
    const member = await signUp('member8');
    const outsider = await signUp('outsider8');
    const invitee = await signUp('invitee8');
    const workspaceId = await createWorkspace(owner, 'Invite 8');
    await db.workspaceMember.create({ data: { workspaceId, userId: member.id } });
    const created = await invite(owner, workspaceId, invitee.email);
    const id = created.body.data.invitation.id as string;
    const get = (account: Account) =>
      request(app)
        .get(`/api/v1/workspaces/${workspaceId}/invitations/${id}`)
        .set('Cookie', account.cookie);

    const status = await get(owner);
    expect(status.status).toBe(200);
    expect(status.body.data.invitation).toMatchObject({
      id,
      status: 'PENDING',
      email: invitee.email,
    });
    expect(JSON.stringify(status.body)).not.toMatch(/token|hash|inviter/i);
    expect((await get(member)).status).toBe(403);
    expect((await get(outsider)).status).toBe(404);

    expect((await post(member, `/workspaces/${workspaceId}/invitations/${id}/revoke`)).status).toBe(
      403,
    );
    const revoked = await post(owner, `/workspaces/${workspaceId}/invitations/${id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.invitation.status).toBe('REVOKED');
    expect((await post(owner, `/workspaces/${workspaceId}/invitations/${id}/revoke`)).status).toBe(
      409,
    );

    expect((await post(invitee, '/invitations/accept', { token: tokenFrom(created) })).status).toBe(
      409,
    );
    expect(await membershipsIn(workspaceId, invitee.id)).toHaveLength(0);
  }, 60_000);

  it('expires: 410 on use, persisted as EXPIRED, and a fresh invitation is allowed', async () => {
    const owner = await signUp('owner9');
    const invitee = await signUp('invitee9');
    const workspaceId = await createWorkspace(owner, 'Invite 9');
    const created = await invite(owner, workspaceId, invitee.email);
    const id = created.body.data.invitation.id as string;
    await db.workspaceInvitation.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // Still PENDING in the table, but a new invitation replaces it.
    const fresh = await invite(owner, workspaceId, invitee.email);
    expect(fresh.status).toBe(201);
    expect((await db.workspaceInvitation.findUniqueOrThrow({ where: { id } })).status).toBe(
      'EXPIRED',
    );

    const old = await post(invitee, '/invitations/accept', { token: tokenFrom(created) });
    expect(old.status).toBe(410);
    expect(old.body.error.message).toBe('This invitation has expired.');

    // An expired-but-not-yet-marked invitation is persisted as EXPIRED on use.
    await db.workspaceInvitation.update({
      where: { id: fresh.body.data.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await post(invitee, '/invitations/accept', { token: tokenFrom(fresh) })).status).toBe(
      410,
    );
    expect(
      (
        await db.workspaceInvitation.findUniqueOrThrow({
          where: { id: fresh.body.data.invitation.id },
        })
      ).status,
    ).toBe('EXPIRED');
    expect(await membershipsIn(workspaceId, invitee.id)).toHaveLength(0);
  }, 60_000);

  it('rolls the acceptance back if the membership cannot be created', async () => {
    const owner = await signUp('owner10');
    const invitee = await signUp('invitee10');
    const workspaceId = await createWorkspace(owner, 'Invite 10');
    const created = await invite(owner, workspaceId, invitee.email);
    // The invitee joins by other means before accepting.
    await db.workspaceMember.create({ data: { workspaceId, userId: invitee.id } });

    const res = await post(invitee, '/invitations/accept', { token: tokenFrom(created) });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('You are already a member of this workspace.');
    // The status update was rolled back with the failed membership insert.
    expect(
      (
        await db.workspaceInvitation.findUniqueOrThrow({
          where: { id: created.body.data.invitation.id },
        })
      ).status,
    ).toBe('PENDING');
    expect(await membershipsIn(workspaceId, invitee.id)).toHaveLength(1);
  }, 60_000);

  it('rejects unknown and malformed tokens', async () => {
    const someone = await signUp('someone11');
    expect((await post(someone, '/invitations/accept', { token: 'a'.repeat(43) })).status).toBe(
      404,
    );
    expect((await post(someone, '/invitations/accept', { token: 'short' })).status).toBe(400);
    expect((await post(someone, '/invitations/accept', {})).status).toBe(400);
  }, 30_000);

  it('deletes invitations with their workspace (cascade)', async () => {
    const owner = await signUp('owner12');
    const invitee = await signUp('invitee12');
    const workspaceId = await createWorkspace(owner, 'Invite 12');
    await invite(owner, workspaceId, invitee.email);

    await db.workspace.delete({ where: { id: workspaceId } });

    expect(await db.workspaceInvitation.count({ where: { workspaceId } })).toBe(0);
  }, 60_000);
});
