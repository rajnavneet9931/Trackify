import { describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest, getCsrfToken, setCsrfToken } from './api-client';

function respond(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('apiRequest', () => {
  it('unwraps the data envelope and sends JSON', async () => {
    const fetchSpy = respond(201, { data: { id: 1 } });

    await expect(apiRequest('/things', { method: 'POST', body: { a: 1 } })).resolves.toEqual({
      id: 1,
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/v1/things');
    expect(init).toMatchObject({ method: 'POST', body: '{"a":1}', credentials: 'include' });
  });

  it('maps the error envelope to ApiError', async () => {
    respond(404, { error: { code: 'NOT_FOUND', message: 'Nope', requestId: 'req-1' } });

    const error = await apiRequest('/missing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Nope',
      requestId: 'req-1',
    });
  });

  it('falls back gracefully on non-JSON error bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502 }));

    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' });
  });
});

describe('CSRF token handling', () => {
  function capture() {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
  }
  const headersOf = (spy: ReturnType<typeof capture>, call = 0) =>
    new Headers(spy.mock.calls[call]![1]!.headers);

  it('attaches X-CSRF-Token to state-changing requests once a token is known', async () => {
    const spy = capture();
    setCsrfToken('token-123');

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await apiRequest('/x', { method });
    }

    for (let call = 0; call < 4; call++) {
      expect(headersOf(spy, call).get('X-CSRF-Token')).toBe('token-123');
    }
  });

  it('never sends it on safe requests', async () => {
    const spy = capture();
    setCsrfToken('token-123');

    await apiRequest('/x');
    await apiRequest('/x', { method: 'HEAD' });

    expect(headersOf(spy, 0).has('X-CSRF-Token')).toBe(false);
    expect(headersOf(spy, 1).has('X-CSRF-Token')).toBe(false);
  });

  it('sends no header when no token is known, and stops after it is cleared', async () => {
    const spy = capture();
    await apiRequest('/x', { method: 'POST' });
    setCsrfToken('token-123');
    setCsrfToken(null);
    await apiRequest('/x', { method: 'POST' });

    expect(headersOf(spy, 0).has('X-CSRF-Token')).toBe(false);
    expect(headersOf(spy, 1).has('X-CSRF-Token')).toBe(false);
    expect(getCsrfToken()).toBeNull();
  });

  it('keeps the token out of browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setCsrfToken('token-123');

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain('token-123');
  });
});

describe('request details', () => {
  it('does not set a JSON content type for FormData bodies', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const form = new FormData();
    form.append('file', 'x');

    await apiRequest('/upload', { method: 'POST', body: form });

    const init = spy.mock.calls[0]![1]!;
    expect(init.body).toBe(form);
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
  });

  it('falls back to the X-Request-Id response header for error references', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'x-request-id': 'req-9' },
      }),
    );

    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 502, requestId: 'req-9' });
  });

  it('reports timeouts distinctly from network failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('slow', 'TimeoutError'));
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 0, code: 'TIMEOUT' });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});
