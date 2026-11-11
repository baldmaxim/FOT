/**
 * Отпуск в карточке «Зарплата → Условия оплаты»: сколько отгулено, остаток и история периодов.
 *
 * Источник — дни табеля (attendance_adjustments): и заявления, и ручные отметки руководителя.
 * Статус дня выбирается ТАК ЖЕ, как в табеле (attendance.service): из day-level строк побеждает
 * строка с большим ADJUSTMENT_PRIORITY, при равенстве — свежий updated_at. Иначе «Отгулено»
 * разошлось бы с табелем: ручная «работа» поверх согласованного отпуска — это не отпуск.
 *
 * Отпуск — в календарных днях. Руководители часто отмечают его только Пн–Пт: выходные и праздники
 * МЕЖДУ двумя днями отпуска считаются днями отпуска (перемычка), если в них нет ни отметки табеля,
 * ни прохода СКУД. Выходные после последнего дня не добавляются: входили ли они в приказ, по
 * табелю не понять. Между двумя РАЗНЫМИ заявлениями перемычки нет: это два приказа, и 1С выходные
 * между ними в отпуск не включает (Туров: заявления на Пт и на Пн–Пт).
 *
 * Остаток (getVacationBalance) — от остатка 1С на дату (payroll_vacation_balances, миграции 323, 360):
 * история до неё — из 1С, табель ФОТ за прошлые периоды неполный. Дальше:
 *  - +2,33 дн. за месяц (не 28/12: остатки 1С кратны 2,33, 12 мес. = 27,96). Прошедший месяц засчитывается
 *    целиком, в том числе месяц приёма (у 1С на конец месяца принятому 18.05 за май — 2,33). Текущий месяц —
 *    по прошедшим дням: доля 2,33 от дней месяца счёта, к последнему дню — 2,33. Месяц даты остатка 1С уже
 *    начислила — счёт со следующего;
 *  - месяц увольнения — только от 15 дней (Правила об очередных и дополнительных отпусках, п. 35), без доли;
 *  - принятый после последней выгрузки 1С — с нуля с даты приёма;
 *  - «без сохранения» сверх 14 дней за год от начала отсчёта не входит в стаж (ст. 121 ТК) и
 *    сдвигает конец начисления — и дневную долю, и порог увольнения;
 *  - отпуск вычитается целиком в день начала (заявление — одним периодом, все его дни без праздников ст. 112).
 *    1С вычитает отпуск целиком по дате приказа, поэтому в её остатке уже есть отпуска, начатые до даты остатка,
 *    и часть будущих (приказ оформлен заранее). Их ФОТ не вычитает: граница vacations_through (NULL — дата
 *    остатка) и точечный список заявлений снимка payroll_vacation_balance_counted_leaves. Новый приказ после
 *    снимка 1С вычтет с даты приказа, ФОТ — с первого дня отпуска: до начала 1С ниже на длину отпуска.
 * Приближения: ст. 121 — от даты остатка, а не по рабочему году (дней без содержания до выгрузки ФОТ не знает);
 * новые — от hire_date ФОТ, у части людей она не совпадает с 1С. Остаток справочный: компенсацию при увольнении
 * ФОТ не считает, следующая выгрузка 1С его заменяет.
 * Принятый раньше выгрузки, но без строки 1С, остатка не получает: его не с чего считать.
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

/**
 * Остаток ежегодного отпуска на сегодня (или на день увольнения). Дни — строкой до сотых,
 * как NUMERIC: считаются в целых сотых, без float.
 */
export interface IVacationBalance {
  /** 1c — от остатка 1С на as_of; hire — с нуля от даты приёма (принят после выгрузки 1С). */
  source: '1c' | 'hire';
  /** Дата остатка 1С (счёт — со следующего дня) или дата приёма (счёт — с неё). */
  as_of: string;
  opening_days: string;
  /** Последний день счёта: сегодня или день увольнения, если он раньше. */
  until: string;
  accrued_months: number;
  accrued_days: string;
  /** Отгулено ежегодного отпуска после as_of по until, без праздников ст. 112. */
  used_days: number;
  /** «Без сохранения» сверх 14 дней за год — не в стаже (ст. 121 ТК). */
  unpaid_excess_days: number;
  current_days: string;
}

