// Публичные методы обмена закрытыми табелями с 1С (/api/public/v1/timesheets*).
//
// Живут отдельным файлом от public-data-api.controller.ts: там «живой» расчёт
// произвольного периода, здесь — работа с материализованными версиями.
//
// Ключевое: НИЧЕГО не пересчитывается. Список и выгрузка читают timesheet_versions,
// подтверждение пишет timesheet_1c_exports. Закрытый табель заморожен до следующего
// открытия/закрытия.

import type { Request, Response } from 'express';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { dataApiKeyService } from '../services/data-api-key.service.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { resolveState, type TimesheetExportState } from '../services/timesheet-version.service.js';
import type { DataApiKeyContext } from '../middleware/dataApiAuth.js';

const MONTH_RE = /^\d{4}-\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Та же глубина, что у backfill-скрипта: 1С не должна запрашивать глубже, чем забэкфиллено. */
export const MAX_EXPORT_DEPTH_MONTHS = 3;

interface IVersionJoinRow {
  approval_id: number;
  department_id: string | null;
  department_name: string | null;
  manager_employee_id: number | null;
  start_date: string;
  end_date: string;
  version_id: number | null;
  revision: number | null;
  content_hash: string | null;
  employees_count: number | null;
  total_hours: string | number | null;
  version_created_at: string | null;
  acked_version_id: number | null;
  acked_revision: number | null;
  acked_at: string | null;
  document_ref: string | null;
}

function keyOf(req: Request): DataApiKeyContext | undefined {
  return (req as Request & { dataApiKey?: DataApiKeyContext }).dataApiKey;
}

function fail(res: Response, status: number, error: string, code?: string, extra?: Record<string, unknown>): void {
  const body: Record<string, unknown> = { success: false, error };
  if (code) body.code = code;
  if (extra) Object.assign(body, extra);
  res.status(status).json(body);
}

/** Гейт: ключу должна быть открыта таблица employees (табель — данные сотрудников). */
async function ensureEmployeesAccess(req: Request, res: Response): Promise<DataApiKeyContext | null> {
  const keyCtx = keyOf(req);
  if (!keyCtx) {
    fail(res, 401, 'Unauthorized');
    return null;
  }
  let keyTables: Array<{ table_name: string }>;
  try {
    keyTables = await dataApiKeyService.getKeyTables(keyCtx.id);
  } catch {
    fail(res, 500, 'Failed to resolve key access');
    return null;
  }
  if (!keyTables.some(t => t.table_name === 'employees')) {
    fail(res, 403, 'Ключу не открыта таблица employees — табель недоступен');
    return null;
  }
  return keyCtx;
}

/** Нижняя граница периода: глубже 1С не ходит, иначе упрётся в неотбэкфилленные подачи. */
function depthFloor(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MAX_EXPORT_DEPTH_MONTHS, 1))
    .toISOString().slice(0, 10);
}

function lastDayOfMonth(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

/** Разбор периода: month ЛИБО from/to, но не оба сразу. */
function parsePeriod(req: Request): { from: string; to: string } | { error: string } {
  const month = typeof req.query.month === 'string' ? req.query.month : '';
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';

  if (month && (from || to)) {
    return { error: 'Параметры month и from/to взаимоисключающие — передайте что-то одно' };
  }
  if (month) {
    if (!MONTH_RE.test(month)) return { error: 'month должен быть в формате YYYY-MM' };
    return { from: `${month}-01`, to: lastDayOfMonth(month) };
  }
  if (from || to) {
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
      return { error: 'from и to должны быть в формате YYYY-MM-DD и передаваться вместе' };
    }
    if (to < from) return { error: 'to не может быть раньше from' };
    return { from, to };
  }
  // Ничего не передали — отдаём всю разрешённую глубину.
  return { from: depthFloor(), to: '9999-12-31' };
}

