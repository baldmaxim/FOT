// API для ЗУП3 «сотрудники месяца» (/api/public/v1/staff-month*): объект и часы (факт, норма графика), категория
// (рабочий / ИТР / офис), объект табелирования, дни с объектами, бригады и объекты — за месяц или половину месяца
// (half=1 — 1–15, half=2 — 16–конец). Статусы выгрузки и подтверждение 1С — только по половинам. Доступ — как у обмена
// табелями: ключу открыта таблица employees. Расчёт и снимки — services/staff-month-1c.*.

import type { Request, Response } from 'express';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  getStaffMonthSnapshot,
  halfNotStarted,
  listStaffMonthEmployees,
  RETRY_AFTER_SECONDS,
  STAFF_MONTH_FIRST,
  StaffMonthApiError,
} from '../services/staff-month-1c.service.js';
import {
  staffMonthHalfBounds,
  type IStaffMonthFilters,
  type StaffMonthCategory,
  type StaffMonthHalf,
} from '../services/staff-month-1c.rules.js';
import { monthBoundsOf } from '../services/staff-month-1c.load.js';
import type { IStaffMonthHalfView } from '../services/staff-month-1c.half.js';
import { ackStaffMonth } from '../services/staff-month-1c.export-state.js';
import { STAFF_MONTH_EXPORT_STATES, type StaffMonthExportState } from '../services/staff-month-1c.export-state.rules.js';
import { z } from 'zod';
import type { IStaffMonthSnapshot } from '../services/staff-month-1c.snapshot.js';
import { ensureEmployeesAccess, fail, keyOf } from './public-data-api.helpers.js';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_KEY_RE = /^(office|unknown|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CATEGORIES: ReadonlySet<string> = new Set(['worker', 'itr', 'office']);
const DEFAULT_LIMIT = 100;

const ackSchema = z.object({
  month: z.string(),
  half: z.union([z.literal(1), z.literal(2)], { errorMap: () => ({ message: 'half обязателен: 1 (1–15) или 2 (16–конец)' }) }),
  document_ref: z.string().trim().min(1).max(200).nullable().optional(),
  employees: z.array(z.object({
    employee_id: z.number().int().positive(),
    state_revision: z.number().int().positive(),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })).min(1).max(500),
});
const MAX_LIMIT = 500;

const apiError = (res: Response, error: StaffMonthApiError): void => {
  if (error.code === 'snapshot_building' || error.code === 'calculation_failed') {
    res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
  }
  fail(res, error.status, error.message, error.code, { retryable: error.retryable });
};

const badRequest = (code: string, message: string): StaffMonthApiError => new StaffMonthApiError(400, code, message, false);

const stringParam = (req: Request, name: string): string | null => {
  const value = req.query[name];
  if (value === undefined) return null;
  if (typeof value !== 'string') throw badRequest('invalid_filter', `${name} передан несколько раз`);
  return value;
};

/** Месяц: настоящий YYYY-MM, не раньше 2026-06, не будущий (по Москве). */
export const parseStaffMonth = (raw: string | null, now: Date = new Date()): string => {
  if (!raw || !MONTH_RE.test(raw)) throw badRequest('invalid_month', 'month обязателен в формате YYYY-MM');
  if (raw < STAFF_MONTH_FIRST) {
    throw badRequest('month_not_supported', `Данные по объектам есть с ${STAFF_MONTH_FIRST}`);
  }
  if (raw > moscowTodayIso(now).slice(0, 7)) throw badRequest('invalid_month', 'month в будущем');
  return raw;
};

const parseSnapshotId = (req: Request): string | null => {
  const raw = stringParam(req, 'snapshot_id');
  if (raw === null) return null;
  if (!UUID_RE.test(raw)) throw badRequest('invalid_filter', 'snapshot_id должен быть UUID');
  return raw.toLowerCase();
};

/** Половина: 1 — 1–15, 2 — 16–конец; не передана — месяц целиком. */
const parseHalf = (req: Request): StaffMonthHalf | null => {
  const raw = stringParam(req, 'half');
  if (raw === null) return null;
  if (raw !== '1' && raw !== '2') throw badRequest('invalid_filter', 'half — 1 (1–15) или 2 (16–конец месяца)');
  return Number(raw) as StaffMonthHalf;
};

/** Половина текущего месяца ещё не началась — 400 до сборки снимка. */
const ensureHalfStarted = (month: string, half: StaffMonthHalf | null, now: Date = new Date()): void => {
  if (half !== null && !staffMonthHalfBounds(monthBoundsOf(month, now), half).started) throw halfNotStarted(half);
};

const parseFilters = (req: Request): IStaffMonthFilters => {
  const half = parseHalf(req);
  const objectKey = stringParam(req, 'object_key');
  if (objectKey !== null && !OBJECT_KEY_RE.test(objectKey)) {
    throw badRequest('invalid_filter', 'object_key — UUID объекта, office или unknown');
  }
  const category = stringParam(req, 'category');
  if (category !== null && !CATEGORIES.has(category)) throw badRequest('invalid_filter', 'category — worker, itr или office');
  const employeeRaw = stringParam(req, 'employee_id');
  if (employeeRaw !== null && !/^[1-9]\d{0,9}$/.test(employeeRaw)) {
    throw badRequest('invalid_filter', 'employee_id — положительное целое');
  }
  const exportRaw = stringParam(req, 'export_state');
  let exportState: StaffMonthExportState[] | null = null;
  if (exportRaw !== null) {
    const parts = new Set(exportRaw.split(',').map(part => part.trim()).filter(Boolean));
    if (parts.size === 0 || [...parts].some(part => !(STAFF_MONTH_EXPORT_STATES as readonly string[]).includes(part))) {
      throw badRequest('invalid_filter', 'export_state — через запятую из not_ready, ready, exported, changed');
    }
    exportState = STAFF_MONTH_EXPORT_STATES.filter(state => parts.has(state));
    if (half === null) throw badRequest('invalid_filter', 'export_state — только с half=1 или half=2: статусы ведутся по половинам');
  }
  const daysRaw = stringParam(req, 'days');
  if (daysRaw !== null && !['0', '1', 'true', 'false'].includes(daysRaw)) throw badRequest('invalid_filter', 'days — 1 или 0');
  return {
    half,
    object_key: objectKey === null ? null : objectKey.toLowerCase(),
    category: category as StaffMonthCategory | null,
    employee_id: employeeRaw === null ? null : Number(employeeRaw),
    days: daysRaw === '1' || daysRaw === 'true',
    export_state: exportState,
  };
};

const parseLimit = (req: Request): number => {
  const raw = stringParam(req, 'limit');
  if (raw === null) return DEFAULT_LIMIT;
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest('invalid_filter', `limit должен быть целым от 1 до ${MAX_LIMIT}`);
  }
  return limit;
};

