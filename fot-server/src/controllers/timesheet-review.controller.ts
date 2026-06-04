import type { Response } from 'express';
import { query, queryOne, execute } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveAccessibleDepartmentIds, resolveScopedDepartmentId } from '../services/data-scope.service.js';
import { isIsoDate } from '../services/timesheet-range.service.js';

/**
 * Отметка табельщицы «Проверено» по табелю бригады за период.
 * Хранится в timesheet_timekeeper_review (department_id, start_date, end_date).
 * Ставит/снимает только табельщица (role_code='timekeeper') или админ;
 * читать статус может любая роль со страницей табеля.
 */

interface IReviewStatus {
  checked: boolean;
  checked_by: string | null;
  checked_by_name: string | null;
  checked_at: string | null;
}

const NOT_CHECKED: IReviewStatus = {
  checked: false,
  checked_by: null,
  checked_by_name: null,
  checked_at: null,
};

const canMarkReview = (req: AuthenticatedRequest): boolean =>
  req.user.role_code === 'timekeeper' || req.user.is_admin === true;

const parseRange = (src: Record<string, unknown>): { start: string; end: string } | null => {
  const start = src.start_date ?? src.from;
  const end = src.end_date ?? src.to;
  if (!isIsoDate(start) || !isIsoDate(end)) return null;
  if ((end as string) < (start as string)) return null;
  return { start: start as string, end: end as string };
};

const loadStatus = async (departmentId: string, start: string, end: string): Promise<IReviewStatus> => {
  const row = await queryOne<{ checked_by: string | null; checked_by_name: string | null; checked_at: string }>(
    `SELECT r.checked_by, up.full_name AS checked_by_name, r.checked_at
       FROM timesheet_timekeeper_review r
       LEFT JOIN user_profiles up ON up.id = r.checked_by
      WHERE r.department_id = $1 AND r.start_date = $2 AND r.end_date = $3
      LIMIT 1`,
    [departmentId, start, end],
  );
  if (!row) return NOT_CHECKED;
  return {
    checked: true,
    checked_by: row.checked_by,
    checked_by_name: row.checked_by_name,
    checked_at: row.checked_at,
  };
};

const getReviewStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const range = parseRange(req.query as Record<string, unknown>);
    if (!range) {
      res.json({ success: true, data: NOT_CHECKED });
      return;
    }
    const requested = typeof req.query.department_id === 'string' ? req.query.department_id : null;
    const departmentId = await resolveScopedDepartmentId(req, requested);
    if (requested && !departmentId) {
      res.status(403).json({ success: false, error: 'Access denied to this department', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
    if (!departmentId) {
      res.json({ success: true, data: NOT_CHECKED });
      return;
    }
    res.json({ success: true, data: await loadStatus(departmentId, range.start, range.end) });
  } catch (err) {
    console.error('timesheet-review.getReviewStatus error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения статуса проверки' });
  }
};

const setReviewStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!canMarkReview(req)) {
      res.status(403).json({ success: false, error: 'Отметку «Проверено» ставит только табельщица' });
      return;
    }
    const range = parseRange(req.body as Record<string, unknown>);
    if (!range) {
      res.status(400).json({ success: false, error: 'start_date и end_date обязательны (формат YYYY-MM-DD, end_date >= start_date)' });
      return;
    }
    const requested = typeof req.body.department_id === 'string' ? req.body.department_id : null;
    const departmentId = await resolveScopedDepartmentId(req, requested);
    if (!departmentId) {
      res.status(403).json({ success: false, error: 'Нет доступа к этой бригаде', code: 'DEPARTMENT_ACCESS_DENIED' });
      return;
    }
    const checked = req.body.checked === true;
    if (checked) {
      await execute(
        `INSERT INTO timesheet_timekeeper_review (department_id, start_date, end_date, checked_by, checked_at)
           VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (department_id, start_date, end_date)
           DO UPDATE SET checked_by = EXCLUDED.checked_by, checked_at = now()`,
        [departmentId, range.start, range.end, req.user.id],
      );
    } else {
      await execute(
        `DELETE FROM timesheet_timekeeper_review
          WHERE department_id = $1 AND start_date = $2 AND end_date = $3`,
        [departmentId, range.start, range.end],
      );
    }
    res.json({ success: true, data: await loadStatus(departmentId, range.start, range.end) });
  } catch (err) {
    console.error('timesheet-review.setReviewStatus error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения отметки проверки' });
  }
};

/**
 * Список отделов/бригад, отмеченных «Проверено» за период (для дерева Табели HR).
 * Скоуп — доступные пользователю отделы (админ/HR со scope='all' видят все).
 */
const listReviewedDepartments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const range = parseRange(req.query as Record<string, unknown>);
    if (!range) {
      res.json({ success: true, data: [] });
      return;
    }
    const accessible = await resolveAccessibleDepartmentIds(req);
    if (Array.isArray(accessible) && accessible.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    const params: unknown[] = [range.start, range.end];
    let scopeClause = '';
    if (Array.isArray(accessible)) {
      params.push(accessible);
      scopeClause = ` AND r.department_id = ANY($${params.length}::uuid[])`;
    }
    const rows = await query<{ department_id: string; checked_by_name: string | null; checked_at: string }>(
      `SELECT r.department_id, up.full_name AS checked_by_name, r.checked_at
         FROM timesheet_timekeeper_review r
         LEFT JOIN user_profiles up ON up.id = r.checked_by
        WHERE r.start_date = $1 AND r.end_date = $2${scopeClause}`,
      params,
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('timesheet-review.listReviewedDepartments error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка проверенных бригад' });
  }
};

export const timesheetReviewController = {
  getReviewStatus,
  setReviewStatus,
  listReviewedDepartments,
};
