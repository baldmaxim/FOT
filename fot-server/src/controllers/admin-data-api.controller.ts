import { Response } from 'express';
import { z } from 'zod';
import { auditService } from '../services/audit.service.js';
import { dataApiKeyService } from '../services/data-api-key.service.js';
import { dataApiSchemaService } from '../services/data-api-schema.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const createKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  rate_limit_per_minute: z.number().int().min(1).max(10000).optional(),
  expires_at: z.string().datetime().optional().nullable(),
});

const updateKeySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  rate_limit_per_minute: z.number().int().min(1).max(10000).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

const updateTablesSchema = z.object({
  tables: z.array(z.object({
    table_name: z.string().min(1),
    allowed_fields: z.array(z.string().min(1)).min(1),
  })).max(200),
});

function handleZodError(error: unknown, res: Response): boolean {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Validation failed' });
    return true;
  }
  return false;
}

export const adminDataApiController = {
  async listKeys(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const keys = await dataApiKeyService.listKeys();
      res.json({ success: true, data: keys });
    } catch (error) {
      console.error('Data API listKeys error:', error);
      res.status(500).json({ success: false, error: 'Failed to list API keys' });
    }
  },

  async createKey(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const payload = createKeySchema.parse(req.body);
      const result = await dataApiKeyService.createKey({
        name: payload.name,
        description: payload.description ?? null,
        rate_limit_per_minute: payload.rate_limit_per_minute,
        expires_at: payload.expires_at ?? null,
        created_by: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'DATA_API_KEY_CREATED', {
        entityType: 'data_api_key',
        entityId: result.id,
        details: { name: payload.name, prefix: result.prefix },
      });

      res.status(201).json({
        success: true,
        data: {
          id: result.id,
          prefix: result.prefix,
          // plaintext_token показывается ровно один раз — клиент обязан его сохранить.
          plaintext_token: result.plaintext_token,
        },
      });
    } catch (error) {
      if (handleZodError(error, res)) return;
      console.error('Data API createKey error:', error);
      res.status(500).json({ success: false, error: 'Failed to create API key' });
    }
  },

  async updateKey(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const payload = updateKeySchema.parse(req.body);
      const existing = await dataApiKeyService.getKey(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'API key not found' });
        return;
      }

      await dataApiKeyService.updateKey(id, payload);
      await auditService.logFromRequest(req, req.user.id, 'DATA_API_KEY_UPDATED', {
        entityType: 'data_api_key',
        entityId: id,
        details: payload,
      });

      res.json({ success: true });
    } catch (error) {
      if (handleZodError(error, res)) return;
      console.error('Data API updateKey error:', error);
      res.status(500).json({ success: false, error: 'Failed to update API key' });
    }
  },

  async revokeKey(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const existing = await dataApiKeyService.getKey(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'API key not found' });
        return;
      }
      if (existing.revoked_at) {
        res.json({ success: true, message: 'Already revoked' });
        return;
      }
      await dataApiKeyService.revokeKey(id);
      await auditService.logFromRequest(req, req.user.id, 'DATA_API_KEY_REVOKED', {
        entityType: 'data_api_key',
        entityId: id,
      });
      res.json({ success: true });
    } catch (error) {
      console.error('Data API revokeKey error:', error);
      res.status(500).json({ success: false, error: 'Failed to revoke API key' });
    }
  },

  /**
   * Безвозвратное удаление ключа вместе с логами и доступами.
   * Только для отозванных/истёкших: действующий ключ сначала нужно отозвать —
   * иначе одним кликом можно оборвать боевую интеграцию 1С.
   */
  async deleteKey(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const existing = await dataApiKeyService.getKey(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'API key not found' });
        return;
      }
      const isExpired = !!existing.expires_at && new Date(existing.expires_at).getTime() <= Date.now();
      if (!existing.revoked_at && !isExpired) {
        res.status(400).json({
          success: false,
          error: 'Удалить можно только отозванный или истёкший ключ — сначала отзовите его',
        });
        return;
      }

      await dataApiKeyService.deleteKey(id);
      await auditService.logFromRequest(req, req.user.id, 'DATA_API_KEY_DELETED', {
        entityType: 'data_api_key',
        entityId: id,
        details: { name: existing.name, key_prefix: existing.key_prefix },
      });
      res.json({ success: true });
    } catch (error) {
      console.error('Data API deleteKey error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete API key' });
    }
  },

  async getKeyTables(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const existing = await dataApiKeyService.getKey(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'API key not found' });
        return;
      }
      const tables = await dataApiKeyService.getKeyTables(id);
      res.json({ success: true, data: tables });
    } catch (error) {
      console.error('Data API getKeyTables error:', error);
      res.status(500).json({ success: false, error: 'Failed to load key tables' });
    }
  },

  async updateKeyTables(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const payload = updateTablesSchema.parse(req.body);
      const existing = await dataApiKeyService.getKey(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'API key not found' });
        return;
      }

      // Дополнительная защита: даже если кто-то пошлёт запрос вручную мимо UI,
      // отсекаем чувствительные таблицы и поля.
      const schema = await dataApiSchemaService.getFullSchema();
      const allowedTablesIndex = new Map(schema.map(t => [t.name, new Set(t.columns.map(c => c.name))]));

      for (const entry of payload.tables) {
        const allowedFields = allowedTablesIndex.get(entry.table_name);
        if (!allowedFields) {
          res.status(400).json({ success: false, error: `Таблица ${entry.table_name} недоступна для публичного API` });
          return;
        }
        const invalid = entry.allowed_fields.find(field => !allowedFields.has(field));
        if (invalid) {
          res.status(400).json({ success: false, error: `Поле ${entry.table_name}.${invalid} недоступно` });
          return;
        }
      }

      await dataApiKeyService.replaceKeyTables(id, payload.tables);
      await auditService.logFromRequest(req, req.user.id, 'DATA_API_KEY_TABLES_UPDATED', {
        entityType: 'data_api_key',
        entityId: id,
        details: { tables_count: payload.tables.length },
      });
      res.json({ success: true });
    } catch (error) {
      if (handleZodError(error, res)) return;
      console.error('Data API updateKeyTables error:', error);
      res.status(500).json({ success: false, error: 'Failed to update key tables' });
    }
  },

  async getKeyLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const limit = Math.min(parseInt((req.query.limit as string) || '100', 10) || 100, 500);
      const existing = await dataApiKeyService.getKey(id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'API key not found' });
        return;
      }
      const logs = await dataApiKeyService.getRequestLogs(id, limit);
      res.json({ success: true, data: logs });
    } catch (error) {
      console.error('Data API getKeyLogs error:', error);
      res.status(500).json({ success: false, error: 'Failed to load logs' });
    }
  },

  async getDbSchema(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const schema = await dataApiSchemaService.getFullSchema();
      res.json({ success: true, data: schema });
    } catch (error) {
      console.error('Data API getDbSchema error:', error);
      res.status(500).json({ success: false, error: 'Failed to load DB schema' });
    }
  },
};