const envelope = (
  snapshot: IStaffMonthSnapshot,
  view: IStaffMonthHalfView | null,
  data: unknown[],
  extra: Record<string, unknown>,
): Record<string, unknown> => ({
  success: true,
  period: view
    ? { month: snapshot.month, half: view.bounds.half, from: view.bounds.from, to: view.bounds.to, as_of: view.bounds.until }
    : { month: snapshot.month, half: null, from: snapshot.bounds.start, to: snapshot.bounds.end, as_of: snapshot.bounds.until },
  snapshot: { id: snapshot.id, generated_at: snapshot.generatedAt, preliminary: view ? view.preliminary : snapshot.preliminary },
  data,
  ...extra,
});

/** Половина снимка для /brigades и /objects (началась — проверено до сборки). */
const viewOf = (snapshot: IStaffMonthSnapshot, half: StaffMonthHalf | null): IStaffMonthHalfView | null => {
  if (half === null) return null;
  const view = snapshot.halves[half];
  if (!view.bounds.started) throw halfNotStarted(half);
  return view;
};

const run = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await ensureEmployeesAccess(req, res))) return;
    await handler(req, res);
  } catch (err) {
    if (err instanceof StaffMonthApiError) {
      apiError(res, err);
      return;
    }
    console.error('publicStaffMonth error:', err);
    fail(res, 500, 'Ошибка сервера', 'internal_error', { retryable: true });
  }
};