/** Периодов в истории не больше — карточка, а не отчёт. */
const HISTORY_LIMIT = 200;

/** CASE приоритета строится из ADJUSTMENT_PRIORITY, чтобы не разойтись с табелем. */
const PRIORITY_SQL = `CASE ${Object.entries(ADJUSTMENT_PRIORITY)
  .map(([source, weight]) => `WHEN a.source_type = '${source}' THEN ${weight}`)
  .join(' ')} ELSE 0 END`;

/**
 * Самая длинная перемычка, дней между двумя днями отпуска: новогодние каникулы с выходными — 11–12.
 * Длиннее непрерывных нерабочих дней не бывает; предел только отсекает заведомо рабочие разрывы.
 */
const MAX_BRIDGE_GAP_DAYS = 14;

/** День $d — выходной (Сб/Вс) или нерабочий день производственного календаря. */
const NON_WORKING_DAY_SQL = (d: string): string => `(
  extract(isodow FROM ${d}) IN (6, 7)
  OR EXISTS (
    SELECT 1 FROM production_calendar pc
     WHERE pc.year = extract(year FROM ${d})::int AND pc.month = extract(month FROM ${d})::int
       AND (${d} = ANY(pc.holidays) OR ${d} = ANY(pc.mandatory_holidays))))`;

/**
 * CTE vacation_days: победивший статус каждого дня сотрудника ($1), только отпускные статусы.
 * Настоящие объектные правки (manual_object) статус дня не задают; мигрированные из day-level —
 * задают (как isMigratedDayLevelAdjustment). Несогласованные и отклонённые победители не считаются.
 *
 * Плюс перемычки: разрыв между двумя соседними днями одного статуса, где КАЖДЫЙ день — нерабочий,
 * без отметки табеля (любой, даже отклонённой) и без присутствия по СКУД, и по краям не два разных
 * заявления. День перемычки берёт источник предыдущего дня — в истории Пн–Пт + Пн–Пт ручных отметок
 * становятся одним периодом.
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
  marked_days AS (
    SELECT work_date, status, source_type, source_id
      FROM day_rows
     WHERE approval_status NOT IN ('pending', 'rejected')
       AND status IN (${VACATION_STATUSES.map(status => `'${status}'`).join(', ')})
  ),
  gaps AS (
    SELECT status, source_type, source_id, work_date AS prev_date, next_date
      FROM (SELECT m.*,
                   lead(m.work_date) OVER w AS next_date,
                   lead(m.source_type) OVER w AS next_source_type,
                   lead(m.source_id) OVER w AS next_source_id
              FROM marked_days m
            WINDOW w AS (PARTITION BY m.status ORDER BY m.work_date)) s
     WHERE next_date - work_date BETWEEN 2 AND ${MAX_BRIDGE_GAP_DAYS + 1}
       AND NOT (source_type = 'leave_request' AND next_source_type = 'leave_request'
                AND source_id IS DISTINCT FROM next_source_id)
  ),
  bridged_days AS (
    SELECT gd.d::date AS work_date, g.status, g.source_type, g.source_id
      FROM gaps g
      CROSS JOIN LATERAL generate_series(g.prev_date + 1, g.next_date - 1, interval '1 day') AS gd(d)
     WHERE NOT EXISTS (
       SELECT 1
         FROM generate_series(g.prev_date + 1, g.next_date - 1, interval '1 day') AS x(d)
        WHERE NOT ${NON_WORKING_DAY_SQL('x.d::date')}
           OR EXISTS (SELECT 1 FROM day_rows r WHERE r.work_date = x.d::date)
           OR EXISTS (SELECT 1 FROM skud_daily_summary sk
                       WHERE sk.employee_id = $1 AND sk.date = x.d::date
                         AND (sk.is_present OR sk.total_minutes > 0)))
  ),
  vacation_days AS (
    SELECT work_date, status, source_type, source_id,
           to_char(work_date, 'MM-DD') = ANY($2::text[]) AS is_holiday
      FROM (SELECT * FROM marked_days UNION ALL SELECT * FROM bridged_days) d
  )`;

/**
 * CTE vacation_periods (после VACATION_DAYS_CTE): дни по заявлению — одним периодом заявления,
 * ручные отметки — непрерывными по датам отрезками одного статуса. leave_request_key — id заявления
 * текстом (как source_id) или NULL. Без LIMIT: остаток берёт все периоды, история режет сама.
 */
