/**
 * Справочник видов удержаний деревом «вид → подвиды» и правка подвидов (миграция 321) — одни обработчики для
 * кадров (/api/staff-deductions, право /staff-control/deductions) и «Зарплаты» (/api/payroll, справочники):
 * справочник общий, гарды — у каждого роутера свои.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  addSubkind,
  deleteSubkind,
  listDeductionKindTree,
  updateSubkind,
  type IDeductionSubkind,
} from '../services/payroll/payroll-deduction-subkinds.service.js';
import { handlePayrollZodError, parsePayrollDictionaryId } from './payroll-dictionary.helpers.js';
import { deductionDictionaryEntrySchema } from './staff-deduction-input.js';

const subkindSchema = deductionDictionaryEntrySchema('Введите название подвида');

const KIND_NOT_FOUND = { success: false, error: 'Вид удержания не найден' };
const SUBKIND_NOT_FOUND = { success: false, error: 'Подвид удержания не найден' };
const DUPLICATE_SUBKIND = { success: false, error: 'Такой подвид у этого вида уже есть', code: 'DUPLICATE_SUBKIND' };

const subkindAudit = (subkind: IDeductionSubkind) => ({
  kind_id: subkind.kind_id,
  name: subkind.name,
  default_amount: subkind.default_amount,
});

/** GET …/kinds — виды с суммой по умолчанию и подвидами, в порядке справочника. */
const listKindTree = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listDeductionKindTree() });
  } catch (err) {
    console.error('deductionSubkinds.listKindTree error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения видов удержаний' });
  }
};

/** POST …/kinds/:id/subkinds { name, default_amount? } — добавить подвид; вида нет — 404, такой есть — 409. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const kindId = parsePayrollDictionaryId(req);
    if (kindId === null) {
      res.status(404).json(KIND_NOT_FOUND);
      return;
    }
    const { name, default_amount: defaultAmount } = subkindSchema.parse(req.body);
    const subkind = await addSubkind(kindId, name, defaultAmount);
    if (subkind === 'kind_missing') {
      res.status(404).json(KIND_NOT_FOUND);
      return;
    }
    if (subkind === 'duplicate') {
      res.status(409).json(DUPLICATE_SUBKIND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_SUBKIND_ADDED', {
      entityType: 'payroll_deduction_subkinds',
      entityId: String(subkind.id),
      details: subkindAudit(subkind),
    });
    res.json({ success: true, data: subkind });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('deductionSubkinds.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления подвида удержания' });
  }
};

/** PATCH …/subkinds/:id { name, default_amount? } — название и сумма по умолчанию. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    if (id === null) {
      res.status(404).json(SUBKIND_NOT_FOUND);
      return;
    }
    const { name, default_amount: defaultAmount } = subkindSchema.parse(req.body);
    const updated = await updateSubkind(id, name, defaultAmount);
    if (updated === null) {
      res.status(404).json(SUBKIND_NOT_FOUND);
      return;
    }
    if (updated === 'duplicate') {
      res.status(409).json(DUPLICATE_SUBKIND);
      return;
    }
    const { before, after } = updated;
    if (before.name !== after.name || before.default_amount !== after.default_amount) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_SUBKIND_UPDATED', {
        entityType: 'payroll_deduction_subkinds',
        entityId: String(id),
        details: { from: subkindAudit(before), to: subkindAudit(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('deductionSubkinds.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения подвида удержания' });
  }
};

/** DELETE …/subkinds/:id — удалить подвид; назначен сотрудникам — 409 с их числом. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const deleted = id === null ? null : await deleteSubkind(id);
    if (id === null || deleted === null) {
      res.status(404).json(SUBKIND_NOT_FOUND);
      return;
    }
    if ('inUse' in deleted) {
      res.status(409).json({
        success: false,
        error: `Подвид назначен сотрудникам: ${deleted.inUse}`,
        code: 'SUBKIND_IN_USE',
        employees: deleted.inUse,
      });
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_SUBKIND_DELETED', {
      entityType: 'payroll_deduction_subkinds',
      entityId: String(id),
      details: subkindAudit(deleted),
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('deductionSubkinds.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления подвида удержания' });
  }
};

export const deductionSubkindsController = { listKindTree, add, update, remove };
