import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { getSystemResourcesSnapshot } from '../services/system-resources.service.js';

export const adminSystemResourcesController = {
  async getSystemResources(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await getSystemResourcesSnapshot();
      res.json({ success: true, data });
    } catch (error) {
      console.error('adminSystemResources.getSystemResources error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить метрики сервера' });
    }
  },
};
