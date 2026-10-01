/**
 * Режим выгрузки сотрудника в «Единый файл для 1С» (миграция 249).
 *
 * Три режима:
 *   current_activity — одна строка, «Адрес объекта» = «Текущая деятельность»;
 *   object           — одна строка, адрес = закреплённый объект (независимо от проходов);
 *   skud             — разбивка по фактическим СКУД-проходам (несколько строк на человека).
 *
 * Приоритет источников:
 *   1) employees.timesheet_export_mode — объект табелирования (миграция 288: ночной
 *      расчёт, «Офис» из окна «Режим табелирования») → employee_explicit
 *   2) legacy-фолбэк по объектам ОТДЕЛА        → legacy_department | legacy_default
 * Режим отдела удалён вместе с ручной настройкой «Режим табелирования» (миграция 290).
 *
 * Персональные назначения объектов (employee_object_assignment) в резолвинге НЕ участвуют
 * (миграция 253). Это управление доступом табельщиц — «кого она дополнительно видит», —
 * и до 253 они по историческим причинам подменяли собой режим: галочка, поставленная ради
 * доступа, молча меняла человеку строки в файле 1С. Тем, кто резолвился через эту ветку,
 * миграция записала их тогдашний режим явно, поэтому удаление ветки выгрузку не изменило.
 * Возвращать её нельзя: личный режим задаёт объект табелирования.
 */
import * as Sentry from '@sentry/node';
import { query, type DbExecutor } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';

/** SELECT через клиент транзакции, если он передан, иначе через пул (см. DbExecutor). */
async function runQuery<T extends import('pg').QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params?: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[] | undefined)).rows;
  return query<T>(sql, params);
}

export type TimesheetExportMode = 'current_activity' | 'object' | 'skud';

export type TimesheetExportModeSource =
  | 'employee_explicit'
  | 'legacy_department'
  | 'legacy_default';

export interface IResolvedExportMode {
  mode: TimesheetExportMode;
  /** Закреплённый объект — только для mode = 'object', иначе null. */
  pinnedObjectId: string | null;
  source: TimesheetExportModeSource;
}

export const TIMESHEET_EXPORT_MODES: readonly TimesheetExportMode[] = [
  'current_activity',
  'object',
  'skud',
] as const;

export const isTimesheetExportMode = (value: unknown): value is TimesheetExportMode =>
  typeof value === 'string' && (TIMESHEET_EXPORT_MODES as readonly string[]).includes(value);

/** Адрес объектов режима «текущая деятельность» — он же признак legacy-режима. */
export const CURRENT_ACTIVITY_ADDRESS = 'Текущая деятельность';

/**
 * Ключ advisory-локи для записи личного режима. Один и тот же берут ночной расчёт объекта
 * табелирования (и скрипт активации) и окно «Режим табелирования» — иначе они не увидят
 * друг друга (advisory lock защищает только от процессов, берущих тот же ключ).
 */
export const TIMESHEET_MODE_LOCK_KEY = 249_0001;

interface IModeRow {
  employee_id: number | string;
  emp_mode: TimesheetExportMode | null;
  emp_object_id: string | null;
  dept_current_activity: boolean | null;
}

/** Строка запроса с учётом фиксации месяца (миграция 288). */
interface IFrozenModeRow extends IModeRow {
  freeze_month: string | null;
  baseline_month: string | null;
  state_frozen_month: string | null;
}

/**
 * Месяц данных, за который резолвится режим (миграция 288).
 *
 * Для прошедшего месяца личный режим берётся из фиксации employee_timesheet_object_months,
 * а не живой: ночной расчёт и выбор сотрудника меняют текущий месяц, и без фиксации
 * табель сентября, закрытый в октябре, ушёл бы в 1С с октябрьским объектом. Legacy-назначения
 * объектов отделам остаются живыми (граница задачи).
 */
export interface IExportModeMonthOptions {
  /** Любой день месяца или YYYY-MM. Не задан — живой режим, как раньше. */
  month?: string | null;
  /** «Сейчас» — для тестов. */
  now?: Date;
}

/** '2026-09-17' | '2026-09' → '2026-09-01'; мусор → null. */
export function toMonthStart(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}-01`;
}

/** Первое число текущего месяца по МСК. */
export function currentMonthStartMsk(now: Date = new Date()): string {
  return `${moscowTodayIso(now).slice(0, 8)}01`;
}

/** Первое число следующего месяца. */
export function nextMonthStart(monthStart: string): string {
  const date = new Date(`${monthStart.slice(0, 8)}01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

