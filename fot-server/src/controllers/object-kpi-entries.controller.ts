import type { Response } from 'express';
import { z } from 'zod';

import { withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { AUDIT_ACTIONS, auditService } from '../services/audit.service.js';
import { respondWithError, resolveActorName } from './object-kpi.controller.js';
import type { ObjectKpiActor } from '../services/object-kpi-history.service.js';
import { isObjectInScope } from '../services/object-kpi-scope.service.js';
import { fixMonthPlan, revisePlan } from '../services/object-kpi-plan.service.js';
import { runPlanFreezerOnce } from '../services/object-kpi-plan-freezer.service.js';
import {
  createAddendum,
  createContract,
  createKs2Entry,
  deleteAddendum,
  deleteKs2Entry,
  getContractById,
  setAddendumStatus,
  setKs2Status,
  updateAddendum,
  updateContract,
  updateKs2Entry,
} from '../services/object-kpi.service.js';
import {
  createAssignment,
  createGlobalRole,
  deleteAssignment,
  revokeGlobalRole,
  updateAssignment,
} from '../services/object-kpi-assignments.service.js';

/**
 * Ввод данных KPI-контура: договоры, ДС, акты КС-2, планы, закрепления, роли.
 *
 * Каждый пишущий метод — одна транзакция: блокировка, проверка, запись, история и
 * аудит. Аудит пишется logFromRequestWithClient, то есть тем же клиентом: несохранённая
 * строка аудита обязана откатывать саму операцию, иначе денежная правка окажется
 * незадокументированной.
 */

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD');
const moneySchema = z.union([z.number(), z.string().regex(/^-?\d+(\.\d{1,2})?$/)]);
const versionSchema = z.coerce.number().int().min(1);
const uuidSchema = z.string().uuid();

const contractSchema = z.object({
  contract_number: z.string().trim().max(120).nullish(),
  contract_date: dateSchema.nullish(),
  customer_name: z.string().trim().max(300).nullish(),
  base_amount: moneySchema,
  planned_zos_date: dateSchema.nullish(),
  actual_zos_date: dateSchema.nullish(),
  plan_start_month: dateSchema.nullish(),
  planned_headcount: z.number().int().min(0).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

const addendumSchema = z.object({
  addendum_number: z.string().trim().min(1).max(120),
  addendum_date: dateSchema,
  effective_date: dateSchema,
  amount_delta: moneySchema,
  notes: z.string().trim().max(2000).nullish(),
});

const ks2Schema = z.object({
  entry_kind: z.enum(['act', 'reduction']),
  amount: moneySchema,
  act_number: z.string().trim().min(1).max(120),
  customer_signed_date: dateSchema,
  notes: z.string().trim().max(2000).nullish(),
});

const assignmentSchema = z.object({
  skud_object_id: uuidSchema,
  employee_id: z.number().int().positive(),
  role_kind: z.enum(['construction_manager', 'object_economist']),
  valid_from: dateSchema,
  valid_to: dateSchema.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

async function buildActor(req: AuthenticatedRequest): Promise<ObjectKpiActor> {
  return { userId: req.user.id, userName: await resolveActorName(req.user.id) };
}

/** Объект вне скоупа — 403 до любой записи. Для админа и экономиста скоуп полный. */
async function assertObjectInScope(req: AuthenticatedRequest, objectId: string): Promise<boolean> {
  return isObjectInScope(req, objectId);
}

/**
 * Смена статуса ДС и КС-2 вынесена в общие функции: роуты объявлены явными путями
 * (`/sign`, `/cancel`), без regex-групп в пути — так их видит и `audit:routes`,
 * и человек, читающий список маршрутов.
 */
async function changeAddendumStatus(
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
      const updated = await setAddendumStatus(client, actor, id, status, version, reason);
      await auditService.logFromRequestWithClient(client, req, req.user.id,
        AUDIT_ACTIONS.OBJECT_KPI_ADDENDUM_SAVED, {
          entityType: 'object_contract_addendum',
          entityId: id,
          details: { action: status, reason },
        });
      return updated;
    });
    res.json({ success: true, data: row });
  } catch (error) {
    respondWithError(res, error, '[object-kpi] changeAddendumStatus');
  }
}

async function changeKs2Status(
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
      const updated = await setKs2Status(client, actor, id, status, version, reason);
      await auditService.logFromRequestWithClient(client, req, req.user.id,
        AUDIT_ACTIONS.OBJECT_KPI_KS2_SAVED, {
          entityType: 'object_ks2_entry',
          entityId: id,
          details: { action: status, reason },
        });
      return updated;
    });
    res.json({ success: true, data: row });
  } catch (error) {
    respondWithError(res, error, '[object-kpi] changeKs2Status');
  }
}

