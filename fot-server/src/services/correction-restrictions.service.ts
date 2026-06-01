import { query, queryOne } from '../config/postgres.js';

/**
 * Гард-сервис «Ограничения корректировок табеля» (см. миграцию 132).
 *
 * Правила хранятся в блоке полей system_roles и проверяются по флагам, а не
 * по коду роли — любая роль может получить произвольный набор ограничений
 * без правки кода (см. план в planning файле). Дефолты выключены, поэтому
 * для существующих ролей ничего не меняется.
 *
 * Используется из timesheet.controller перед записью в attendance_adjustments.
 */

export type CorrectionRestrictionCode =
  | 'not_anomalous'
  | 'hours_exceed_norm'
  | 'monthly_limit'
  | 'zero_not_allowed'
  | 'short_attendance_not_eligible'
  | 'bulk_disabled';

export class CorrectionRestrictionError extends Error {
  public readonly code: CorrectionRestrictionCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: CorrectionRestrictionCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CorrectionRestrictionError';
    this.code = code;
    this.details = details;
  }
}

export interface IRoleCorrectionRestrictions {
  corrections_anomalies_only: boolean;
  corrections_cap_by_schedule_norm: boolean;
  corrections_allow_zero_short_attendance: boolean;
  corrections_disable_bulk: boolean;
  max_corrections_per_month: number | null;
  weekend_memo_required: boolean;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: IRoleCorrectionRestrictions; at: number }>();

