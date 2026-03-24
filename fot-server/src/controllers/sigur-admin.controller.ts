import { Response } from 'express';
import {
  syncOrganizationsLogic,
  cleanDuplicateOrganizationsLogic,
  seedPositionsLogic,
} from '../services/sigur-sync.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

export const sigurAdminController = {
  /**
   * POST /api/sigur/seed-positions
   * Предзаполнение справочника должностей строительной организации
   */
  async seedPositions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const result = await seedPositionsLogic(organizationId);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Sigur seedPositions error:', error);
      res.status(500).json({ success: false, error: 'Ошибка создания справочника должностей' });
    }
  },

  /**
   * POST /api/sigur/sync-organizations
   * Импорт отделов Sigur как организаций в БД
   */
  async syncOrganizations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const result = await syncOrganizationsLogic(connection);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Sigur syncOrganizations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта организаций из Sigur' });
    }
  },

  /**
   * POST /api/sigur/clean-duplicate-organizations
   * Удаление дублей организаций
   */
  async cleanDuplicateOrganizations(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const result = await cleanDuplicateOrganizationsLogic();
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('cleanDuplicateOrganizations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки дублей организаций' });
    }
  },
};
