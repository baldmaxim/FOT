/**
 * «Проживание» → «Компенсация аренды» (кадры, миграции 371, 374) — как документ 1С «Список сотрудников для получения
 * возмещения за проживание»: компенсации месяца (вид apartment, 630 ₽/день) с днями и суммой из того же расчёта ФОТ,
 * что «Расчёты» и «Доплата за месяц» «Зарплаты» (getPreliminaryPayoutForEmployees → apartmentAllowance), — правила
 * здесь не повторяются.
 *
 * Отличие от «Доплаты за месяц» (listHousingMonthAmounts — её поведение не меняется): охват — кадровый (список
 * «Управления кадрами», вместе с уволенными, чьё проживание задевает месяц), а не «штат зарплаты»; кроме суммы —
 * «Кол-во дней (табель)» (отработанные с компенсацией) и «Кол-во выходных» (выходные месяца до потолка, как 1С).
 * Строка — сотрудник месяца (последнее его проживание, lastStaysOfMonth). Сумма — из расчёта; месяц не посчитан
 * (будущий, 1-е число текущего, табель или бригада не готовы) — null.
 * Пауза (374): приостановленная и не возобновлённая компенсация видна и в следующих месяцах (сумма 0,00), пока
 * сотрудник не уволен до месяца и не живёт в нём в общежитии или квартире. В строке — начало цепочки «пауза →
 * возобновление», даты паузы и возобновления, период в бригаде (подсветка: дни в бригаде не оплачиваются), отдел и
 * должность — по назначению на конец месяца (не позже сегодня и даты увольнения).
 * Ничего не пишет (fixBrigades: false): вкладку открывают кадры и комендант без прав «Зарплаты» — закрытая бригада
 * без зафиксированных долей считается предварительно, как в «Расчётах» до фиксации; сумма квартиры от долей не зависит.
 */