/** Загружает блок ограничений для роли с кэшем 60 c. */
export async function loadRoleRestrictions(systemRoleId: string): Promise<IRoleCorrectionRestrictions> {
  const cached = cache.get(systemRoleId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const row = await queryOne<IRoleCorrectionRestrictions>(
    `SELECT corrections_anomalies_only,
            corrections_cap_by_schedule_norm,
            corrections_allow_zero_short_attendance,
            corrections_disable_bulk,
            max_corrections_per_month,
            weekend_memo_required
       FROM system_roles
      WHERE id = $1::uuid`,
    [systemRoleId],
  );

  const value: IRoleCorrectionRestrictions = row ?? {
    corrections_anomalies_only: false,
    corrections_cap_by_schedule_norm: false,
    corrections_allow_zero_short_attendance: false,
    corrections_disable_bulk: false,
    max_corrections_per_month: null,
    weekend_memo_required: false,
  };

  cache.set(systemRoleId, { value, at: Date.now() });
  return value;
}

export function invalidateCorrectionRestrictionsCache(systemRoleId?: string): void {
  if (systemRoleId) cache.delete(systemRoleId);
  else cache.clear();
}

async function isSkudAnomalousDay(employeeId: number, workDate: string, scheduled: boolean): Promise<boolean> {
  const row = await queryOne<{ anomalous: boolean }>(
    `SELECT public.is_skud_anomalous_day($1::bigint, $2::date, $3::boolean) AS anomalous`,
    [employeeId, workDate, scheduled],
  );
  return Boolean(row?.anomalous);
}

/** Подсчёт уже поданных корректировок-аномалий (hours > 0) за календарный месяц workDate для (createdBy, employeeId). */
async function countEmployeeAnomalyCorrections(
  createdBy: string,
  employeeId: number,
  workDate: string,
  excludeAdjustmentId: number | null,
): Promise<number> {
  const row = await queryOne<{ cnt: number | string | null }>(
    `SELECT COUNT(*)::int AS cnt
       FROM attendance_adjustments
      WHERE created_by = $1::uuid
        AND employee_id = $2::bigint
        AND work_date >= date_trunc('month', $3::date)::date
        AND work_date <  (date_trunc('month', $3::date) + INTERVAL '1 month')::date
        AND approval_status IN ('pending','approved','auto_approved')
        AND hours_override > 0
        AND ($4::bigint IS NULL OR id <> $4::bigint)`,
    [createdBy, employeeId, workDate, excludeAdjustmentId],
  );
  const v = row?.cnt;
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export interface IAssertCorrectionAllowedInput {
  systemRoleId: string;
  createdBy: string;
  employeeId: number;
  workDate: string;
  /** Округлённое значение часов, которое будет записано в hours_override. */
  hoursOverride: number;
  /** Норма часов дня по графику (0 → нерабочий по графику). */
  scheduledNormHours: number;
  /** При update — id строки, которую правим (исключаем из подсчёта лимита). */
  excludeAdjustmentId?: number | null;
}

/**
 * Главная проверка перед записью корректировки. На несоответствие любому из
 * включённых правил роли бросает CorrectionRestrictionError.
 *
 * Контракт: если все флаги выключены — no-op (быстрый возврат).
 */
export async function assertCorrectionAllowed(input: IAssertCorrectionAllowedInput): Promise<void> {
  const restrictions = await loadRoleRestrictions(input.systemRoleId);
  if (
    !restrictions.corrections_anomalies_only
    && !restrictions.corrections_cap_by_schedule_norm
  ) {
    return;
  }

  const hours = Number.isFinite(input.hoursOverride) ? input.hoursOverride : 0;
  const scheduledNorm = Number.isFinite(input.scheduledNormHours) ? input.scheduledNormHours : 0;
  const isScheduled = scheduledNorm > 0;

  if (hours > 0) {
    if (restrictions.corrections_anomalies_only) {
      const anomalous = await isSkudAnomalousDay(input.employeeId, input.workDate, isScheduled);
      if (!anomalous) {
        throw new CorrectionRestrictionError(
          'not_anomalous',
          'Корректировка часов разрешена только в дни-аномалии СКУД (пропуск пары, ошибка СКУД, пропуск скана).',
        );
      }
    }

    if (restrictions.corrections_cap_by_schedule_norm && hours > scheduledNorm) {
      throw new CorrectionRestrictionError(
        'hours_exceed_norm',
        `Часы корректировки (${hours}) превышают плановые часы дня (${scheduledNorm}).`,
        { scheduledNormHours: scheduledNorm },
      );
    }

    if (
      restrictions.corrections_anomalies_only
      && restrictions.max_corrections_per_month != null
    ) {
      const used = await countEmployeeAnomalyCorrections(
        input.createdBy,
        input.employeeId,
        input.workDate,
        input.excludeAdjustmentId ?? null,
      );
      if (used >= restrictions.max_corrections_per_month) {
        throw new CorrectionRestrictionError(
          'monthly_limit',
          `Достигнут лимит корректировок аномалий по сотруднику в этом месяце (${restrictions.max_corrections_per_month}).`,
          { limit: restrictions.max_corrections_per_month, used },
        );
      }
    }
    return;
  }

  // hours === 0 — явное обнуление дня, разрешено для всех ролей
}

/** Проверка для bulk-эндпоинта. Кидает 'bulk_disabled' если у роли corrections_disable_bulk=true. */
export async function assertBulkAllowed(systemRoleId: string): Promise<void> {
  const r = await loadRoleRestrictions(systemRoleId);
  if (r.corrections_disable_bulk) {
    throw new CorrectionRestrictionError(
      'bulk_disabled',
      'Массовое редактирование табеля недоступно для вашей роли.',
    );
  }
}

/**
 * Пакетный сборщик «доступности» для UX-эндпоинта `/api/timesheet/correction-eligibility`.
 * Один SQL-запрос на сотрудника × день в диапазоне (используется unnest).
 */
export interface ICorrectionEligibilityRequest {
  systemRoleId: string;
  createdBy: string;
  employeeIds: number[];
  startDate: string;
  endDate: string;
  /** Карта (employee_id × YYYY-MM-DD) → плановые часы дня. */
  scheduledNorms: Map<number, Map<string, number>>;
}

export interface ICorrectionEligibilityForEmployee {
  anomaly_dates: string[];
  short_attendance_dates: string[];
  anomaly_used: number;
}

export interface ICorrectionEligibilityResponse {
  restrictions: IRoleCorrectionRestrictions;
  by_employee: Record<string, ICorrectionEligibilityForEmployee>;
}

export async function computeCorrectionEligibility(req: ICorrectionEligibilityRequest): Promise<ICorrectionEligibilityResponse> {
  const restrictions = await loadRoleRestrictions(req.systemRoleId);

  const result: ICorrectionEligibilityResponse = {
    restrictions,
    by_employee: {},
  };
  if (req.employeeIds.length === 0) return result;

  const needAnomalies = restrictions.corrections_anomalies_only;
  const needShortAttendance = restrictions.corrections_anomalies_only && restrictions.corrections_allow_zero_short_attendance;
  const needUsedCount = restrictions.corrections_anomalies_only && restrictions.max_corrections_per_month != null;

  // Аномалии: вызываем функцию для каждой пары (employee × day из диапазона), где день рабочий по графику
  // (внерабочие дни тоже учитываются, но без case 3 — переключаем p_scheduled по карте scheduledNorms).
  const pairs: Array<{ emp: number; date: string; scheduled: boolean }> = [];
  for (const emp of req.employeeIds) {
    const empNorms = req.scheduledNorms.get(emp);
    for (let d = new Date(req.startDate + 'T00:00:00Z'); d <= new Date(req.endDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const norm = empNorms?.get(iso) ?? 0;
      pairs.push({ emp, date: iso, scheduled: norm > 0 });
    }
  }

  const empArr = pairs.map(p => p.emp);
  const dateArr = pairs.map(p => p.date);
  const schedArr = pairs.map(p => p.scheduled);

  const initEntry = (emp: number) => {
    const key = String(emp);
    if (!result.by_employee[key]) {
      result.by_employee[key] = { anomaly_dates: [], short_attendance_dates: [], anomaly_used: 0 };
    }
    return result.by_employee[key];
  };
  for (const emp of req.employeeIds) initEntry(emp);

  if (needAnomalies && pairs.length > 0) {
    const rows = await query<{ emp: string | number; d: string; anomalous: boolean }>(
      `SELECT t.emp, t.d::text AS d,
              public.is_skud_anomalous_day(t.emp::bigint, t.d::date, t.scheduled::boolean) AS anomalous
         FROM unnest($1::bigint[], $2::date[], $3::boolean[]) AS t(emp, d, scheduled)`,
      [empArr, dateArr, schedArr],
    );
    for (const r of rows) {
      if (!r.anomalous) continue;
      const empKey = String(Number(r.emp));
      const entry = result.by_employee[empKey] ?? initEntry(Number(r.emp));
      entry.anomaly_dates.push(String(r.d));
    }
  }

  if (needShortAttendance && pairs.length > 0) {
    const scheduledPairs = pairs.filter(p => p.scheduled);
    if (scheduledPairs.length > 0) {
      const rows = await query<{ emp: string | number; d: string; total_minutes: number | string | null }>(
        `SELECT t.emp, t.d::text AS d,
                COALESCE(s.total_minutes, 0) AS total_minutes
           FROM unnest($1::bigint[], $2::date[]) AS t(emp, d)
           LEFT JOIN skud_daily_summary s
             ON s.employee_id = t.emp AND s.date = t.d`,
        [scheduledPairs.map(p => p.emp), scheduledPairs.map(p => p.date)],
      );
      for (const r of rows) {
        const minutes = Number(r.total_minutes ?? 0);
        if (!Number.isFinite(minutes) || minutes >= 240) continue;
        const empKey = String(Number(r.emp));
        const entry = result.by_employee[empKey] ?? initEntry(Number(r.emp));
        entry.short_attendance_dates.push(String(r.d));
      }
    }
  }

  if (needUsedCount && req.employeeIds.length > 0) {
    // Подсчёт за календарные месяцы, пересекающие диапазон. На UI обычно один месяц,
    // но эндпоинт может вызываться шире — берём все месяцы и складываем по employee.
    // Реально per-month счётчик показывает столько корректировок аномалий, сколько
    // уже подал createdBy за месяц диапазона `startDate`.
    const rows = await query<{ employee_id: string | number; cnt: number | string | null }>(
      `SELECT employee_id, COUNT(*)::int AS cnt
         FROM attendance_adjustments
        WHERE created_by = $1::uuid
          AND employee_id = ANY($2::bigint[])
          AND work_date >= date_trunc('month', $3::date)::date
          AND work_date <  (date_trunc('month', $3::date) + INTERVAL '1 month')::date
          AND approval_status IN ('pending','approved','auto_approved')
          AND hours_override > 0
        GROUP BY employee_id`,
      [req.createdBy, req.employeeIds, req.startDate],
    );
    for (const r of rows) {
      const empKey = String(Number(r.employee_id));
      const entry = result.by_employee[empKey] ?? initEntry(Number(r.employee_id));
      entry.anomaly_used = Number(r.cnt ?? 0);
    }
  }

  return result;
}
