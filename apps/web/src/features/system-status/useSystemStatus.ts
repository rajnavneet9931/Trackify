import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { fetchReadiness, type ReadinessReport } from './system-status.api';

export type SystemStatus =
  | { state: 'loading' }
  | { state: 'success'; report: ReadinessReport }
  | { state: 'error'; message: string };

export function useSystemStatus() {
  const [status, setStatus] = useState<SystemStatus>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetchReadiness(controller.signal)
      .then((report) => setStatus({ state: 'success', report }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({
          state: 'error',
          message: error instanceof ApiError ? error.message : 'Unexpected error',
        });
      });

    return () => controller.abort();
  }, [attempt]);

  const refresh = useCallback(() => {
    setStatus({ state: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return { status, refresh };
}
