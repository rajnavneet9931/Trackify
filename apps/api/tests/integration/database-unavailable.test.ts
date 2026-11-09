/**
 * Real Prisma + pg stack against databases that are down — no external
 * database needed. Verifies the API degrades safely and never leaks details.
 */
import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/config/logger.js';
import { errorHandler } from '../../src/core/middleware/error-handler.js';
import { requestLogger } from '../../src/core/middleware/request-logger.js';
import { createDatabaseClient } from '../../src/infrastructure/database/prisma.js';
import { buildAppWithDatabase, sensitiveFragments, testConfig } from '../support/database.js';
import { getClosedPort, startSilentServer } from '../support/tcp.js';

function expectNoLeaks(body: unknown, databaseUrl: string) {
  const serialized = JSON.stringify(body);
  for (const fragment of sensitiveFragments(databaseUrl)) {
    expect(serialized).not.toContain(fragment);
  }
}

describe('database refusing connections', () => {
  let databaseUrl: string;

  beforeAll(async () => {
    const port = await getClosedPort();
    databaseUrl = `postgresql://trackify_user:SuperSecret123@127.0.0.1:${port}/trackify_down`;
  });

  it('keeps liveness healthy without touching the database', async () => {
    const { app, db } = buildAppWithDatabase(testConfig(databaseUrl));

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    await db.$disconnect();
  });

  it('reports not_ready (503) quickly and without connection details', async () => {
    const { app, db } = buildAppWithDatabase(testConfig(databaseUrl));

    const startedAt = Date.now();
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.data).toMatchObject({ status: 'not_ready', checks: { database: 'down' } });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expectNoLeaks(res.body, databaseUrl);
    await db.$disconnect();
  });

  it('fails registration with a generic 503 and no details', async () => {
    const { app, db } = buildAppWithDatabase(testConfig(databaseUrl));

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'ada@example.com', password: 'correct horse battery staple' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('correct horse battery staple');
    expectNoLeaks(res.body, databaseUrl);
    await db.$disconnect();
  });

  it('fails login and session checks with 503 (not 401) and no details', async () => {
    const { app, db } = buildAppWithDatabase(testConfig(databaseUrl));

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: 'correct horse battery staple' });
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`);
    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`)
      .set('X-CSRF-Token', 'b'.repeat(43));

    const workspace = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`)
      .set('X-CSRF-Token', 'b'.repeat(43))
      .send({ name: 'Team' });

    const detail = await request(app)
      .get('/api/v1/workspaces/01a14e7b-cea3-700d-aeda-085cd44166ed/members')
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`);

    const acceptInvitation = await request(app)
      .post('/api/v1/invitations/accept')
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`)
      .set('X-CSRF-Token', 'b'.repeat(43))
      .send({ token: 'c'.repeat(43) });

    const removeMember = await request(app)
      .delete(
        '/api/v1/workspaces/01a14e7b-cea3-700d-aeda-085cd44166ed/members/01a14e7b-cea3-700d-aeda-085cd44166ee',
      )
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`)
      .set('X-CSRF-Token', 'b'.repeat(43));

    const changeRole = await request(app)
      .patch(
        '/api/v1/workspaces/01a14e7b-cea3-700d-aeda-085cd44166ed/members/01a14e7b-cea3-700d-aeda-085cd44166ee/role',
      )
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`)
      .set('X-CSRF-Token', 'b'.repeat(43))
      .send({ role: 'OWNER' });

    const createProject = await request(app)
      .post('/api/v1/workspaces/01a14e7b-cea3-700d-aeda-085cd44166ed/projects')
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`)
      .set('X-CSRF-Token', 'b'.repeat(43))
      .send({ name: 'Roadmap' });

    const listProjects = await request(app)
      .get('/api/v1/workspaces/01a14e7b-cea3-700d-aeda-085cd44166ed/projects')
      .set('Cookie', `trackify_session=${'a'.repeat(43)}`);

    const projectPath =
      '/api/v1/workspaces/01a14e7b-cea3-700d-aeda-085cd44166ed/projects/01a14e7b-cea3-700d-aeda-085cd44166ee';
    const asSession = <T extends request.Test>(req: T) =>
      req.set('Cookie', `trackify_session=${'a'.repeat(43)}`).set('X-CSRF-Token', 'b'.repeat(43));
    const projectDetail = await asSession(request(app).get(projectPath));
    const editProject = await asSession(request(app).patch(projectPath)).send({
      name: 'Roadmap',
      expectedUpdatedAt: '2026-11-03T10:00:00.000Z',
    });
    const archiveProject = await asSession(request(app).post(`${projectPath}/archive`));
    const restoreProject = await asSession(request(app).post(`${projectPath}/restore`));
    const deleteProject = await asSession(request(app).delete(projectPath));
    const taskPath = `${projectPath}/tasks`;
    const createTask = await asSession(request(app).post(taskPath)).send({ title: 'Roadmap' });
    const listTasks = await asSession(request(app).get(taskPath));
    const taskDetail = await asSession(
      request(app).get(`${taskPath}/01a14e7b-cea3-700d-aeda-085cd44166ef`),
    );
    const editTask = await asSession(
      request(app).patch(`${taskPath}/01a14e7b-cea3-700d-aeda-085cd44166ef`),
    ).send({ status: 'DONE', expectedUpdatedAt: '2026-11-03T10:00:00.000Z' });
    const assignTask = await asSession(
      request(app).patch(`${taskPath}/01a14e7b-cea3-700d-aeda-085cd44166ef/assignee`),
    ).send({ assigneeId: null });
    const commentsPath = `${taskPath}/01a14e7b-cea3-700d-aeda-085cd44166ef/comments`;
    const commentPath = `${commentsPath}/01a14e7b-cea3-700d-aeda-085cd44166f0`;
    const createComment = await asSession(request(app).post(commentsPath)).send({ content: 'Hi' });
    const listComments = await asSession(request(app).get(commentsPath));
    const editComment = await asSession(request(app).patch(commentPath)).send({
      content: 'Hi',
      expectedUpdatedAt: '2026-11-03T10:00:00.000Z',
    });
    const deleteComment = await asSession(request(app).delete(commentPath));
    const listActivities = await asSession(
      request(app).get(`${taskPath}/01a14e7b-cea3-700d-aeda-085cd44166ef/activities`),
    );

    const notifications = await asSession(request(app).get('/api/v1/notifications'));

    for (const res of [
      login,
      me,
      logout,
      workspace,
      detail,
      acceptInvitation,
      removeMember,
      changeRole,
      createProject,
      listProjects,
      projectDetail,
      editProject,
      archiveProject,
      restoreProject,
      deleteProject,
      createTask,
      listTasks,
      taskDetail,
      editTask,
      assignTask,
      createComment,
      listComments,
      editComment,
      deleteComment,
      listActivities,
      notifications,
    ]) {
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.headers['set-cookie']).toBeUndefined();
      expectNoLeaks(res.body, databaseUrl);
    }
    await db.$disconnect();
  });

  it('maps database failures in any route to a generic 503 error', async () => {
    const config = testConfig(databaseUrl);
    const db = createDatabaseClient(config.database);
    const app = express();
    app.use(requestLogger(createLogger(config)));
    app.get('/uses-db', async () => {
      await db.$queryRaw`SELECT 1`;
    });
    app.use(errorHandler);

    const res = await request(app).get('/uses-db');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable. Please try again later.',
    });
    expect(res.body.error.details).toBeUndefined();
    expectNoLeaks(res.body, databaseUrl);
    await db.$disconnect();
  });
});

describe('database accepting TCP but never responding', () => {
  it('bounds the readiness probe by HEALTH_DB_TIMEOUT_MS', async () => {
    const silent = await startSilentServer();
    const databaseUrl = `postgresql://u:p@127.0.0.1:${silent.port}/hung`;
    const { app, db } = buildAppWithDatabase(
      testConfig(databaseUrl, { HEALTH_DB_TIMEOUT_MS: '500', DATABASE_CONNECT_TIMEOUT_MS: '5000' }),
    );

    const startedAt = Date.now();
    const res = await request(app).get('/api/v1/health/ready');
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(503);
    expect(res.body.data.checks.database).toBe('down');
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000);

    // Drop the hung server first: $disconnect() otherwise waits for the pending
    // connection attempt to reach DATABASE_CONNECT_TIMEOUT_MS.
    await silent.close();
    await db.$disconnect();
  });
});
