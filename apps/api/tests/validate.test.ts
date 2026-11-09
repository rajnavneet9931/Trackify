import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { errorHandler } from '../src/core/middleware/error-handler.js';
import { requestLogger } from '../src/core/middleware/request-logger.js';
import { validate } from '../src/core/middleware/validate.js';

function buildApp() {
  const app = express();
  app.use(requestLogger(createLogger(loadConfig())));
  app.use(express.json());
  app.post(
    '/items/:id',
    validate({
      params: z.object({ id: z.uuid() }),
      query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
      body: z.object({ name: z.string().trim().min(1).max(100) }),
    }),
    (req, res) => {
      res.json({ params: req.params, query: req.query, body: req.body });
    },
  );
  app.use(errorHandler);
  return app;
}

const ID = '3f1c6b4e-2a8d-4f5e-9b7c-1d2e3f4a5b6c';

describe('validate middleware', () => {
  it('passes parsed, coerced and stripped input to the handler', async () => {
    const res = await request(buildApp())
      .post(`/items/${ID}?page=2`)
      .send({ name: '  Roadmap  ', isAdmin: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ params: { id: ID }, query: { page: 2 }, body: { name: 'Roadmap' } });
  });

  it('reports every invalid field with its location', async () => {
    const res = await request(buildApp()).post('/items/not-a-uuid?page=0').send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const locations = res.body.error.details.map((d: { location: string }) => d.location);
    expect(locations).toEqual(['params', 'query', 'body']);
  });
});