/** Час по МСК (0–23). */
export function moscowHour(now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false,
  }).format(now)) % 24;
}

/** Штатное окно до фиксации: 1-е число до 06:00 МСК, месяц — только что закончившийся. */
export const FREEZE_GRACE_UNTIL_MSK_HOUR = 6;

function isFreezeGraceWindow(monthStart: string, now: Date): boolean {
  return nextMonthStart(monthStart) === currentMonthStartMsk(now)
    && moscowTodayIso(now).endsWith('-01')
    && moscowHour(now) < FREEZE_GRACE_UNTIL_MSK_HOUR;
}

/**
 * CTE st + fm: месяц фиксации для месяца данных monthParam.
 *   - текущий и будущий месяц, нет состояния → NULL (живой режим);
 *   - месяц ≤ базовой фиксации → базовая фиксация;
 *   - иначе — ровно этот месяц.
 * Параметры — плейсхолдеры запроса ($N), в который вставляется фрагмент.
 */
export function freezeMonthCte(monthParam: string, currentMonthParam: string): string {
  return `st AS (
       SELECT baseline_month, frozen_month FROM timesheet_object_auto_state WHERE singleton
     ),
     fm AS (
       SELECT CASE
                WHEN ${monthParam}::date IS NULL OR ${monthParam}::date >= ${currentMonthParam}::date THEN NULL
                WHEN st.baseline_month IS NULL THEN NULL
                WHEN ${monthParam}::date <= st.baseline_month THEN st.baseline_month
                ELSE ${monthParam}::date
              END AS month,
              st.baseline_month,
              st.frozen_month
         FROM (SELECT 1) AS one
         LEFT JOIN st ON true
     )`;
}

/**
 * Личный режим с учётом фиксации: CASE по факту существования строки, а не COALESCE.
 * Зафиксированный NULL значит «личного режима не было» — месяц берёт legacy-режим по
 * объектам отдела, даже если позже у сотрудника появился личный объект.
 */
export const FROZEN_PERSONAL_MODE_SQL =
  'CASE WHEN f.employee_id IS NOT NULL THEN f.mode ELSE e.timesheet_export_mode END';
export const FROZEN_PERSONAL_OBJECT_SQL =
  'CASE WHEN f.employee_id IS NOT NULL THEN f.object_id ELSE e.timesheet_export_object_id END';

/**
 * Параметры месяца для запроса. null — месяц не задан или некорректен: живой режим.
 */
function monthQueryParams(options?: IExportModeMonthOptions): {
  monthStart: string;
  currentMonthStart: string;
  now: Date;
} | null {
  const monthStart = toMonthStart(options?.month ?? null);
  if (!monthStart) return null;
  const now = options?.now ?? new Date();
  return { monthStart, currentMonthStart: currentMonthStartMsk(now), now };
}

/**
 * Прошедший месяц после базовой фиксации ещё не зафиксирован — аварийный best effort:
 * режим берётся живой. Штатно такого нет (ночной расчёт фиксирует месяц в ночь на 1-е,
 * а до фиксации авторасчёт заблокирован), но правка админа в этом окне
 * попала бы в прошедший месяц — сигналим один раз на запрос.
 */
function reportMissingFreeze(rows: readonly IFrozenModeRow[], monthStart: string, now: Date): void {
  const sample = rows[0];
  if (!sample?.freeze_month || !sample.baseline_month) return;
  const freezeMonth = sample.freeze_month.slice(0, 10);
  if (freezeMonth === sample.baseline_month.slice(0, 10)) return;
  const frozenUntil = sample.state_frozen_month?.slice(0, 10) ?? null;
  if (frozenUntil && frozenUntil >= freezeMonth) return;
  if (isFreezeGraceWindow(monthStart, now)) return;
  Sentry.captureMessage('timesheet_object_month_not_frozen', {
    level: 'warning',
    tags: { source: 'timesheet-export-mode' },
    extra: { month: freezeMonth, frozen_month: frozenUntil },
  });
}

/**
 * Режимы для списка сотрудников. Один запрос: личный режим сотрудника плюс
 * legacy-признак по объектам его отдела.
 *
 * exec — клиент транзакции. Обязателен при сборке официальной версии табеля: режим
 * влияет на объектную разбивку, и читать его из другого снимка БД, чем часы, нельзя.
 *
 * options.month — месяц данных: для прошедшего месяца личный режим из фиксации (288).
 */
