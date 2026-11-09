import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from './helpers.js';

const LOGIN = '/api/v1/auth/login';
const BODY = { email: 'ada@example.com', password: 'correct horse battery staple' };

describe('cross-site request rejection (CSRF layer 1)', () => {
  it('rejects unsafe requests from a disallowed Origin before any work', async () => {
    const res = await request(buildTestApp())
      .post(LOGIN)
      .set('Origin', 'https://evil.example')
      .send(BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects requests the browser marks as cross-site', async () => {
    const res = await request(buildTestApp())
      .post(LOGIN)
      .set('Sec-Fetch-Site', 'cross-site')
      .send(BODY);

    expect(res.status).toBe(403);
  });

  it('rejects the opaque "null" origin (sandboxed frames, data: URLs)', async () => {
    const res = await request(buildTestApp()).post(LOGIN).set('Origin', 'null').send(BODY);
    expect(res.status).toBe(403);
  });

  it('allows the configured frontend origin and same-origin requests', async () => {
    const app = buildTestApp();

    const fromFrontend = await request(app)
      .post(LOGIN)
      .set('Origin', 'http://localhost:5173')
      .set('Sec-Fetch-Site', 'same-site')
      .send(BODY);
    const sameOrigin = await request(app)
      .post(LOGIN)
      .set('Sec-Fetch-Site', 'same-origin')
      .send(BODY);

    // 401: passed the origin check and reached credential verification.
    expect(fromFrontend.status).toBe(401);
    expect(sameOrigin.status).toBe(401);
  });

  it('allows non-browser clients that send no Origin', async () => {
    expect((await request(buildTestApp()).post(LOGIN).send(BODY)).status).toBe(401);
  });

  it('does not affect safe methods', async () => {
    const res = await request(buildTestApp())
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('advertises only the headers the SPA needs in CORS preflights', async () => {
    const res = await request(buildTestApp())
      .options(LOGIN)
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toBe(
      'Content-Type,x-csrf-token,x-request-id',
    );
  });
});