import { query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { effectiveDepartmentSql } from './employees-export.service.js';
import { lastDayOfMonth } from './payroll/payroll-payslip.rules.js';
import { resolvePreliminaryAsOf } from './payroll/brigade-salary.service.js';
import { getPreliminaryPayoutForEmployees, type PayrollCalcWithPreliminary } from './payroll/payroll-calc.service.js';
import { lastStaysOfMonth } from './payroll/payroll-housing-month.service.js';
import { listStaysOfClass, type IDormitoryStay } from './dormitory-stays.service.js';

/** Порция расчёта — как у «Расчётов» и «Доплаты за месяц» (≤ 500 id). */
const CALC_CHUNK_SIZE = 500;

/** Пауза и возобновление вокруг записи строки; начало — первая запись цепочки. */
export interface ICompensationChain {
  /** YYYY-MM-DD — начало первой записи цепочки «пауза → возобновление». */
  compensation_start: string;
  /** YYYY-MM-DD — с какой даты приостановлена (последняя пауза около записи); нет — null. */
  paused_from: string | null;
  /** YYYY-MM-DD — с какой даты возобновлена; нет — null. */
  resumed_from: string | null;
}

export interface ICompensationMonthRow extends IDormitoryStay, ICompensationChain {
  /** YYYY-MM. */
  month: string;
  /** Сумма к оплате за месяц, numeric строкой; '0.00' — не работал во время проживания; null — не посчитан. */
  month_amount: string | null;
  /** Отработано по табелю с компенсацией; null — не посчитан. */
  worked_days: number | null;
  /** Выходные месяца (до потолка, как 1С); null — не посчитан. */
  weekend_days: number | null;
  /** Период в бригаде, задевающий месяц (последний): YYYY-MM-DD; нет — null; to null — по сей день. */
  brigade_from: string | null;
  brigade_to: string | null;
}

type MoneyFields = Pick<ICompensationMonthRow, 'month_amount' | 'worked_days' | 'weekend_days'>;

/** Дни и сумма квартиры из расчёта месяца; не посчитан — все null. */
export const compensationFromCalc = (calc: PayrollCalcWithPreliminary | undefined): MoneyFields => {
  if (!calc || calc.state === 'not_closed') return { month_amount: null, worked_days: null, weekend_days: null };
  const housing = calc.rate_allowances.find(allowance => allowance.code === 'housing');
  if (!housing) return { month_amount: '0.00', worked_days: 0, weekend_days: 0 };
  const added = housing.housing_weekend_days ?? 0;
  return {
    month_amount: housing.amount,
    worked_days: (housing.housing_days ?? 0) - added,
    weekend_days: housing.housing_month_weekends ?? added,
  };
};

/**
 * Цепочка записи stay среди всех компенсаций сотрудника: начало — по resumed_from_id до первой записи; приостановленная
 * запись — её пауза и возобновление (если есть); возобновлённая — пауза прежней записи и своё начало.
 */
export const compensationChainOf = (
  stay: Pick<IDormitoryStay, 'id' | 'check_in' | 'check_out' | 'suspended' | 'resumed_from_id'>,
  all: ReadonlyArray<Pick<IDormitoryStay, 'id' | 'check_in' | 'check_out' | 'suspended' | 'resumed_from_id'>>,
): ICompensationChain => {
  const byId = new Map(all.map(item => [item.id, item]));
  let first = stay;
  const seen = new Set<number>([stay.id]);
  while (first.resumed_from_id !== null) {
    const parent = byId.get(first.resumed_from_id);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    first = parent;
  }
  if (stay.suspended) {
    const child = all.find(item => item.resumed_from_id === stay.id);
    return { compensation_start: first.check_in, paused_from: stay.check_out, resumed_from: child?.check_in ?? null };
  }
  const parent = stay.resumed_from_id !== null ? byId.get(stay.resumed_from_id) : undefined;
  return {
    compensation_start: first.check_in,
    paused_from: parent?.check_out ?? null,
    resumed_from: parent ? stay.check_in : null,
  };
};

/** Приостановленные до месяца и не возобновлённые — без проживания в месяце, не уволенные до него. */
const listPausedBefore = async (
  employeeIds: number[] | null,
  monthStart: string,
  monthEnd: string,
): Promise<Array<{ id: number; employee_id: number }>> => (
  (await query<{ id: number; employee_id: number }>(
    `SELECT s.id, s.employee_id
       FROM employee_dormitory_stays s
       JOIN employees e ON e.id = s.employee_id
      WHERE s.kind = 'apartment'
        AND (to_jsonb(s) ->> 'suspended')::boolean IS TRUE
        AND s.check_out <= $2::date
        AND ($1::int[] IS NULL OR s.employee_id = ANY($1::int[]))
        AND (e.dismissal_date IS NULL OR e.dismissal_date >= $2::date)
        AND NOT EXISTS (
          SELECT 1 FROM employee_dormitory_stays r
           WHERE r.employee_id = s.employee_id AND (to_jsonb(r) ->> 'resumed_from_id')::int = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM employee_dormitory_stays o
           WHERE o.employee_id = s.employee_id
             AND o.check_in <= $3::date AND (o.check_out IS NULL OR o.check_out > $2::date)
        )`,
    [employeeIds, monthStart, monthEnd],
  )).map(row => ({ id: Number(row.id), employee_id: Number(row.employee_id) }))
);

interface IMonthPlacement {
  employee_id: number;
  department: string | null;
  position: string | null;
  brigade_from: string | null;
  brigade_to: string | null;
}

/**
 * Отдел и должность — по назначению на min(конец месяца, сегодня, дата увольнения), нет назначения — карточка (у
 * уволенного — отдел увольнения); период в бригаде — последнее назначение в отдел вида «бригада», задевающее месяц.
 */
const loadMonthPlacements = async (
  employeeIds: readonly number[],
  monthStart: string,
  monthEnd: string,
  today: string,
): Promise<Map<number, IMonthPlacement>> => {
  if (employeeIds.length === 0) return new Map();
  const rows = await query<IMonthPlacement>(
    `SELECT e.id AS employee_id,
            COALESCE(ad.name, cd.name) AS department,
            COALESCE(ap.name, cp.name) AS position,
            to_char(b.effective_from, 'YYYY-MM-DD') AS brigade_from,
            to_char(b.effective_to, 'YYYY-MM-DD') AS brigade_to
       FROM unnest($1::int[]) AS x(id)
       JOIN employees e ON e.id = x.id
       CROSS JOIN LATERAL (SELECT LEAST($3::date, $4::date, COALESCE(e.dismissal_date, $3::date)) AS day) d
       LEFT JOIN LATERAL (
         SELECT ea.org_department_id, ea.position_id
           FROM employee_assignments ea
          WHERE ea.employee_id = e.id
            AND ea.effective_from <= d.day
            AND (ea.effective_to IS NULL OR ea.effective_to >= d.day)
          ORDER BY ea.effective_from DESC
          LIMIT 1
       ) a ON true
       LEFT JOIN org_departments ad ON ad.id = a.org_department_id
       LEFT JOIN positions ap ON ap.id = a.position_id
       LEFT JOIN org_departments cd ON cd.id = ${effectiveDepartmentSql('e')}
       LEFT JOIN positions cp ON cp.id = e.position_id
       LEFT JOIN LATERAL (
         SELECT ea.effective_from, ea.effective_to
           FROM employee_assignments ea
           JOIN org_departments od ON od.id = ea.org_department_id AND od.kind = 'brigade'
          WHERE ea.employee_id = e.id
            AND ea.effective_from <= $3::date
            AND (ea.effective_to IS NULL OR ea.effective_to >= $2::date)
          ORDER BY ea.effective_from DESC
          LIMIT 1
       ) b ON true`,
    [[...employeeIds], monthStart, monthEnd, today],
  );
  return new Map(rows.map(row => [Number(row.employee_id), row]));
};

/** Компенсации месяца month (YYYY-MM) в кадровом охвате employeeIds (null — все) с днями и суммой. */
export const listCompensationMonth = async (
  employeeIds: number[] | null,
  month: string,
  req: AuthenticatedRequest,
): Promise<ICompensationMonthRow[]> => {
  const monthStart = `${month}-01`;
  const monthEnd = lastDayOfMonth(month);
  const stays = await listStaysOfClass('compensation', employeeIds, { from: monthStart, to: monthEnd });
  const monthStays = lastStaysOfMonth(stays, month);
  const ids = monthStays.map(stay => stay.employee_id);
  const inMonth = new Set(ids);
  const pausedRefs = (await listPausedBefore(employeeIds, monthStart, monthEnd))
    .filter(ref => !inMonth.has(ref.employee_id));
  if (ids.length === 0 && pausedRefs.length === 0) return [];
  // Все компенсации сотрудников строк — цепочки «пауза → возобновление».
  const history = await listStaysOfClass('compensation', [...ids, ...pausedRefs.map(ref => ref.employee_id)]);
  const pausedIds = new Set(pausedRefs.map(ref => ref.id));
  const paused = history.filter(stay => pausedIds.has(stay.id));

  const calcs = new Map<number, PayrollCalcWithPreliminary>();
  if (ids.length > 0 && resolvePreliminaryAsOf(month) !== null) {
    for (let start = 0; start < ids.length; start += CALC_CHUNK_SIZE) {
      const payouts = await getPreliminaryPayoutForEmployees(
        ids.slice(start, start + CALC_CHUNK_SIZE), month, req, undefined, { fixBrigades: false },
      );
      for (const [employeeId, calc] of payouts) calcs.set(employeeId, calc);
    }
  }
  const placements = await loadMonthPlacements(
    [...ids, ...paused.map(stay => stay.employee_id)], monthStart, monthEnd, moscowTodayIso(),
  );
  const historyOf = (employeeId: number) => history.filter(stay => stay.employee_id === employeeId);
  const row = (stay: IDormitoryStay, money: MoneyFields): ICompensationMonthRow => {
    const placement = placements.get(stay.employee_id);
    return {
      ...stay,
      department: placement ? placement.department : stay.department,
      position: placement ? placement.position : stay.position,
      month,
      ...money,
      ...compensationChainOf(stay, historyOf(stay.employee_id)),
      brigade_from: placement?.brigade_from ?? null,
      brigade_to: placement?.brigade_to ?? null,
    };
  };
  return [
    ...monthStays.map(stay => row(stay, compensationFromCalc(calcs.get(stay.employee_id)))),
    ...paused.map(stay => row(stay, { month_amount: '0.00', worked_days: 0, weekend_days: 0 })),
  ];
};
