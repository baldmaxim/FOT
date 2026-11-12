/**
 * Обработчики плановых удержаний (миграция 357) — одни для кадров и «Зарплаты»; разделы отличаются охватом
 * списков, правом на сотрудника и признаком правки строки (IPlannedDeductionAccess). Правила записи — в сервисе
 * (payroll-planned-deductions.service.ts): пересечение, updated_at, «Убрать», история.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  addPlannedDeduction,
  getPlannedDeduction,
  listPlannedDeductionMonths,
  listPlannedDeductions,
  removePlannedDeduction,
  updatePlannedDeduction,
  type IPlannedDeduction,
  type PlannedDeductionScope,
} from '../services/payroll/payroll-planned-deductions.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { handlePayrollZodError, parsePayrollDictionaryId } from './payroll-dictionary.helpers.js';
import {
  PLANNED_DEDUCTION_NOT_FOUND,
  PLANNED_DEDUCTION_STALE,
  plannedByMonthStarts,
  plannedDeductionAddSchema,
  plannedDeductionAuditDetails,
  plannedDeductionExistsBody,
  plannedDeductionRemoveSchema,
  plannedDeductionUpdateSchema,
  plannedListMonthStarts,
} from './planned-deduction-input.js';
import {
  STAFF_DEDUCTION_REF_MISSING,
  staffDeductionAddRefusal,
  staffDeductionUpdateRefusal,
} from './staff-deduction-input.js';

/** Что у раздела своё: охват, права, признак правки строки и подпись источника в аудите. */
export interface IPlannedDeductionAccess {
  /** 'staff' — кадры, 'deduction_registry' — «Зарплата». */
  source: string;
  scope: (req: AuthenticatedRequest) => Promise<PlannedDeductionScope>;
  /** Можно ли менять строки сотрудника (добавить, ✎, 🗑). */
  canWrite: (req: AuthenticatedRequest, employeeId: number) => Promise<boolean>;
  /** Признак правки строки списка; один раз на запрос. */
  editPredicate: (req: AuthenticatedRequest) => Promise<(employeeId: number) => boolean>;
}

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };

const currentMonth = (): string => moscowTodayIso().slice(0, 7);

const withRowCanEdit = <Row extends { employee_id: number }>(rows: Row[], canEdit: (employeeId: number) => boolean) =>
  rows.map(row => ({ ...row, can_edit: canEdit(row.employee_id) }));

