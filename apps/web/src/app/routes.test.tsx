import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { mockApi, renderApp } from '../test/mock-api';

describe('routing', () => {
  it('renders the home page inside the layout', async () => {
    mockApi();
    renderApp('/');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/plan, track and ship/i);
    expect(screen.getByRole('link', { name: /trackify/i })).toBeInTheDocument();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('shows a degraded database when the API reports not ready (503)', async () => {
    mockApi({
      'GET /api/v1/health/ready': {
        status: 503,
        body: { data: { status: 'not_ready', checks: { database: 'down' }, timestamp: '' } },
      },
    });
    renderApp('/');

    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('shows a friendly message when the API is unreachable', async () => {
    mockApi({
      'GET /api/v1/health/ready': new TypeError('Failed to fetch'),
      'GET /api/v1/auth/me': new TypeError('Failed to fetch'),
    });
    renderApp('/');

    expect(await screen.findByText('Unable to reach the server')).toBeInTheDocument();
  });

  it('renders the 404 page for unknown routes', () => {
    mockApi();
    renderApp('/does/not/exist');

    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});
