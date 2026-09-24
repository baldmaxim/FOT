/**
 * Отпуск в карточке «Зарплата → Условия оплаты»: сколько отгулено и история периодов.
 *
 * Источник — дни табеля (attendance_adjustments): и заявления, и ручные отметки руководителя.
 * Статус дня выбирается ТАК ЖЕ, как в табеле (attendance.service): из day-level строк побеждает
 * строка с большим ADJUSTMENT_PRIORITY, при равенстве — свежий updated_at. Иначе «Отгулено»
 * разошлось бы с табелем: ручная «работа» поверх согласованного отпуска — это не отпуск.
 *
 * Остаток отпуска не считаем: входящих остатков нет, а hire_date у большинства — дата
 * заведения записи. Остаток из 1С — отдельной задачей.
 */
import { query, queryOne } from '../../config/postgres.js';
import { ADJUSTMENT_PRIORITY } from '../time-calculation/primitives.js';
import { OBJECT_ADJUSTMENT_SOURCE_TYPE } from '../timesheet-object.service.js';

/**
 * Нерабочие праздничные дни (ст. 112 ТК) как ММ-ДД. По ст. 120 ТК они в число календарных
 * дней ежегодного отпуска не включаются. Производственный календарь не подходит: в нём
 * лежат и перенесённые выходные, а они в отпуск входят.
 */
export const NON_WORKING_HOLIDAYS_MMDD = [
  '01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08',
  '02-23', '03-08', '05-01', '05-09', '06-12', '11-04',
];

/** Статусы дня, которые относятся к отпускам. */
const VACATION_STATUSES = ['vacation', 'unpaid', 'educational_leave'] as const;
export type VacationStatus = typeof VACATION_STATUSES[number];

/** Сводка на сегодня. Ежегодный отпуск — без праздников (ст. 120), без сохранения — календарно. */
export interface IVacationSummary {
  year: number;
  today: string;
  /** Отгулено ежегодного отпуска с 1 января по сегодня. */
  used_days: number;
  /** Согласованные дни ежегодного отпуска после сегодня. */
  planned_days: number;
  /** Дней без сохранения зарплаты с 1 января по сегодня. */
  unpaid_days: number;
}

export interface IVacationPeriod {
  start_date: string;
  end_date: string;
  status: VacationStatus;
  calendar_days: number;
  /** Из них нерабочих праздничных (ст. 112). */
  holiday_days: number;
  /** leave_request — по заявлению, timesheet — ручная отметка в табеле. */
  source: 'leave_request' | 'timesheet';
  leave_request_id: number | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
}

/** Периодов в истории не больше — карточка, а не отчёт. */
const HISTORY_LIMIT = 200;

/** CASE приоритета строится из ADJUSTMENT_PRIORITY, чтобы не разойтись с табелем. */
const PRIORITY_SQL = `CASE ${Object.entries(ADJUSTMENT_PRIORITY)
  .map(([source, weight]) => `WHEN a.source_type = '${source}' THEN ${weight}`)
  .join(' ')} ELSE 0 END`;

/**
 * CTE vacation_days: победивший статус каждого дня сотрудника ($1), только отпускные статусы.
 * Настоящие объектные правки (manual_object) статус дня не задают; мигрированные из day-level —
 * задают (как isMigratedDayLevelAdjustment). Несогласованные и отклонённые победители не считаются.
 */
const VACATION_DAYS_CTE = `
  day_rows AS (
    SELECT DISTINCT ON (a.work_date)
           a.work_date, a.status, a.source_type, a.source_id, a.approval_status
      FROM attendance_adjustments a
     WHERE a.employee_id = $1
       AND (a.source_type <> '${OBJECT_ADJUSTMENT_SOURCE_TYPE}'
            OR a.metadata ->> 'migrated_from_day_level' = 'true')
     ORDER BY a.work_date, ${PRIORITY_SQL} DESC, a.updated_at DESC
  ),
  vacation_days AS (
    SELECT work_date, status, source_type, source_id,
           to_char(work_date, 'MM-DD') = ANY($2::text[]) AS is_holiday
      FROM day_rows
     WHERE approval_status NOT IN ('pending', 'rejected')
       AND status IN (${VACATION_STATUSES.map(status => `'${status}'`).join(', ')})
  )`;

/** Сводка по отпуску на дату today (YYYY-MM-DD, Москва). */
export const getVacationSummary = async (
  employeeId: number,
  today: string,
): Promise<IVacationSummary> => {
  const row = await queryOne<{ used_days: number; planned_days: number; unpaid_days: number }>(
    `WITH ${VACATION_DAYS_CTE}
     SELECT
       count(*) FILTER (WHERE status = 'vacation' AND NOT is_holiday
                          AND work_date BETWEEN date_trunc('year', $3::date)::date AND $3::date)::int AS used_days,
       count(*) FILTER (WHERE status = 'vacation' AND NOT is_holiday
                          AND work_date > $3::date)::int AS planned_days,
       count(*) FILTER (WHERE status = 'unpaid'
                          AND work_date BETWEEN date_trunc('year', $3::date)::date AND $3::date)::int AS unpaid_days
       FROM vacation_days`,
    [employeeId, NON_WORKING_HOLIDAYS_MMDD, today],
  );
  return {
    year: Number(today.slice(0, 4)),
    today,
    used_days: Number(row?.used_days ?? 0),
    planned_days: Number(row?.planned_days ?? 0),
    unpaid_days: Number(row?.unpaid_days ?? 0),
  };
};

/**
 * Периоды отпусков, новые сверху. Дни по заявлению группируются по заявлению (согласовавший —
 * leave_requests.reviewer_id), ручные отметки — в непрерывные по датам отрезки одного статуса.
 */
export const getVacationHistory = async (employeeId: number): Promise<IVacationPeriod[]> =>
  query<IVacationPeriod>(
    `WITH ${VACATION_DAYS_CTE},
     grouped AS (
       SELECT d.*,
              CASE
                WHEN d.source_type = 'leave_request' THEN 'lr:' || d.source_id
                ELSE 'tab:' || d.status || ':' || (d.work_date - (ROW_NUMBER() OVER (
                       PARTITION BY d.source_type = 'leave_request', d.status
                       ORDER BY d.work_date))::int)::text
              END AS grp_key
         FROM vacation_days d
     )
     SELECT min(g.work_date) AS start_date,
            max(g.work_date) AS end_date,
            g.status,
            count(*)::int AS calendar_days,
            count(*) FILTER (WHERE g.is_holiday)::int AS holiday_days,
            CASE WHEN bool_or(g.source_type = 'leave_request') THEN 'leave_request' ELSE 'timesheet' END AS source,
            lr.id AS leave_request_id,
            up.full_name AS reviewer_name,
            lr.reviewed_at
       FROM grouped g
       LEFT JOIN leave_requests lr
              ON g.source_type = 'leave_request' AND lr.id::text = g.source_id
       LEFT JOIN user_profiles up ON up.id = lr.reviewer_id
      GROUP BY g.grp_key, g.status, lr.id, up.full_name, lr.reviewed_at
      ORDER BY min(g.work_date) DESC
      LIMIT ${HISTORY_LIMIT}`,
    [employeeId, NON_WORKING_HOLIDAYS_MMDD],
  );