export const createPlannedDeductionHandlers = (access: IPlannedDeductionAccess) => {
  const audit = (req: AuthenticatedRequest, action: Parameters<typeof auditService.logFromRequest>[2],
    id: number, details: Record<string, unknown>) => auditService.logFromRequest(req, req.user.id, action, {
    entityType: 'payroll_planned_deductions',
    entityId: String(id),
    details: { source: access.source, ...details },
  });

  /** Строка по :id, которую можно править; иначе ответ отправлен и null. */
  const writable = async (req: AuthenticatedRequest, res: Response): Promise<{ id: number; current: IPlannedDeduction } | null> => {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getPlannedDeduction(id);
    if (id === null || !current) {
      res.status(404).json(PLANNED_DEDUCTION_NOT_FOUND);
      return null;
    }
    if (!(await access.canWrite(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return null;
    }
    return { id, current };
  };

  /** GET …?months= — периоды, задевающие месяцы (без параметра — текущий, all — все). */
  const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const months = plannedListMonthStarts(req.query.months, currentMonth());
      const [scope, canEdit] = await Promise.all([access.scope(req), access.editPredicate(req)]);
      res.json({ success: true, data: withRowCanEdit(await listPlannedDeductions(scope, months), canEdit) });
    } catch (err) {
      if (handlePayrollZodError(err, res)) return;
      console.error('plannedDeductions.list error:', err);
      res.status(500).json({ success: false, error: 'Ошибка получения плановых удержаний' });
    }
  };

  /** GET …/by-month?months= — плановые по месяцам, как в расчёте (all — 400). */
  const listByMonth = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const months = plannedByMonthStarts(req.query.months, currentMonth());
      const [scope, canEdit] = await Promise.all([access.scope(req), access.editPredicate(req)]);
      res.json({ success: true, data: withRowCanEdit(await listPlannedDeductionMonths(scope, months), canEdit) });
    } catch (err) {
      if (handlePayrollZodError(err, res)) return;
      console.error('plannedDeductions.listByMonth error:', err);
      res.status(500).json({ success: false, error: 'Ошибка получения плановых удержаний' });
    }
  };

  /** POST { employee_id, kind_id, subkind_id?, amount, month_from, month_to?, last_month_amount? } — назначить плановое. */
  const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { employee_id: employeeId, ...input } = plannedDeductionAddSchema.parse(req.body);
      // Как разовое: работающему или уволенному с началом не позже месяца увольнения, не подрядчику, не из архива.
      const refusal = await staffDeductionAddRefusal(employeeId, input.month_from);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }
      if (!(await access.canWrite(req, employeeId))) {
        res.status(403).json(NO_ACCESS);
        return;
      }
      const result = await addPlannedDeduction(employeeId, input, req.user.id);
      if (typeof result === 'string') {
        res.status(409).json(STAFF_DEDUCTION_REF_MISSING[result]);
        return;
      }
      if ('conflict' in result) {
        res.status(409).json(result.conflict === 'exists' ? plannedDeductionExistsBody(result.existing) : PLANNED_DEDUCTION_STALE);
        return;
      }
      await audit(req, 'PAYROLL_PLANNED_DEDUCTION_ADDED', result.id, plannedDeductionAuditDetails(result));
      res.json({ success: true, data: result });
    } catch (err) {
      if (handlePayrollZodError(err, res)) return;
      console.error('plannedDeductions.add error:', err);
      res.status(500).json({ success: false, error: 'Ошибка добавления планового удержания' });
    }
  };

  /** PATCH /:id { kind_id, subkind_id?, amount, month_from, month_to?, last_month_amount?, expected_updated_at } — сотрудник не меняется. */
  const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { expected_updated_at: expected, ...input } = plannedDeductionUpdateSchema.parse(req.body);
      const target = await writable(req, res);
      if (!target) return;
      const refusal = await staffDeductionUpdateRefusal(target.current.employee_id, input.month_from, target.current.month_from);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }
      const result = await updatePlannedDeduction(target.id, input, expected, req.user.id);
      if (result === null) {
        res.status(404).json(PLANNED_DEDUCTION_NOT_FOUND);
        return;
      }
      if (typeof result === 'string') {
        res.status(409).json(STAFF_DEDUCTION_REF_MISSING[result]);
        return;
      }
      if ('conflict' in result) {
        res.status(409).json(result.conflict === 'exists' ? plannedDeductionExistsBody(result.existing) : PLANNED_DEDUCTION_STALE);
        return;
      }
      if (result.changed) {
        await audit(req, 'PAYROLL_PLANNED_DEDUCTION_UPDATED', target.id, {
          from: plannedDeductionAuditDetails(result.before),
          to: plannedDeductionAuditDetails(result.after),
        });
      }
      res.json({ success: true, data: result.after });
    } catch (err) {
      if (handlePayrollZodError(err, res)) return;
      console.error('plannedDeductions.update error:', err);
      res.status(500).json({ success: false, error: 'Ошибка сохранения планового удержания' });
    }
  };

  /**
   * DELETE /:id { expected_updated_at } — «Убрать»: идущее закрывается месяцем перед текущим (прошлые месяцы
   * остаются), не начавшееся или кончившееся — удаляется. Ответ: { action: 'closed' | 'removed', data }.
   */
  const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { expected_updated_at: expected } = plannedDeductionRemoveSchema.parse(req.body ?? {});
      const target = await writable(req, res);
      if (!target) return;
      const result = await removePlannedDeduction(target.id, expected, currentMonth(), req.user.id);
      if (result === null) {
        res.status(404).json(PLANNED_DEDUCTION_NOT_FOUND);
        return;
      }
      if ('conflict' in result) {
        res.status(409).json(PLANNED_DEDUCTION_STALE);
        return;
      }
      if (result.action === 'closed') {
        await audit(req, 'PAYROLL_PLANNED_DEDUCTION_CLOSED', target.id, {
          from: plannedDeductionAuditDetails(result.before),
          to: plannedDeductionAuditDetails(result.after),
        });
        res.json({ success: true, action: 'closed', data: result.after });
        return;
      }
      await audit(req, 'PAYROLL_PLANNED_DEDUCTION_REMOVED', target.id, plannedDeductionAuditDetails(result.before));
      res.json({ success: true, action: 'removed', data: result.before });
    } catch (err) {
      if (handlePayrollZodError(err, res)) return;
      console.error('plannedDeductions.remove error:', err);
      res.status(500).json({ success: false, error: 'Ошибка удаления планового удержания' });
    }
  };

  return { list, listByMonth, add, update, remove };
};
