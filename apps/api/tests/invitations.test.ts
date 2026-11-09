import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';

import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/env.js';
import {
  buildTestApp,
  InMemoryInvitationRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  unreachableInvitationRepository,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple';

interface Account {
  id: string;
  email: string;
  cookie: string;
  csrfToken: string;
}

async function setup(
  options: { env?: NodeJS.ProcessEnv; failing?: boolean; logs?: { text: string } } = {},
) {
  const users = new InMemoryUserRepository();
  const workspaces = new InMemoryWorkspaceRepository(users);
  const invitations = new InMemoryInvitationRepository(workspaces);
  const app = buildTestApp({
    userRepository: users,
    sessionRepository: new InMemorySessionRepository(users),
    workspaceRepository: workspaces,
    invitationRepository: options.failing ? unreachableInvitationRepository : invitations,
    env: { INVITATION_DEV_LINKS: 'true', ...options.env },
    ...(options.logs && {
      logger: pino(
        { level: 'trace' },
        new Writable({
          write(chunk, _encoding, done) {
            options.logs!.text += chunk.toString();
            done();
          },
        }),
      ),
    }),
  });
  const signUp = async (email: string): Promise<Account> => {
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
  const owner = await signUp('owner@example.com');
  const invitee = await signUp('invitee@example.com');
  const workspaceId = (await post(owner, '/workspaces', { name: 'Team' })).body.data.workspace
    .id as string;
  return { app, users, workspaces, invitations, signUp, post, owner, invitee, workspaceId };
}

const tokenFrom = (res: request.Response) =>
  String(res.body.data.delivery.devAcceptPath).split('#token=')[1]!;

describe('invitation creation (HTTP contract)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  const invite = (body: object = { email: 'invitee@example.com' }) =>
    ctx.post(ctx.owner, `/workspaces/${ctx.workspaceId}/invitations`, body);

  beforeEach(async () => {
    ctx = await setup();
  });

  it('creates a PENDING invitation and states that no email was sent', async () => {
    const res = await invite();

    expect(res.status).toBe(201);
    expect(res.body.data.invitation).toMatchObject({
      email: 'invitee@example.com',
      status: 'PENDING',
      workspaceId: ctx.workspaceId,
    });
    expect(res.body.data.delivery.emailSent).toBe(false);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body.data.invitation)).not.toMatch(/token|hash|inviter/i);

    const token = tokenFrom(res);
    const stored = ctx.invitations.rows[0]!.tokenHash;
    expect(Buffer.from(stored).equals(createHash('sha256').update(token).digest())).toBe(true);
  });

  it('never returns the token when development links are disabled', async () => {
    const off = await setup({ env: { INVITATION_DEV_LINKS: 'false' } });
    const res = await off.post(off.owner, `/workspaces/${off.workspaceId}/invitations`, {
      email: 'invitee@example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.delivery).toEqual({ emailSent: false });
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it.each([
    ['inviterId', { inviterId: '00000000-0000-7000-8000-000000000001' }],
    ['role', { role: 'OWNER' }],
    ['status', { status: 'ACCEPTED' }],
    ['expiresAt', { expiresAt: '2099-01-01T00:00:00Z' }],
    ['tokenHash', { tokenHash: 'abc' }],
  ])('rejects a client-supplied %s', async (field, extra) => {
    const res = await invite({ email: 'invitee@example.com', ...extra });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toContain(field);
    expect(ctx.invitations.rows).toHaveLength(0);
  });

  it.each([
    ['missing email', {}],
    ['invalid email', { email: 'not-an-email' }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await invite(body)).status).toBe(400);
  });

  it('requires a session (401) before anything else', async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/workspaces/${ctx.workspaceId}/invitations`)
      .send({ email: 'x' });
    expect(res.status).toBe(401);
  });

  it('requires the CSRF token', async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/workspaces/${ctx.workspaceId}/invitations`)
      .set('Cookie', ctx.owner.cookie)
      .send({ email: 'invitee@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Invalid or missing CSRF token');
    expect(ctx.invitations.rows).toHaveLength(0);
  });

  it('rejects a disallowed Origin', async () => {
    const res = await invite().set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(ctx.invitations.rows).toHaveLength(0);
  });

  it('rate-limits invitation creation per user', async () => {
    const limited = await setup({ env: { INVITATION_RATE_LIMIT_MAX: '2' } });
    await limited.signUp('a@example.com');
    await limited.signUp('b@example.com');
    await limited.signUp('c@example.com');
    const path = `/workspaces/${limited.workspaceId}/invitations`;

    const statuses = [];
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      statuses.push((await limited.post(limited.owner, path, { email })).status);
    }
    expect(statuses).toEqual([201, 201, 429]);

    // Another user has their own budget.
    const otherWorkspace = (await limited.post(limited.invitee, '/workspaces', { name: 'Other' }))
      .body.data.workspace.id;
    expect(
      (
        await limited.post(limited.invitee, `/workspaces/${otherWorkspace}/invitations`, {
          email: 'a@example.com',
        })
      ).status,
    ).toBe(201);
  });

  it('returns a generic 503 when the database is unavailable', async () => {
    const failing = await setup({ failing: true });
    const res = await failing.post(
      failing.owner,
      `/workspaces/${failing.workspaceId}/invitations`,
      { email: 'invitee@example.com' },
    );

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host|prisma|P1001/);
  });
});

