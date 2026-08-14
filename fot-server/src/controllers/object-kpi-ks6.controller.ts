import type { Response } from 'express';
import { z } from 'zod';

import { withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { AUDIT_ACTIONS, auditService } from '../services/audit.service.js';
import { respondWithError } from './object-kpi.controller.js';
import { buildActor } from './object-kpi-entries.controller.js';
import { dateSchema, moneySchema, uuidSchema, versionSchema } from './object-kpi-schemas.js';
import { isObjectInScope } from '../services/object-kpi-scope.service.js';
import { getContractById } from '../services/object-kpi.service.js';
import {
  createKs6Entry,
  deleteKs6Entry,
  listKs6Entries,
  setKs6Status,
  updateKs6Entry,
} from '../services/object-kpi-ks6.service.js';

/**
 * Реестр КС-6 — справочные записи журнала выполненных работ.
 *
 * Отдельный контроллер, а не блок в object-kpi-entries.controller.ts: тот уже за 600 строк
 * при лимите 500. Транзакционность и аудит — те же: logFromRequestWithClient тем же клиентом,
 * чтобы несохранённый аудит откатывал операцию.
 */

const ks6Schema = z.object({
  // Знака у КС-6 нет: сумма только положительная (CHECK в 243), исправление — аннулирование.
  amount: moneySchema.refine((v) => Number(v) > 0, 'Сумма КС-6 должна быть больше нуля'),
  doc_number: z.string().trim().min(1).max(120),
  customer_signed_date: dateSchema,
  notes: z.string().trim().max(2000).nullish(),
});

const ENTITY_TYPE = 'object_ks6_entry';

async function changeKs6Status(
  req: AuthenticatedRequest,
  res: Response,
  status: 'signed' | 'cancelled',
): Promise<void> {
  try {
    const id = uuidSchema.parse(req.params.id);
    const version = versionSchema.parse(req.body.version);
    const reason = typeof req.body.reason === 'string' ? req.body.reason : null;

    const actor = await buildActor(req);
    const row = await withTransaction(async (client) => {
      const updated = await setKs6Status(client, actor, id, status, version, reason);
      await auditService.logFromRequestWithClient(client, req, req.user.id,
        AUDIT_ACTIONS.OBJECT_KPI_KS6_SAVED, {
          entityType: ENTITY_TYPE,
          entityId: id,
          details: { action: status },
        });
      return updated;
    });
    res.json({ success: true, data: row });
  } catch (error) {
    respondWithError(res, error, `[object-kpi] ${status}Ks6`);
  }
}

export const objectKpiKs6Controller = {
  async listKs6(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const contractId = uuidSchema.parse(req.params.id);
      const contract = await getContractById(contractId);
      if (!contract) {
        res.status(404).json({ success: false, error: 'Договор не найден' });
        return;
      }
      if (!(await isObjectInScope(req, contract.skud_object_id))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }
      res.json({ success: true, data: await listKs6Entries(contractId) });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] listKs6');
    }
  },

  async createKs6(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const contractId = uuidSchema.parse(req.params.id);
      const input = ks6Schema.parse(req.body);
      const contract = await getContractById(contractId);
      if (!contract) {
        res.status(404).json({ success: false, error: 'Договор не найден' });
        return;
      }
      if (!(await isObjectInScope(req, contract.skud_object_id))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const created = await createKs6Entry(client, actor, contractId, input);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_KS6_SAVED, {
            entityType: ENTITY_TYPE,
            entityId: created.id,
            details: { contract_id: contractId, action: 'create' },
          });
        return created;
      });
      res.status(201).json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] createKs6');
    }
  },

  async updateKs6(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.body.version);
      const patch = ks6Schema.partial().parse(req.body);

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const updated = await updateKs6Entry(client, actor, id, version, patch);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_KS6_SAVED, {
            entityType: ENTITY_TYPE,
            entityId: id,
            details: { action: 'update' },
          });
        return updated;
      });
      res.json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] updateKs6');
    }
  },

  async signKs6(req: AuthenticatedRequest, res: Response): Promise<void> {
    await changeKs6Status(req, res, 'signed');
  },

  async cancelKs6(req: AuthenticatedRequest, res: Response): Promise<void> {
    await changeKs6Status(req, res, 'cancelled');
  },

  async deleteKs6(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.query.version);

      const actor = await buildActor(req);
      await withTransaction(async (client) => {
        await deleteKs6Entry(client, actor, id, version);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_KS6_SAVED, {
            entityType: ENTITY_TYPE,
            entityId: id,
            details: { action: 'delete' },
          });
      });
      res.json({ success: true });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] deleteKs6');
    }
  },
};
