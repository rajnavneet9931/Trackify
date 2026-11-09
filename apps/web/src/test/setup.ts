import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { setCsrfToken } from '../lib/api-client';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The CSRF token lives in module memory; reset it between tests.
  setCsrfToken(null);
  localStorage.clear();
  sessionStorage.clear();
});