describe('accept and decline (HTTP contract)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let token: string;

  beforeEach(async () => {
    ctx = await setup();
    token = tokenFrom(
      await ctx.post(ctx.owner, `/workspaces/${ctx.workspaceId}/invitations`, {
        email: 'invitee@example.com',
      }),
    );
  });

  it('accepts and grants MEMBER (never OWNER)', async () => {
    const res = await ctx.post(ctx.invitee, '/invitations/accept', { token });

    expect(res.status).toBe(200);
    expect(res.body.data.membership).toEqual({ role: 'MEMBER' });
    expect(ctx.workspaces.members.filter((m) => m.userId === ctx.invitee.id)).toEqual([
      expect.objectContaining({ role: 'MEMBER', workspaceId: ctx.workspaceId }),
    ]);
  });

  it.each(['/invitations/accept', '/invitations/decline'])(
    '%s requires the CSRF token',
    async (path) => {
      const res = await request(ctx.app)
        .post(`/api/v1${path}`)
        .set('Cookie', ctx.invitee.cookie)
        .send({ token });
      expect(res.status).toBe(403);
      expect(ctx.invitations.rows[0]!.status).toBe('PENDING');
    },
  );

  it.each(['/invitations/accept', '/invitations/decline'])(
    '%s rejects a disallowed Origin',
    async (path) => {
      const res = await ctx
        .post(ctx.invitee, path, { token })
        .set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
      expect(ctx.invitations.rows[0]!.status).toBe('PENDING');
    },
  );

  it('rejects extra fields in the body', async () => {
    const res = await ctx.post(ctx.invitee, '/invitations/accept', { token, role: 'OWNER' });
    expect(res.status).toBe(400);
  });

  it('returns 503 when the database is unavailable', async () => {
    const failing = await setup({ failing: true });
    const res = await failing.post(failing.invitee, '/invitations/accept', {
      token: 'a'.repeat(43),
    });
    expect(res.status).toBe(503);
  });
});

describe('logging', () => {
  it('never logs raw invitation tokens', async () => {
    const logs = { text: '' };
    const ctx = await setup({ logs });
    const res = await ctx.post(ctx.owner, `/workspaces/${ctx.workspaceId}/invitations`, {
      email: 'invitee@example.com',
    });
    const token = tokenFrom(res);
    await ctx.post(ctx.owner, '/invitations/accept', { token }); // wrong account: 403
    await ctx.post(ctx.invitee, '/invitations/accept', { token });
    await ctx.post(ctx.invitee, '/invitations/accept', { token }); // reuse: 409

    expect(logs.text).toContain('/invitations/accept');
    expect(logs.text).not.toContain(token);
  });
});

describe('INVITATION_DEV_LINKS configuration', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

  it('defaults to on in development and off elsewhere', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).invitations.exposeDevLinks).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).invitations.exposeDevLinks).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).invitations.exposeDevLinks).toBe(false);
  });

  it('refuses to start production with development links enabled', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', INVITATION_DEV_LINKS: 'true' }),
    ).toThrow(ConfigError);
  });

  it('bounds the invitation lifetime', () => {
    expect(loadConfig(base).invitations.ttlMs).toBe(7 * 24 * 3600 * 1000);
    expect(() => loadConfig({ ...base, INVITATION_TTL_HOURS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, INVITATION_TTL_HOURS: String(24 * 31) })).toThrow(
      ConfigError,
    );
  });
});