export async function resolveExportModes(
  employeeIds: number[],
  exec?: DbExecutor,
  options?: IExportModeMonthOptions,
): Promise<Map<number, IResolvedExportMode>> {
  const result = new Map<number, IResolvedExportMode>();
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return result;

  const monthParams = monthQueryParams(options);
  if (monthParams) {
    const rows = await runQuery<IFrozenModeRow>(
      exec,
      `WITH ca AS (
         SELECT id FROM skud_objects
          WHERE lower(btrim(coalesce(alt_name, ''))) = lower($2::text)
       ),
       dept_ca AS (
         SELECT DISTINCT doa.org_department_id
           FROM department_object_assignment doa
          WHERE doa.is_active = true AND doa.skud_object_id IN (SELECT id FROM ca)
       ),
       ${freezeMonthCte('$3', '$4')}
       SELECT e.id                                      AS employee_id,
              ${FROZEN_PERSONAL_MODE_SQL}               AS emp_mode,
              (${FROZEN_PERSONAL_OBJECT_SQL})::text     AS emp_object_id,
              (dc.org_department_id IS NOT NULL)        AS dept_current_activity,
              fm.month::text                            AS freeze_month,
              fm.baseline_month::text                   AS baseline_month,
              fm.frozen_month::text                     AS state_frozen_month
         FROM employees e
        CROSS JOIN fm
         LEFT JOIN employee_timesheet_object_months f
                ON f.employee_id = e.id AND f.month = fm.month
         LEFT JOIN dept_ca dc ON dc.org_department_id = e.org_department_id
        WHERE e.id = ANY($1::int[])`,
      [ids, CURRENT_ACTIVITY_ADDRESS, monthParams.monthStart, monthParams.currentMonthStart],
    );
    reportMissingFreeze(rows, monthParams.monthStart, monthParams.now);
    for (const row of rows) {
      const id = Number(row.employee_id);
      if (!Number.isInteger(id)) continue;
      result.set(id, resolveRow(row));
    }
    return result;
  }

  const rows = await runQuery<IModeRow>(
    exec,
    `WITH ca AS (
       SELECT id FROM skud_objects
        WHERE lower(btrim(coalesce(alt_name, ''))) = lower($2::text)
     ),
     dept_ca AS (
       SELECT DISTINCT doa.org_department_id
         FROM department_object_assignment doa
        WHERE doa.is_active = true AND doa.skud_object_id IN (SELECT id FROM ca)
     )
     SELECT e.id                                AS employee_id,
            e.timesheet_export_mode             AS emp_mode,
            e.timesheet_export_object_id::text  AS emp_object_id,
            (dc.org_department_id IS NOT NULL)  AS dept_current_activity
       FROM employees e
       LEFT JOIN dept_ca dc ON dc.org_department_id = e.org_department_id
      WHERE e.id = ANY($1::int[])`,
    [ids, CURRENT_ACTIVITY_ADDRESS],
  );

  for (const row of rows) {
    const id = Number(row.employee_id);
    if (!Number.isInteger(id)) continue;
    result.set(id, resolveRow(row));
  }
  return result;
}

/** Ключ пары «сотрудник + отдел» для resolveExportModesForPairs. */
export const exportModePairKey = (employeeId: number, departmentId: string | null): string =>
  `${Number(employeeId)}|${departmentId ?? ''}`;

/**
 * Режимы по парам «сотрудник + отдел»: legacy-признак берётся по объектам отдела ПАРЫ, а не
 * текущего employees.org_department_id. Нужен единому файлу 1С при переводе внутри
 * периода: дни в старом отделе выгружаются по его объектам. Личный режим сотрудника
 * по-прежнему приоритетнее. Ключ результата — exportModePairKey.
 */