export const publicStaffMonthController = {
  /** GET /api/public/v1/staff-month — сотрудники месяца. */
  employees: run(async (req, res) => {
    const month = parseStaffMonth(stringParam(req, 'month'));
    const filters = parseFilters(req);
    const limit = parseLimit(req);
    const snapshotId = parseSnapshotId(req);
    const cursor = stringParam(req, 'cursor');
    ensureHalfStarted(month, filters.half);
    const page = await listStaffMonthEmployees({ month, filters, limit, cursor, snapshotId });
    res.json(envelope(page.snapshot, page.view, page.rows, {
      meta: {
        employees_count: page.total,
        ...page.snapshot.meta,
        ...(page.view ? { export_counts: page.exportCounts, period_ready: page.periodReady } : {}),
      },
      next_cursor: page.nextCursor,
    }));
  }),

  /**
   * POST /api/public/v1/staff-month/ack — 1С подтверждает записанные строки половины (half обязателен): ревизия + хеш
   * из GET с тем же half. Проверка — по сохранённым ревизиям (работает после рестарта сервера). Нужен ключ с
   * подтверждением (allow_timesheet_ack).
   */
  ack: run(async (req, res) => {
    if (!keyOf(req)?.allow_timesheet_ack) {
      fail(res, 403, 'Ключу не разрешено подтверждение приёма (allow_timesheet_ack)', 'forbidden', { retryable: false });
      return;
    }
    const parsed = ackSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('invalid_body', parsed.error.errors.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }
    const month = parseStaffMonth(parsed.data.month);
    const seen = new Set<string>();
    for (const item of parsed.data.employees) {
      const key = `${item.employee_id}|${item.state_revision}`;
      if (seen.has(key)) throw badRequest('invalid_body', `employee_id ${item.employee_id}, state_revision ${item.state_revision} — повтор`);
      seen.add(key);
    }
    const result = await ackStaffMonth({
      month,
      half: parsed.data.half,
      documentRef: parsed.data.document_ref ?? null,
      keyId: keyOf(req)?.id ?? null,
      items: parsed.data.employees.map(item => ({
        employeeId: item.employee_id, revision: item.state_revision, contentHash: item.content_hash,
      })),
    });
    res.json({ success: true, ...result });
  }),

  /** GET /api/public/v1/staff-month/brigades — бригады месяца (или половины) и их объект. */
  brigades: run(async (req, res) => {
    const month = parseStaffMonth(stringParam(req, 'month'));
    const half = parseHalf(req);
    ensureHalfStarted(month, half);
    const snapshot = await getStaffMonthSnapshot(month, parseSnapshotId(req));
    const view = viewOf(snapshot, half);
    res.json(envelope(snapshot, view, view ? view.brigades : snapshot.brigades, {
      meta: { employees_count: view ? view.rows.length : snapshot.rows.length, ...snapshot.meta },
      next_cursor: null,
    }));
  }),

  /** GET /api/public/v1/staff-month/objects — объекты месяца (или половины): справочник и итоги. */
  objects: run(async (req, res) => {
    const month = parseStaffMonth(stringParam(req, 'month'));
    const half = parseHalf(req);
    ensureHalfStarted(month, half);
    const snapshot = await getStaffMonthSnapshot(month, parseSnapshotId(req));
    const view = viewOf(snapshot, half);
    res.json(envelope(snapshot, view, view ? view.objects : snapshot.objects, {
      meta: { employees_count: view ? view.rows.length : snapshot.rows.length, ...snapshot.meta },
      next_cursor: null,
    }));
  }),
};