/** Keyset-курсор: (start_date, approval_id). Base64 — чтобы не выглядел «редактируемым». */
function encodeCursor(startDate: string, approvalId: number): string {
  return Buffer.from(`${startDate}|${approvalId}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { startDate: string; approvalId: number } | null {
  try {
    const [startDate, idRaw] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (!startDate || !ISO_DATE_RE.test(startDate) || !idRaw || !/^\d+$/.test(idRaw)) return null;
    return { startDate, approvalId: Number(idRaw) };
  } catch {
    return null;
  }
}

function toListItem(row: IVersionJoinRow): Record<string, unknown> {
  const hasVersion = row.version_id != null;
  const state: TimesheetExportState = resolveState(row.version_id, row.acked_version_id);
  return {
    approval_id: Number(row.approval_id),
    scope: {
      kind: row.manager_employee_id != null ? 'personal' : 'department',
      department_id: row.department_id,
      department_name: row.department_name,
      manager_employee_id: row.manager_employee_id != null ? Number(row.manager_employee_id) : null,
    },
    start_date: row.start_date,
    end_date: row.end_date,
    version_available: hasVersion,
    revision: hasVersion ? Number(row.revision) : null,
    content_hash: hasVersion ? row.content_hash : null,
    employees_count: hasVersion ? Number(row.employees_count) : null,
    total_hours: hasVersion ? Number(row.total_hours) : null,
    version_created_at: hasVersion ? row.version_created_at : null,
    state,
    last_export: row.acked_version_id != null
      ? {
        revision: Number(row.acked_revision),
        acked_at: row.acked_at,
        document_ref: row.document_ref,
      }
      : null,
  };
}

export const publicTimesheetsController = {
  /**
   * GET /api/public/v1/timesheets
   *
   * Список закрытых согласованных табелей. Табель не собирается — всё из версий,
   * поэтому метод рассчитан на регулярный опрос (раз в минуту).
   */
  async list(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!(await ensureEmployeesAccess(req, res))) return;

    const period = parsePeriod(req);
    if ('error' in period) {
      fail(res, 400, period.error);
      return;
    }
    const floor = depthFloor();
    if (period.from < floor) {
      fail(res, 400, `Запрос глубже ${MAX_EXPORT_DEPTH_MONTHS} месяцев не поддерживается (с ${floor})`);
      return;
    }

    const deptRaw = typeof req.query.department_id === 'string' ? req.query.department_id : '';
    const deptIds = [...new Set(deptRaw.split(',').map(s => s.trim()).filter(Boolean))];
    if (deptIds.some(id => !UUID_RE.test(id))) {
      fail(res, 400, 'department_id должен быть UUID');
      return;
    }

    const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : '';
    const limit = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      fail(res, 400, `limit должен быть целым числом от 1 до ${MAX_LIMIT}`);
      return;
    }

    let cursor: { startDate: string; approvalId: number } | null = null;
    if (typeof req.query.cursor === 'string' && req.query.cursor) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor) {
        fail(res, 400, 'Некорректный cursor — начните обход заново без него');
        return;
      }
    }

    const needsExportRaw = typeof req.query.needs_export === 'string' ? req.query.needs_export : '';
    const needsExport = needsExportRaw === 'true' ? true : needsExportRaw === 'false' ? false : null;

    const params: unknown[] = [period.from, period.to];
    const where: string[] = [
      "a.status = 'approved'",
      'a.unlocked_at IS NULL',
      'a.start_date >= $1::date',
      'a.start_date <= $2::date',
    ];
    if (deptIds.length > 0) {
      params.push(deptIds);
      where.push(`a.department_id = ANY($${params.length}::uuid[])`);
    }
    if (cursor) {
      // Keyset: строго «дальше» по (start_date DESC, approval_id DESC).
      params.push(cursor.startDate, cursor.approvalId);
      where.push(`(a.start_date, a.id) < ($${params.length - 1}::date, $${params.length}::bigint)`);
    }

    // Последняя версия подачи и подтверждение именно этой версии.
    const baseSql = `
      SELECT a.id AS approval_id,
             a.department_id,
             d.name AS department_name,
             a.manager_employee_id,
             a.start_date::text AS start_date,
             a.end_date::text   AS end_date,
             v.id               AS version_id,
             v.revision,
             v.content_hash,
             v.employees_count,
             v.total_hours,
             v.created_at::text AS version_created_at,
             ack.version_id     AS acked_version_id,
             ackv.revision      AS acked_revision,
             ack.acked_at::text AS acked_at,
             ack.document_ref
        FROM timesheet_approvals a
        LEFT JOIN org_departments d ON d.id = a.department_id
        LEFT JOIN LATERAL (
          SELECT id, revision, content_hash, employees_count, total_hours, created_at
            FROM timesheet_versions tv
           WHERE tv.approval_id = a.id
           ORDER BY tv.revision DESC
           LIMIT 1
        ) v ON true
        LEFT JOIN LATERAL (
          SELECT e.version_id, e.acked_at, e.document_ref
            FROM timesheet_1c_exports e
            JOIN timesheet_versions ev ON ev.id = e.version_id
           WHERE ev.approval_id = a.id
           ORDER BY ev.revision DESC
           LIMIT 1
        ) ack ON true
        LEFT JOIN timesheet_versions ackv ON ackv.id = ack.version_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.start_date DESC, a.id DESC`;

    try {
      // Фильтр состояния применяем в SQL, иначе страница «схлопнется» после ACK.
      let sql = baseSql;
      if (needsExport === true) {
        sql = `SELECT * FROM (${baseSql}) t WHERE t.version_id IS NULL OR t.acked_version_id IS DISTINCT FROM t.version_id`;
      } else if (needsExport === false) {
        sql = `SELECT * FROM (${baseSql}) t WHERE t.version_id IS NOT NULL AND t.acked_version_id = t.version_id`;
      }
      params.push(limit + 1);
      sql += ` LIMIT $${params.length}`;

      const rows = await query<IVersionJoinRow>(sql, params);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];

      res.json({
        period: { from: period.from, to: period.to === '9999-12-31' ? null : period.to },
        data: page.map(toListItem),
        meta: { without_version: page.filter(row => row.version_id == null).length },
        next_cursor: hasMore && last ? encodeCursor(last.start_date, Number(last.approval_id)) : null,
      });
    } catch (err) {
      console.error('publicTimesheets.list error:', err);
      res.locals.dataApiError = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) fail(res, 500, 'Failed to list timesheets');
    }
  },

  /**
   * GET /api/public/v1/timesheets/:approval_id
   *
   * Табель из сохранённой версии — весь согласованный состав целиком, без фильтров.
   */
  async detail(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!(await ensureEmployeesAccess(req, res))) return;

    const approvalId = Number(req.params.approval_id);
    if (!Number.isSafeInteger(approvalId) || approvalId <= 0) {
      fail(res, 400, 'approval_id должен быть положительным целым числом');
      return;
    }

    const revisionRaw = typeof req.query.revision === 'string' ? req.query.revision : '';
    let revision: number | null = null;
    if (revisionRaw) {
      revision = Number(revisionRaw);
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        fail(res, 400, 'revision должен быть положительным целым числом');
        return;
      }
    }

    try {
      const approval = await queryOne<{
        id: number; status: string; unlocked_at: string | null;
      }>('SELECT id, status, unlocked_at FROM timesheet_approvals WHERE id = $1', [approvalId]);
      if (!approval) {
        fail(res, 404, 'Табель не найден');
        return;
      }
      if (approval.unlocked_at) {
        fail(res, 409, 'Табель открыт для правок — выгрузка недоступна', 'TIMESHEET_UNLOCKED');
        return;
      }
      if (approval.status !== 'approved') {
        fail(res, 409, 'Табель не утверждён', 'TIMESHEET_NOT_APPROVED');
        return;
      }

      const version = await queryOne<{
        id: number; revision: number; content_hash: string; payload: unknown;
        employees_count: number; total_hours: string | number; created_at: string;
      }>(
        revision != null
          ? `SELECT id, revision, content_hash, payload, employees_count, total_hours, created_at::text AS created_at
               FROM timesheet_versions WHERE approval_id = $1 AND revision = $2`
          : `SELECT id, revision, content_hash, payload, employees_count, total_hours, created_at::text AS created_at
               FROM timesheet_versions WHERE approval_id = $1 ORDER BY revision DESC LIMIT 1`,
        revision != null ? [approvalId, revision] : [approvalId],
      );
      if (!version) {
        fail(res, 409, 'Версия табеля ещё не сформирована', 'VERSION_NOT_AVAILABLE');
        return;
      }

      // state считается по ПОСЛЕДНЕЙ версии, даже если запрошена старая.
      const latest = await queryOne<{ id: number }>(
        'SELECT id FROM timesheet_versions WHERE approval_id = $1 ORDER BY revision DESC LIMIT 1',
        [approvalId],
      );
      const acked = await queryOne<{ version_id: number }>(
        `SELECT e.version_id
           FROM timesheet_1c_exports e
           JOIN timesheet_versions v ON v.id = e.version_id
          WHERE v.approval_id = $1
          ORDER BY v.revision DESC
          LIMIT 1`,
        [approvalId],
      );

      const payload = version.payload as Record<string, unknown>;
      res.json({
        ...payload,
        revision: Number(version.revision),
        content_hash: version.content_hash,
        version_created_at: version.created_at,
        employees_count: Number(version.employees_count),
        total_hours: Number(version.total_hours),
        state: resolveState(latest?.id ?? null, acked?.version_id ?? null),
      });
    } catch (err) {
      console.error('publicTimesheets.detail error:', err);
      res.locals.dataApiError = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) fail(res, 500, 'Failed to fetch timesheet version');
    }
  },

  /**
   * POST /api/public/v1/timesheets/:approval_id/ack
   *
   * Подтверждение приёма версии. Идемпотентно: повторный ACK той же редакции
   * возвращает исходный acked_at. Единственный пишущий метод публичного API.
   */
  async ack(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const keyCtx = await ensureEmployeesAccess(req, res);
    if (!keyCtx) return;

    if (!keyCtx.allow_timesheet_ack) {
      fail(res, 403, 'Ключу не разрешено подтверждать выгрузку табелей');
      return;
    }

    const approvalId = Number(req.params.approval_id);
    if (!Number.isSafeInteger(approvalId) || approvalId <= 0) {
      fail(res, 400, 'approval_id должен быть положительным целым числом');
      return;
    }

    const body = (req.body ?? {}) as { revision?: unknown; document_ref?: unknown; note?: unknown };
    const revision = Number(body.revision);
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      fail(res, 400, 'Поле revision обязательно и должно быть положительным целым числом');
      return;
    }
    const documentRef = typeof body.document_ref === 'string' ? body.document_ref.trim().slice(0, 128) : null;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;

    try {
      const result = await withTransaction(async client => {
        // Блокируем подачу: открытие периода не должно вклиниться между проверкой и записью.
        const approval = (await client.query<{ id: number; status: string; unlocked_at: string | null }>(
          'SELECT id, status, unlocked_at FROM timesheet_approvals WHERE id = $1 FOR UPDATE',
          [approvalId],
        )).rows[0];
        if (!approval) return { kind: 'not_found' as const };
        if (approval.unlocked_at) return { kind: 'unlocked' as const };
        if (approval.status !== 'approved') return { kind: 'not_approved' as const };

        const latest = (await client.query<{ id: number; revision: number; content_hash: string }>(
          `SELECT id, revision, content_hash FROM timesheet_versions
            WHERE approval_id = $1 ORDER BY revision DESC LIMIT 1`,
          [approvalId],
        )).rows[0];
        if (!latest) return { kind: 'no_version' as const };
        if (Number(latest.revision) !== revision) {
          return {
            kind: 'mismatch' as const,
            currentRevision: Number(latest.revision),
            currentHash: latest.content_hash,
          };
        }

        // Идемпотентность: конкурентные ACK одной версии дают одну строку.
        await client.query(
          `INSERT INTO timesheet_1c_exports (version_id, key_id, document_ref, note)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (version_id) DO NOTHING`,
          [latest.id, keyCtx.id, documentRef, note],
        );
        const stored = (await client.query<{ acked_at: string; document_ref: string | null }>(
          'SELECT acked_at::text AS acked_at, document_ref FROM timesheet_1c_exports WHERE version_id = $1',
          [latest.id],
        )).rows[0];

        return {
          kind: 'ok' as const,
          versionId: latest.id,
          revision: Number(latest.revision),
          contentHash: latest.content_hash,
          ackedAt: stored?.acked_at ?? null,
          documentRef: stored?.document_ref ?? null,
        };
      });

      switch (result.kind) {
        case 'not_found':
          fail(res, 404, 'Табель не найден');
          return;
        case 'unlocked':
          fail(res, 409, 'Табель открыт для правок — подтверждение недоступно', 'TIMESHEET_UNLOCKED');
          return;
        case 'not_approved':
          fail(res, 409, 'Табель не утверждён', 'TIMESHEET_NOT_APPROVED');
          return;
        case 'no_version':
          fail(res, 409, 'Версия табеля ещё не сформирована', 'VERSION_NOT_AVAILABLE');
          return;
        case 'mismatch':
          fail(res, 409, 'Подтверждается устаревшая редакция табеля', 'REVISION_MISMATCH', {
            current_revision: result.currentRevision,
            current_content_hash: result.currentHash,
          });
          return;
        default:
          break;
      }

      // Статус в интерфейсе HR должен обновиться сразу, а не через TTL кэша.
      invalidateCaches('timesheet-1c-status');

      res.json({
        success: true,
        approval_id: approvalId,
        revision: result.revision,
        content_hash: result.contentHash,
        state: 'exported' satisfies TimesheetExportState,
        acked_at: result.ackedAt,
        document_ref: result.documentRef,
      });
    } catch (err) {
      console.error('publicTimesheets.ack error:', err);
      res.locals.dataApiError = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) fail(res, 500, 'Failed to acknowledge timesheet version');
    }
  },
};