export async function resolveExportModesForPairs(
  pairs: Array<{ employee_id: number; org_department_id: string | null }>,
  exec?: DbExecutor,
  options?: IExportModeMonthOptions,
): Promise<Map<string, IResolvedExportMode>> {
  const result = new Map<string, IResolvedExportMode>();
  const unique = new Map<string, { employeeId: number; departmentId: string | null }>();
  for (const pair of pairs) {
    const employeeId = Number(pair.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) continue;
    unique.set(exportModePairKey(employeeId, pair.org_department_id), {
      employeeId,
      departmentId: pair.org_department_id ?? null,
    });
  }
  if (unique.size === 0) return result;

  const list = [...unique.values()];

  const monthParams = monthQueryParams(options);
  if (monthParams) {
    const rows = await runQuery<IFrozenModeRow & { pair_dept_id: string | null }>(
      exec,
      `WITH ca AS (
         SELECT id FROM skud_objects
          WHERE lower(btrim(coalesce(alt_name, ''))) = lower($3::text)
       ),
       dept_ca AS (
         SELECT DISTINCT doa.org_department_id
           FROM department_object_assignment doa
          WHERE doa.is_active = true AND doa.skud_object_id IN (SELECT id FROM ca)
       ),
       pairs AS (
         SELECT p.employee_id, p.dept_id
           FROM unnest($1::int[], $2::uuid[]) AS p(employee_id, dept_id)
       ),
       ${freezeMonthCte('$4', '$5')}
       SELECT e.id                                      AS employee_id,
              p.dept_id::text                           AS pair_dept_id,
              ${FROZEN_PERSONAL_MODE_SQL}               AS emp_mode,
              (${FROZEN_PERSONAL_OBJECT_SQL})::text     AS emp_object_id,
              (dc.org_department_id IS NOT NULL)        AS dept_current_activity,
              fm.month::text                            AS freeze_month,
              fm.baseline_month::text                   AS baseline_month,
              fm.frozen_month::text                     AS state_frozen_month
         FROM pairs p
         JOIN employees e            ON e.id = p.employee_id
        CROSS JOIN fm
         LEFT JOIN employee_timesheet_object_months f
                ON f.employee_id = e.id AND f.month = fm.month
         LEFT JOIN dept_ca dc        ON dc.org_department_id = p.dept_id`,
      [
        list.map(p => p.employeeId),
        list.map(p => p.departmentId),
        CURRENT_ACTIVITY_ADDRESS,
        monthParams.monthStart,
        monthParams.currentMonthStart,
      ],
    );
    reportMissingFreeze(rows, monthParams.monthStart, monthParams.now);
    for (const row of rows) {
      const id = Number(row.employee_id);
      if (!Number.isInteger(id)) continue;
      result.set(exportModePairKey(id, row.pair_dept_id ?? null), resolveRow(row));
    }
    return result;
  }
  const rows = await runQuery<IModeRow & { pair_dept_id: string | null }>(
    exec,
    `WITH ca AS (
       SELECT id FROM skud_objects
        WHERE lower(btrim(coalesce(alt_name, ''))) = lower($3::text)
     ),
     dept_ca AS (
       SELECT DISTINCT doa.org_department_id
         FROM department_object_assignment doa
        WHERE doa.is_active = true AND doa.skud_object_id IN (SELECT id FROM ca)
     ),
     pairs AS (
       SELECT p.employee_id, p.dept_id
         FROM unnest($1::int[], $2::uuid[]) AS p(employee_id, dept_id)
     )
     SELECT e.id                                AS employee_id,
            p.dept_id::text                     AS pair_dept_id,
            e.timesheet_export_mode             AS emp_mode,
            e.timesheet_export_object_id::text  AS emp_object_id,
            (dc.org_department_id IS NOT NULL)  AS dept_current_activity
       FROM pairs p
       JOIN employees e            ON e.id = p.employee_id
       LEFT JOIN dept_ca dc        ON dc.org_department_id = p.dept_id`,
    [list.map(p => p.employeeId), list.map(p => p.departmentId), CURRENT_ACTIVITY_ADDRESS],
  );

  for (const row of rows) {
    const id = Number(row.employee_id);
    if (!Number.isInteger(id)) continue;
    result.set(exportModePairKey(id, row.pair_dept_id ?? null), resolveRow(row));
  }
  return result;
}

/** Резолвинг одной строки — вынесен ради тестов. */
export function resolveRow(row: IModeRow): IResolvedExportMode {
  if (row.emp_mode) {
    return {
      mode: row.emp_mode,
      pinnedObjectId: row.emp_mode === 'object' ? row.emp_object_id : null,
      source: 'employee_explicit',
    };
  }
  // Legacy: только объекты отдела. Персональные назначения сюда намеренно не входят —
  // см. шапку файла и миграцию 253.
  if (row.dept_current_activity) {
    return { mode: 'current_activity', pinnedObjectId: null, source: 'legacy_department' };
  }
  return { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' };
}

/** Режим по умолчанию для сотрудника, которого нет в карте (страховка). */
export const DEFAULT_EXPORT_MODE: IResolvedExportMode = {
  mode: 'skud',
  pinnedObjectId: null,
  source: 'legacy_default',
};
