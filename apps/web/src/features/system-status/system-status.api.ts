import { apiRequest } from '../../lib/api-client';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: { database: 'up' | 'down' };
  timestamp: string;
}

export function fetchReadiness(signal?: AbortSignal): Promise<ReadinessReport> {
  // 503 is a valid readiness answer ("not ready"), not a transport failure.
  return apiRequest<ReadinessReport>('/health/ready', signal ? { signal } : {}, [503]);
}