export const objectKpiEntriesController = {
  // ─── Договор ──────────────────────────────────────────────────────────────

  async createContract(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = uuidSchema.parse(req.params.objectId);
      const input = contractSchema.parse(req.body);
      if (!(await assertObjectInScope(req, objectId))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const created = await createContract(client, actor, objectId, input);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_CONTRACT_SAVED, {
            entityType: 'object_contract',
            entityId: created.id,
            details: { object_id: objectId, action: 'create' },
          });
        return created;
      });
      res.status(201).json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] createContract');
    }
  },

  async updateContract(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const contractId = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.body.version);
      const reason = typeof req.body.reason === 'string' ? req.body.reason : null;
      const patch = contractSchema.partial().extend({ is_active: z.boolean().optional() }).parse(req.body);

      const existing = await getContractById(contractId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Договор не найден' });
        return;
      }
      if (!(await assertObjectInScope(req, existing.skud_object_id))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const updated = await updateContract(client, actor, contractId, version, patch, reason);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_CONTRACT_SAVED, {
            entityType: 'object_contract',
            entityId: contractId,
            details: { object_id: existing.skud_object_id, action: 'update', reason },
          });
        return updated;
      });
      res.json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] updateContract');
    }
  },

  // ─── Допсоглашения ────────────────────────────────────────────────────────

  async createAddendum(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const contractId = uuidSchema.parse(req.params.id);
      const input = addendumSchema.parse(req.body);
      const contract = await getContractById(contractId);
      if (!contract) {
        res.status(404).json({ success: false, error: 'Договор не найден' });
        return;
      }
      if (!(await assertObjectInScope(req, contract.skud_object_id))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const created = await createAddendum(client, actor, contractId, input);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_ADDENDUM_SAVED, {
            entityType: 'object_contract_addendum',
            entityId: created.id,
            details: { contract_id: contractId, action: 'create' },
          });
        return created;
      });
      res.status(201).json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] createAddendum');
    }
  },

  async updateAddendum(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.body.version);
      const patch = addendumSchema.partial().parse(req.body);

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const updated = await updateAddendum(client, actor, id, version, patch);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_ADDENDUM_SAVED, {
            entityType: 'object_contract_addendum',
            entityId: id,
            details: { action: 'update' },
          });
        return updated;
      });
      res.json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] updateAddendum');
    }
  },

  async signAddendum(req: AuthenticatedRequest, res: Response): Promise<void> {
    await changeAddendumStatus(req, res, 'signed');
  },

  async cancelAddendum(req: AuthenticatedRequest, res: Response): Promise<void> {
    await changeAddendumStatus(req, res, 'cancelled');
  },

  async deleteAddendum(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.query.version);

      const actor = await buildActor(req);
      await withTransaction(async (client) => {
        await deleteAddendum(client, actor, id, version);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_ADDENDUM_SAVED, {
            entityType: 'object_contract_addendum',
            entityId: id,
            details: { action: 'delete' },
          });
      });
      res.json({ success: true });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] deleteAddendum');
    }
  },

  // ─── КС-2 ─────────────────────────────────────────────────────────────────

  async createKs2(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const contractId = uuidSchema.parse(req.params.id);
      const input = ks2Schema.parse(req.body);
      const contract = await getContractById(contractId);
      if (!contract) {
        res.status(404).json({ success: false, error: 'Договор не найден' });
        return;
      }
      if (!(await assertObjectInScope(req, contract.skud_object_id))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const created = await createKs2Entry(client, actor, contractId, input);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_KS2_SAVED, {
            entityType: 'object_ks2_entry',
            entityId: created.id,
            details: { contract_id: contractId, action: 'create' },
          });
        return created;
      });
      res.status(201).json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] createKs2');
    }
  },

  async updateKs2(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.body.version);
      const patch = ks2Schema.partial().parse(req.body);

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const updated = await updateKs2Entry(client, actor, id, version, patch);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_KS2_SAVED, {
            entityType: 'object_ks2_entry',
            entityId: id,
            details: { action: 'update' },
          });
        return updated;
      });
      res.json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] updateKs2');
    }
  },

  async signKs2(req: AuthenticatedRequest, res: Response): Promise<void> {
    await changeKs2Status(req, res, 'signed');
  },

  async cancelKs2(req: AuthenticatedRequest, res: Response): Promise<void> {
    await changeKs2Status(req, res, 'cancelled');
  },

  async deleteKs2(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.query.version);

      const actor = await buildActor(req);
      await withTransaction(async (client) => {
        await deleteKs2Entry(client, actor, id, version);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_KS2_SAVED, {
            entityType: 'object_ks2_entry',
            entityId: id,
            details: { action: 'delete' },
          });
      });
      res.json({ success: true });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] deleteKs2');
    }
  },

  // ─── План месяца ──────────────────────────────────────────────────────────

  async fixPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = uuidSchema.parse(req.params.objectId);
      const periodMonth = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).parse(req.params.periodMonth);
      if (!(await assertObjectInScope(req, objectId))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const fixed = await fixMonthPlan(client, actor, objectId, periodMonth, 'manual');
        if (fixed) {
          await auditService.logFromRequestWithClient(client, req, req.user.id,
            AUDIT_ACTIONS.OBJECT_KPI_PLAN_FIXED, {
              entityType: 'object_kpi_month_plan',
              entityId: fixed.id,
              details: { object_id: objectId, period_month: periodMonth },
            });
        }
        return fixed;
      });

      // null = месяц уже закрыт. Для ручной кнопки это конфликт, а не «всё хорошо».
      if (!row) {
        res.status(409).json({
          success: false,
          code: 'plan_frozen',
          error: 'План этого месяца уже зафиксирован',
        });
        return;
      }
      res.json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] fixPlan');
    }
  },

  /** Пересмотр закрытого месяца: новая ревизия, право проверяется в БД внутри транзакции. */
  async revisePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = uuidSchema.parse(req.params.objectId);
      const periodMonth = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).parse(req.params.periodMonth);
      const body = z.object({
        reason: z.string().trim().min(1, 'Укажите основание пересмотра плана'),
        override_plan_amount: moneySchema.nullish(),
      }).parse(req.body);

      if (!(await assertObjectInScope(req, objectId))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const revised = await revisePlan(
          client, actor, req.user.employee_id, req.user.is_admin, objectId, periodMonth, body,
        );
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_PLAN_REVISED, {
            entityType: 'object_kpi_month_plan',
            entityId: revised.id,
            details: {
              object_id: objectId,
              period_month: periodMonth,
              revision: revised.revision,
              reason: body.reason,
            },
          });
        return revised;
      });
      res.json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] revisePlan');
    }
  },

  /** Ручной прогон авто-фиксации — кнопка администратора, не ждать часа тика. */
  async runFreezer(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const summary = await runPlanFreezerOnce({ force: req.body?.force === true });
      res.json({ success: true, data: summary });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] runFreezer');
    }
  },

  // ─── Закрепления и роли ───────────────────────────────────────────────────

  async createAssignment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const input = assignmentSchema.parse(req.body);
      if (!(await assertObjectInScope(req, input.skud_object_id))) {
        res.status(403).json({ success: false, error: 'Объект вне вашего доступа' });
        return;
      }

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const created = await createAssignment(client, actor, input);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_ASSIGNMENT_CHANGED, {
            entityType: 'object_kpi_assignment',
            entityId: created.id,
            details: { action: 'create', ...input },
          });
        return created;
      });
      res.status(201).json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] createAssignment');
    }
  },

  async updateAssignment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.body.version);
      const patch = z.object({
        valid_from: dateSchema.optional(),
        valid_to: dateSchema.nullish(),
        notes: z.string().trim().max(2000).nullish(),
      }).parse(req.body);

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const updated = await updateAssignment(client, actor, id, version, patch);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_ASSIGNMENT_CHANGED, {
            entityType: 'object_kpi_assignment',
            entityId: id,
            details: { action: 'update', ...patch },
          });
        return updated;
      });
      res.json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] updateAssignment');
    }
  },

  async deleteAssignment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const version = versionSchema.parse(req.query.version);

      const actor = await buildActor(req);
      await withTransaction(async (client) => {
        await deleteAssignment(client, actor, id, version);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_ASSIGNMENT_CHANGED, {
            entityType: 'object_kpi_assignment',
            entityId: id,
            details: { action: 'delete' },
          });
      });
      res.json({ success: true });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] deleteAssignment');
    }
  },

  /** Только админ: роль даёт право пересматривать закрытые месяцы (эскалация привилегий). */
  async createGlobalRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const input = z.object({
        employee_id: z.number().int().positive(),
        valid_from: dateSchema,
        valid_to: dateSchema.nullish(),
        notes: z.string().trim().max(2000).nullish(),
      }).parse(req.body);

      const actor = await buildActor(req);
      const row = await withTransaction(async (client) => {
        const created = await createGlobalRole(client, actor, input);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_GLOBAL_ROLE_CHANGED, {
            entityType: 'object_kpi_global_role',
            entityId: created.id,
            details: { action: 'create', ...input },
          });
        return created;
      });
      res.status(201).json({ success: true, data: row });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] createGlobalRole');
    }
  },

  async revokeGlobalRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = uuidSchema.parse(req.params.id);
      const actor = await buildActor(req);
      await withTransaction(async (client) => {
        await revokeGlobalRole(client, actor, id);
        await auditService.logFromRequestWithClient(client, req, req.user.id,
          AUDIT_ACTIONS.OBJECT_KPI_GLOBAL_ROLE_CHANGED, {
            entityType: 'object_kpi_global_role',
            entityId: id,
            details: { action: 'revoke' },
          });
      });
      res.json({ success: true });
    } catch (error) {
      respondWithError(res, error, '[object-kpi] revokeGlobalRole');
    }
  },
};
