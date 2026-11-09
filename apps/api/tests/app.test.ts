import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from './helpers.js';

describe('health module', () => {
  it('GET /api/v1/health reports liveness', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok' });
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
  });

  it('GET /api/v1/health/ready returns 200 when the database is reachable', async () => {
    const res = await request(buildTestApp({ databaseUp: true })).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ready', checks: { database: 'up' } });
  });

  it('GET /api/v1/health/ready returns 503 when the database is unreachable', async () => {
    const res = await request(buildTestApp({ databaseUp: false })).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.data).toMatchObject({ status: 'not_ready', checks: { database: 'down' } });
  });
});

describe('cross-cutting HTTP behaviour', () => {
  it('returns a consistent 404 error envelope for unknown routes', async () => {
    const res = await request(buildTestApp()).get('/api/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects malformed JSON with 400 without leaking parser internals', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Malformed JSON in request body',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|SyntaxError/);
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/health')
      .send({ blob: 'x'.repeat(200 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('generates a request id, and reuses a well-formed incoming one', async () => {
    const app = buildTestApp();

    const generated = await request(app).get('/api/v1/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const reused = await request(app).get('/api/v1/health').set('X-Request-Id', 'trace-abc.123');
    expect(reused.headers['x-request-id']).toBe('trace-abc.123');
  });

  it('replaces an unsafe incoming request id', async () => {
    const res = await request(buildTestApp())
      .get('/api/v1/health')
      .set('X-Request-Id', 'bad id<script>');

    expect(res.headers['x-request-id']).not.toBe('bad id<script>');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(buildTestApp()).get('/api/v1/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('allows configured CORS origins only', async () => {
    const app = buildTestApp();

    const allowed = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
