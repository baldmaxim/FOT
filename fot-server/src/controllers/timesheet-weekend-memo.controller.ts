import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveScopedDepartmentId } from '../services/data-scope.service.js';
import { loadRoleRestrictions } from '../services/correction-restrictions.service.js';
import {
  generateWeekendMemoXlsx,
  getWeekendWorkEntries,
  loadWeekendMemoData,
} from '../services/timesheet-weekend-memo.service.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface IResolvedScope {
  departmentId: string;
  startDate: string;
  endDate: string;
}

async function resolveCommonScope(
  req: AuthenticatedRequest,
  res: Response,
  source: 'body' | 'query',
): Promise<IResolvedScope | null> {
  const { weekend_memo_required } = await loadRoleRestrictions(req.user.system_role_id);
  if (!weekend_memo_required) {
    res.status(403).json({ success: false, error: 'Служебка о работе в выходные недоступна для вашей роли' });
    return null;
  }

  const raw = source === 'body' ? req.body ?? {} : req.query ?? {};
  const requestedDeptId = typeof raw.department_id === 'string' && raw.department_id ? raw.department_id : null;
  const startDate = typeof raw.start_date === 'string' ? raw.start_date : '';
  const endDate = typeof raw.end_date === 'string' ? raw.end_date : '';

  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate) || endDate < startDate) {
    res.status(400).json({
      success: false,
      error: 'start_date и end_date обязательны (формат YYYY-MM-DD, end_date >= start_date)',
    });
    return null;
  }

  const departmentId = await resolveScopedDepartmentId(req, requestedDeptId);
  if (requestedDeptId && !departmentId) {
    res.status(403).json({ success: false, error: 'Нет доступа к отделу', code: 'DEPARTMENT_ACCESS_DENIED' });
    return null;
  }
  if (!departmentId) {
    res.status(400).json({ success: false, error: 'department_id обязателен' });
    return null;
  }

  return { departmentId, startDate, endDate };
}

/**
 * GET /api/timesheet/weekend-memo/preview
 * Query: ?department_id=...&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * Возвращает превью того, кто попадёт в шаблон служебной записки и за какие даты.
 * Список — read-only: «выбор» сотрудников происходит через корректировки в табеле.
 */
export const getWeekendMemoPreview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scope = await resolveCommonScope(req, res, 'query');
    if (!scope) return;

    const { entries, weekend_dates } = await getWeekendWorkEntries(scope);
    res.json({ success: true, entries, weekend_dates });
  } catch (err) {
    console.error('timesheet-weekend-memo.preview error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки превью служебной записки' });
  }
};

/**
 * POST /api/timesheet/weekend-memo/generate
 * Body: { department_id, start_date, end_date, reason }
 * Генерирует .xlsx-шаблон служебной записки. Список сотрудников и дат
 * собирается автоматически: те, у кого в attendance_adjustments статус 'work'
 * на календарный выходной в указанном диапазоне.
 */
export const generateWeekendMemo = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scope = await resolveCommonScope(req, res, 'body');
    if (!scope) return;

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    const { entries, weekend_dates } = await getWeekendWorkEntries(scope);

    if (weekend_dates.length === 0) {
      res.status(400).json({
        success: false,
        error: 'В выбранном диапазоне нет выходных/праздничных дней',
        code: 'NO_WEEKEND_DAYS',
      });
      return;
    }

    if (entries.length === 0) {
      res.status(404).json({
        success: false,
        error: 'Не найдено сотрудников с работой в выходные. Сначала создайте корректировку статуса «работа» на выходной день.',
        code: 'NO_WEEKEND_WORK',
      });
      return;
    }

    const data = await loadWeekendMemoData({
      managerUserId: req.user.id,
      employeeIds: entries.map(e => e.employee_id),
      weekendDates: weekend_dates,
      reason,
    });

    const buffer = await generateWeekendMemoXlsx(data);
    const fileName = `weekend-memo-${scope.startDate}_${scope.endDate}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.end(buffer);
  } catch (err) {
    console.error('timesheet-weekend-memo.generate error:', err);
    res.status(500).json({ success: false, error: 'Ошибка формирования служебной записки' });
  }
};