const VACATION_PERIODS_CTE = `${VACATION_DAYS_CTE},
  grouped AS (
    SELECT d.*,
           CASE
             WHEN d.source_type = 'leave_request' THEN 'lr:' || d.source_id
             ELSE 'tab:' || d.status || ':' || (d.work_date - (ROW_NUMBER() OVER (
                    PARTITION BY d.source_type = 'leave_request', d.status
                    ORDER BY d.work_date))::int)::text
           END AS grp_key
      FROM vacation_days d
  ),
  vacation_periods AS (
    SELECT min(g.work_date) AS start_date,
           max(g.work_date) AS end_date,
           g.status,
           count(*)::int AS calendar_days,
           count(*) FILTER (WHERE g.is_holiday)::int AS holiday_days,
           CASE WHEN g.grp_key LIKE 'lr:%' THEN substr(g.grp_key, 4) END AS leave_request_key
      FROM grouped g
     GROUP BY g.grp_key, g.status
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
    `WITH ${VACATION_PERIODS_CTE}
     SELECT p.start_date,
            p.end_date,
            p.status,
            p.calendar_days,
            p.holiday_days,
            CASE WHEN p.leave_request_key IS NOT NULL THEN 'leave_request' ELSE 'timesheet' END AS source,
            lr.id AS leave_request_id,
            up.full_name AS reviewer_name,
            lr.reviewed_at
       FROM vacation_periods p
       LEFT JOIN leave_requests lr ON lr.id::text = p.leave_request_key
       LEFT JOIN user_profiles up ON up.id = lr.reviewer_id
      ORDER BY p.start_date DESC
      LIMIT ${HISTORY_LIMIT}`,
    [employeeId, NON_WORKING_HOLIDAYS_MMDD],
  );

/** Начисление за месяц, сотые дня: ровно 2,33, как в 1С (остатки 1С кратны 2,33, а не 28/12). */
export const VACATION_ACCRUAL_PER_MONTH_HUNDREDTHS = 233;
/** Месяц увольнения засчитывается от 15 дней (Правила об очередных и дополнительных отпусках, п. 35). */
export const HALF_MONTH_DAYS = 15;
/** «Без сохранения» до 14 дней за год входит в стаж для отпуска (ст. 121 ТК), сверх — нет. */
export const UNPAID_FREE_DAYS_PER_YEAR = 14;

const MS_PER_DAY = 86_400_000;

const toDayNumber = (iso: string): number => {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
};

const fromDayNumber = (dayNumber: number): string => new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);

export const addDaysIso = (iso: string, days: number): string => fromDayNumber(toDayNumber(iso) + days);

/** Сквозной номер месяца: год × 12 + месяц − 1. */
const monthNumber = (iso: string): number => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/** 1-е число месяца, следующего за месяцем даты. */
const firstOfNextMonth = (iso: string): string => {
  const next = monthNumber(iso) + 1;
  return `${Math.floor(next / 12)}-${String((next % 12) + 1).padStart(2, '0')}-01`;
};

export interface IAccrual {
  /** Целиком засчитанные месяцы: текущий — только в его последний день (или по порогу увольнения). */
  months: number;
  /** Начислено, сотые дня: месяцы по 233 + доля текущего. */
  hundredths: number;
}

/**
 * Начисление с accrualFrom по accrualUntil включительно. Месяцы до месяца accrualUntil — по 233 (месяц приёма тоже
 * целиком). Месяц accrualUntil считается от max(1-е число, accrualFrom):
 *  - dismissed (accrualUntil — день увольнения, сдвинутый ст. 121) — 233 от 15 дней, иначе 0;
 *  - иначе — 233 × прошло / всего дней счёта в месяце, округление до сотой (половина — вверх); в последний день — 233.
 */
export const calcAccrual = (accrualFrom: string, accrualUntil: string, dismissed: boolean): IAccrual => {
  if (accrualUntil < accrualFrom) return { months: 0, hundredths: 0 };
  const fullMonths = monthNumber(accrualUntil) - monthNumber(accrualFrom);
  const monthStart = `${accrualUntil.slice(0, 8)}01`;
  const countFrom = accrualFrom > monthStart ? accrualFrom : monthStart;
  const passed = toDayNumber(accrualUntil) - toDayNumber(countFrom) + 1;
  const total = toDayNumber(firstOfNextMonth(accrualUntil)) - toDayNumber(countFrom);
  const perMonth = VACATION_ACCRUAL_PER_MONTH_HUNDREDTHS;
  const lastFull = dismissed ? passed >= HALF_MONTH_DAYS : passed === total;
  let lastPart = 0;
  if (lastFull) lastPart = perMonth;
  else if (!dismissed) lastPart = Math.floor((2 * perMonth * passed + total) / (2 * total));
  return { months: fullMonths + (lastFull ? 1 : 0), hundredths: fullMonths * perMonth + lastPart };
};

/** Сотые дня → «7.21» / «-11.71». */
export const hundredthsToDays = (hundredths: number): string => {
  const abs = Math.abs(hundredths);
  return `${hundredths < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

interface IBalanceStartRow {
  hire_date: string | null;
  dismissal_date: string | null;
  opening_as_of: string | null;
  opening_days: string | null;
  /** Граница учтённых 1С отпусков (миграция 360); NULL — дата остатка. */
  vacations_through?: string | null;
  last_as_of: string | null;
}

interface IBalanceStart {
  source: IVacationBalance['source'];
  as_of: string;
  opening_days: string;
  /** Первый день счёта «без сохранения». */
  start: string;
  /** Первый день начисления: у остатка 1С — 1-е число месяца после as_of (его месяц 1С уже начислила). */
  accrual_from: string;
  /** Отпуска, начавшиеся по эту дату, уже в остатке 1С (или до приёма) — не вычитаются. */
  vacations_from: string;
}

/**
 * Откуда считать: строка 1С (счёт со следующего дня) или, если человек принят после последней
 * выгрузки 1С, ноль с даты приёма. Принятый раньше выгрузки без строки 1С — null: не с чего.
 */
export const resolveBalanceStart = (row: IBalanceStartRow): IBalanceStart | null => {
  if (row.opening_as_of && row.opening_days !== null) {
    return {
      source: '1c', as_of: row.opening_as_of, opening_days: row.opening_days,
      start: addDaysIso(row.opening_as_of, 1), accrual_from: firstOfNextMonth(row.opening_as_of),
      vacations_from: row.vacations_through ?? row.opening_as_of,
    };
  }
  if (row.hire_date && row.last_as_of && row.hire_date > row.last_as_of) {
    return {
      source: 'hire', as_of: row.hire_date, opening_days: '0.00', start: row.hire_date, accrual_from: row.hire_date,
      vacations_from: addDaysIso(row.hire_date, -1),
    };
  }
  return null;
};

/**
 * Остаток по правилам из шапки файла. opening_days — NUMERIC(6,2) строкой, в сотые без потерь:
 * Math.round(x * 100), как с копейками в «Зарплате».
 */
export const calcVacationBalance = (
  startInfo: IBalanceStart,
  today: string,
  dismissalDate: string | null,
  usedDays: number,
  unpaidExcessDays: number,
): IVacationBalance => {
  const dismissed = dismissalDate !== null && dismissalDate <= today;
  const until = dismissed ? dismissalDate : today;
  const accrualUntil = addDaysIso(until, -unpaidExcessDays);
  const accrual = calcAccrual(startInfo.accrual_from, accrualUntil, dismissed);
  const opening = Math.round(Number(startInfo.opening_days) * 100);
  return {
    source: startInfo.source,
    as_of: startInfo.as_of,
    opening_days: hundredthsToDays(opening),
    until,
    accrued_months: accrual.months,
    accrued_days: hundredthsToDays(accrual.hundredths),
    used_days: usedDays,
    unpaid_excess_days: unpaidExcessDays,
    current_days: hundredthsToDays(opening + accrual.hundredths - usedDays * 100),
  };
};

/** Остаток ежегодного отпуска на today (YYYY-MM-DD, Москва); null — остаток не с чего считать. */
export const getVacationBalance = async (
  employeeId: number,
  today: string,
): Promise<IVacationBalance | null> => {
  const row = await queryOne<IBalanceStartRow & { counted_leave_ids: string[] }>(
    `SELECT e.hire_date::text AS hire_date,
            e.dismissal_date::text AS dismissal_date,
            b.as_of_date::text AS opening_as_of,
            b.days::text AS opening_days,
            b.vacations_through::text AS vacations_through,
            COALESCE((SELECT array_agg(c.leave_request_id::text)
                        FROM payroll_vacation_balance_counted_leaves c
                       WHERE c.employee_id = e.id AND c.as_of_date = b.as_of_date), '{}') AS counted_leave_ids,
            (SELECT max(as_of_date) FROM payroll_vacation_balances WHERE as_of_date <= $2::date)::text AS last_as_of
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT as_of_date, days, vacations_through
           FROM payroll_vacation_balances
          WHERE employee_id = e.id AND as_of_date <= $2::date
          ORDER BY as_of_date DESC
          LIMIT 1
       ) b ON true
      WHERE e.id = $1`,
    [employeeId, today],
  );
  const startInfo = row ? resolveBalanceStart(row) : null;
  if (!row || !startInfo) return null;

  const until = row.dismissal_date !== null && row.dismissal_date <= today ? row.dismissal_date : today;
  // Отпуск — целиком в день начала, кроме учтённых 1С. «Без сохранения» — по дням и по годам от начала счёта
  // (возраст дня от $3 в полных годах).
  const counts = await queryOne<{ used_days: number; unpaid_excess_days: number }>(
    `WITH ${VACATION_PERIODS_CTE},
     unpaid_by_year AS (
       SELECT count(*) AS days
         FROM vacation_days
        WHERE status = 'unpaid' AND work_date BETWEEN $3::date AND $4::date
        GROUP BY extract(year FROM age(work_date, $3::date))
     )
     SELECT
       (SELECT COALESCE(sum(calendar_days - holiday_days), 0) FROM vacation_periods
         WHERE status = 'vacation' AND start_date > $5::date AND start_date <= $4::date
           AND (leave_request_key IS NULL OR NOT leave_request_key = ANY($6::text[])))::int AS used_days,
       (SELECT COALESCE(sum(GREATEST(days - ${UNPAID_FREE_DAYS_PER_YEAR}, 0)), 0) FROM unpaid_by_year)::int
         AS unpaid_excess_days`,
    [employeeId, NON_WORKING_HOLIDAYS_MMDD, startInfo.start, until, startInfo.vacations_from, row.counted_leave_ids],
  );

  return calcVacationBalance(
    startInfo,
    today,
    row.dismissal_date,
    Number(counts?.used_days ?? 0),
    Number(counts?.unpaid_excess_days ?? 0),
  );
};
