/**
 * «Корректировки» (миграция 365): вкладка «Управления кадрами», право /staff-control/corrections — только просмотр.
 * Что попадает в журнал — staff-corrections.service.ts. Право журнала не даёт права править: окно дня пишет через
 * API табеля с его write-scope и замками.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { listBranchCandidateIds } from '../services/staff-branch-ownership.service.js';
import { computeStaffCorrectionSkud, listStaffCorrections } from '../services/staff-corrections.service.js';
import { handlePayrollZodError } from './payroll-dictionary.helpers.js';
import { filterBranchesByScope } from './staff-weekends.controller.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

const CORRECTIONS_SHEET = { sheetName: 'Корректировки', tableName: 'Corrections' } as const;
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const skudQuerySchema = z.object({ month: monthSchema, branch_id: z.string().uuid() });

/** Кандидаты месяца (владелец дня) и видимые пользователю — та же семантика охвата, что у «Выходных». */
const resolveCorrectionBranches = async (
  req: AuthenticatedRequest,
  month: string,
): Promise<{ ownership: string[]; visible: string[] }> => {
  const ownership = await listBranchCandidateIds(month);
  return { ownership, visible: await filterBranchesByScope(req, ownership) };
};

/** GET /api/staff-corrections?month=2026-11 — отделы с правками и все видимые правки месяца (без часов СКУД). */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const month = monthSchema.safeParse(req.query.month);
    if (!month.success) {
      res.status(400).json({ success: false, error: 'Выберите месяц' });
      return;
    }
    const { ownership, visible } = await resolveCorrectionBranches(req, month.data);
    res.json({
      success: true,
      data: await listStaffCorrections(month.data, { ownershipBranchIds: ownership, visibleBranchIds: visible }),
    });
  } catch (err) {
    console.error('staffCorrections.list error:', err);
    res.status(500).json({ success: false, error: 'Не удалось загрузить корректировки' });
  }
};

/** GET /api/staff-corrections/skud?month&branch_id — часы по СКУД без правки для правок отдела. */
const skud = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = skudQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Неверный запрос' });
      return;
    }
    const { month, branch_id: branchId } = parsed.data;
    const { ownership, visible } = await resolveCorrectionBranches(req, month);
    if (!visible.includes(branchId)) {
      res.status(403).json({ success: false, error: 'Отдел вне вашего охвата' });
      return;
    }
    const { rows } = await listStaffCorrections(month, { ownershipBranchIds: ownership, visibleBranchIds: [branchId] });
    res.json({
      success: true,
      data: await computeStaffCorrectionSkud(month, rows, req.user.show_actual_hours === true),
    });
  } catch (err) {
    console.error('staffCorrections.skud error:', err);
    res.status(500).json({ success: false, error: 'Не удалось посчитать часы по СКУД' });
  }
};

/** POST /api/staff-corrections/export — снимок таблицы экрана в xlsx. */
const exportTable = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await sendTableSnapshotXlsx(res, req.body, CORRECTIONS_SHEET);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('staffCorrections.export error:', err);
    res.status(500).json({ success: false, error: 'Не удалось выгрузить таблицу' });
  }
};

export const staffCorrectionsController = { list, skud, exportTable };
