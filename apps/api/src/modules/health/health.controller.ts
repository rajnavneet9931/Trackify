import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http/api-response.js';
import type { HealthService } from './health.service.js';

export class HealthController {
  constructor(private readonly service: HealthService) {}

  liveness = (_req: Request, res: Response): void => {
    sendSuccess(res, this.service.getLiveness());
  };

  readiness = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.service.getReadiness();
    sendSuccess(res, report, report.status === 'ready' ? 200 : 503);
  };
}
