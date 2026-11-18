/**
 * Условия оплаты сотрудника: категория персонала и вид оплаты («по графику» / «по часам»).
 *
 * Историчность вместо перезаписи. Смена условий — это закрытие текущей строки
 * (effective_to = D-1) и вставка новой с effective_from = D, одной транзакцией.
 * Прошлые расчёты ссылаются на конкретный terms_id и не переигрываются.
 * Пересечение периодов физически невозможно: EXCLUDE в БД (миграция 271).
 *
 * Неполная занятость выражается ОДНИМ механизмом — личным графиком работы.
 * Поэтому staff_units здесь справочный и в расчёте не участвует: иначе половина
 * ставки применилась бы дважды (график «0,5 ставки» уже даёт 4 ч вместо 8).
 */
import { query, queryOne, withTransaction, type DbExecutor } from '../../config/postgres.js';
import {
  insertPlannedPeriod,
  plannedValueOf,
  readPlannedPeriods,
  replacePlannedPeriod,
  resolvePlannedValue,
  samePlannedValue,
} from './payroll-planned-supplement-rows.js';

/** Категория персонала — по табелю (payroll-staff-category.ts); на формулу расчёта не влияет. */
export type StaffCategory = 'office' | 'itr' | 'worker';
/** Вид оплаты. Единственное, что определяет формулу начисления. */
export type PayrollCalcType = 'salary' | 'hourly';

/**
 * Округление оклада за неполный месяц, как в ЗУП: до рубля или дневная ставка до копейки × дни. С ноября 2026 (оклад по
 * часам, payroll-calc-hours.rules.ts) daily_kopeck — вся сумма сегмента до копейки один раз.
 */
export type ProrationRounding = 'ruble' | 'daily_kopeck';

export const PRORATION_ROUNDINGS: readonly ProrationRounding[] = ['ruble', 'daily_kopeck'];

/** Тип договора: трудовой или ГПХ (миграция 352). Пометка, в расчёте не участвует. */
export type ContractType = 'labor' | 'gph';

export const CONTRACT_TYPES: readonly ContractType[] = ['labor', 'gph'];

export interface IPayrollTerms {
  id: number;
  employee_id: number;
  organization_id: string | null;
  /** Снимок категории на дату сохранения; актуальную категорию и «Проезд» решает табель. */
  staff_category: StaffCategory;
  calc_type: PayrollCalcType;
  monthly_salary: number | null;
  hourly_rate: number | null;
  /** Премиальная часть, ₽/мес. Справочно, в расчёте пока не участвует. */
  bonus_amount: number | null;
  /** Компенсация проживания, ₽/мес. Справочно, в расчёте пока не участвует. */
  housing_compensation: number | null;
  /** Компенсации проезда и связи, ₽/мес. Справочно, в расчёте пока не участвуют. */
  travel_compensation: number | null;
  communication_compensation: number | null;
  /** Ежемесячное удержание, ₽/мес (положительное). Справочно, в расчёте пока не участвует. */
  deduction_amount: number | null;
  /** Округление оклада за неполный месяц, как в ЗУП (миграция 331). */
  proration_rounding: ProrationRounding;
  /** Тип договора (миграция 352). */
  contract_type: ContractType;
  staff_units: number;
  time_accounting_mode: 'daily' | 'summarized';
  accounting_period_months: number | null;
  effective_from: string;
  effective_to: string | null;
  change_reason: string | null;
  order_number: string | null;
  order_date: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface IAssignTermsInput {
  employeeId: number;
  staffCategory: StaffCategory;
  calcType: PayrollCalcType;
  /** Оклад — только для calc_type='salary'. */
  monthlySalary?: number | null;
  /** Часовая ставка — только для calc_type='hourly'. */
  hourlyRate?: number | null;
  /** Не передано — NULL: условия пишутся новой строкой, и прежнее значение очищается. */
  bonusAmount?: number | null;
  housingCompensation?: number | null;
  travelCompensation?: number | null;
  communicationCompensation?: number | null;
  deductionAmount?: number | null;
  /** Не передано — ruble. */
  prorationRounding?: ProrationRounding;
  /** Не передано — labor. */
  contractType?: ContractType;
  staffUnits?: number;
  organizationId?: string | null;
  effectiveFrom: string;
  changeReason?: string | null;
  orderNumber?: string | null;
  orderDate?: string | null;
  note?: string | null;
  createdBy: string;
}

const TERMS_COLUMNS = `
  id, employee_id, organization_id, staff_category, calc_type,
  monthly_salary, hourly_rate, bonus_amount, housing_compensation,
  travel_compensation, communication_compensation, deduction_amount, proration_rounding, contract_type, staff_units,
  time_accounting_mode, accounting_period_months,
  effective_from, effective_to,
  change_reason, order_number, order_date, note,
  created_by, created_at, updated_at`;

/** Полная история условий сотрудника, новые сверху. */
export const getTermsHistory = async (employeeId: number): Promise<IPayrollTerms[]> =>
  query<IPayrollTerms>(
    `SELECT ${TERMS_COLUMNS}
       FROM payroll_compensation_terms
      WHERE employee_id = $1
      ORDER BY effective_from DESC, id DESC`,
    [employeeId],
  );

/** Изменение оклада или ставки. Суммы — текстом: NUMERIC без потери точности. */
export interface ISalaryChange {
  effective_from: string;
  /** null — действует по сей день. */
  effective_to: string | null;
  calc_type: PayrollCalcType;
  /** Оклад (₽/мес) или часовая ставка (₽/ч). */
  amount: string;
  /** Премиальная часть ₽/мес; null — не задана (0 тоже null). */
  bonus: string | null;
  /** Оклад + премия; у почасовой — null: ₽/ч с ₽/мес не складываются. */
  total: string | null;
  prev_calc_type: PayrollCalcType | null;
  /** Тип договора записи и прежний; null — записи раньше нет. */
  contract_type: ContractType;
  prev_contract_type: ContractType | null;
  prev_amount: string | null;
  prev_bonus: string | null;
  prev_total: string | null;
  /**
   * Разница и процент — только при том же виде оплаты: оклад со ставкой не сравнить.
   * У оклада — по итогу (оклад + премия): перенос суммы из оклада в премию даёт 0; у ставки — по ставке.
   */
  diff: string | null;
  diff_percent: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

/**
 * История оклада / ставки, новые сверху.
 *
 * Новая строка условий появляется и при смене одной компенсации, поэтому подряд идущие строки
 * с тем же видом оплаты, суммой, премией и договором склеиваются в одно изменение (острова по флагу смены).
 * Смена одного договора (Трудовой ↔ ГПХ) — отдельная запись: иначе в истории её не видно.
 * Деньги считаются в SQL: NUMERIC приходит строкой, арифметика в JS запрещена.
 */
export const getSalaryChanges = async (employeeId: number): Promise<ISalaryChange[]> =>
  query<ISalaryChange>(
    `WITH terms AS (
       SELECT t.id, t.effective_from, t.effective_to, t.calc_type, t.contract_type, t.created_by, t.created_at,
              COALESCE(t.monthly_salary, t.hourly_rate) AS amount,
              NULLIF(t.bonus_amount, 0) AS bonus,
              CASE
                WHEN LAG(t.calc_type) OVER w = t.calc_type
                 AND LAG(COALESCE(t.monthly_salary, t.hourly_rate)) OVER w
                     = COALESCE(t.monthly_salary, t.hourly_rate)
                 AND LAG(NULLIF(t.bonus_amount, 0)) OVER w IS NOT DISTINCT FROM NULLIF(t.bonus_amount, 0)
                 AND LAG(t.contract_type) OVER w = t.contract_type
                THEN 0 ELSE 1
              END AS is_change
         FROM payroll_compensation_terms t
        WHERE t.employee_id = $1
       WINDOW w AS (ORDER BY t.effective_from, t.id)
     ), grouped AS (
       SELECT terms.*, SUM(is_change) OVER (ORDER BY effective_from, id) AS grp
         FROM terms
     ), periods AS (
       SELECT MIN(effective_from) AS effective_from,
              CASE WHEN bool_or(effective_to IS NULL) THEN NULL ELSE MAX(effective_to) END AS effective_to,
              (array_agg(calc_type ORDER BY effective_from, id))[1] AS calc_type,
              (array_agg(contract_type ORDER BY effective_from, id))[1] AS contract_type,
              (array_agg(amount ORDER BY effective_from, id))[1] AS amount,
              (array_agg(bonus ORDER BY effective_from, id))[1] AS bonus,
              (array_agg(created_by ORDER BY effective_from, id))[1] AS created_by,
              (array_agg(created_at ORDER BY effective_from, id))[1] AS created_at
         FROM grouped
        GROUP BY grp
     ), paid AS (
       -- Что сравнивать: у оклада — итог с премией, у ставки — сама ставка.
       SELECT periods.*,
              CASE WHEN calc_type = 'salary' THEN amount + COALESCE(bonus, 0) END AS total,
              CASE WHEN calc_type = 'salary' THEN amount + COALESCE(bonus, 0) ELSE amount END AS pay
         FROM periods
     ), compared AS (
       SELECT paid.*,
              LAG(calc_type) OVER o AS prev_calc_type,
              LAG(contract_type) OVER o AS prev_contract_type,
              LAG(amount) OVER o AS prev_amount,
              LAG(bonus) OVER o AS prev_bonus,
              LAG(total) OVER o AS prev_total,
              LAG(pay) OVER o AS prev_pay
         FROM paid
       WINDOW o AS (ORDER BY effective_from)
     )
     SELECT c.effective_from, c.effective_to, c.calc_type,
            c.amount::text AS amount,
            c.bonus::text AS bonus,
            c.total::text AS total,
            c.prev_calc_type,
            c.contract_type,
            c.prev_contract_type,
            c.prev_amount::text AS prev_amount,
            c.prev_bonus::text AS prev_bonus,
            c.prev_total::text AS prev_total,
            CASE WHEN c.prev_calc_type = c.calc_type
                 THEN (c.pay - c.prev_pay)::text END AS diff,
            CASE WHEN c.prev_calc_type = c.calc_type AND c.prev_pay > 0
                 THEN ROUND((c.pay - c.prev_pay) * 100 / c.prev_pay, 1)::text END AS diff_percent,
            up.full_name AS changed_by_name,
            c.created_at AS changed_at
       FROM compared c
       LEFT JOIN user_profiles up ON up.id = c.created_by
      ORDER BY c.effective_from DESC`,
    [employeeId],
  );

/** Плановая доплата: сумма ₽/мес на период «с — по» включительно. */
export interface IPlannedSupplementValue {
  amount: number;
  dateFrom: string;
  /** null — бессрочно (миграция 322). */
  dateTo: string | null;
  /**
   * Комментарий периода (миграция 364): null — без комментария; undefined — не передан (прежний клиент, 🗑 «Убрать»):
   * остаётся прежний комментарий правленой доплаты (у новой — без комментария).
   */
  comment?: string | null;
}

/** Итог записи плановой доплаты по сотруднику: exists — значение совпало с другой действующей доплатой. */
export type PlannedSupplementWrite =
  | { status: 'unchanged' }
  | { status: 'exists' }
  | { status: 'saved'; previous: IPlannedSupplementValue | null };

/**
 * Записать доплату сотрудника по прежнему контракту «одна доплата» (окно «Расчётов» прежнего клиента, PUT/DELETE
 * /supplements/planned/employee/:empId): value — правка, null — снять. С миграции 369 доплат у сотрудника может быть
 * несколько, правится последняя по дате (date_from DESC, id DESC) — та же, что прежний клиент видит в полях
 * (planned_supplement_* списка условий). Действующих нет — новая доплата; снимать нечего — ничего не пишется.
 *
 * value.comment undefined — комментарий правленой доплаты. Совпадает с правленой — 'unchanged', с другой действующей —
 * 'exists' (две одинаковые доплаты не заводим). previous — значение правленой доплаты (для аудита).
 * Вызывать в транзакции под lockPayrollEmployee. createdBy null — запись скриптом, без автора.
 */
export const setPlannedSupplement = async (
  exec: DbExecutor,
  input: { employeeId: number; value: IPlannedSupplementValue | null; createdBy: string | null },
): Promise<PlannedSupplementWrite> => {
  const periods = await readPlannedPeriods(exec, input.employeeId);
  const latest = periods[0] ?? null;
  if (input.value === null) {
    if (!latest) return { status: 'unchanged' };
    await replacePlannedPeriod(exec, { employeeId: input.employeeId, target: latest, value: null, createdBy: input.createdBy });
    return { status: 'saved', previous: plannedValueOf(latest) };
  }
  const next = resolvePlannedValue(input.value, latest?.comment ?? null);
  if (latest && samePlannedValue(latest, next)) return { status: 'unchanged' };
  if (periods.some(period => period !== latest && samePlannedValue(period, next))) return { status: 'exists' };
  if (latest) {
    await replacePlannedPeriod(exec, { employeeId: input.employeeId, target: latest, value: next, createdBy: input.createdBy });
  } else {
    await insertPlannedPeriod(exec, { employeeId: input.employeeId, value: next, createdBy: input.createdBy });
  }
  return { status: 'saved', previous: latest && plannedValueOf(latest) };
};

/**
 * Сериализует назначение условий и доплаты по сотруднику до конца транзакции:
 * без неё два параллельных сохранения записали бы по версии доплаты от одной и той же прежней.
 */
export const lockPayrollEmployee = async (exec: DbExecutor, employeeId: number): Promise<void> => {
  await exec.query(`SELECT pg_advisory_xact_lock(hashtext('payroll_terms:' || $1::text))`, [employeeId]);
};

/** Изменение плановой доплаты. Суммы — текстом NUMERIC. */
export interface IPlannedSupplementChange {
  id: number;
  /** assigned — первая доплата или после снятия; changed — замена; removed — снята. */
  action: 'assigned' | 'changed' | 'removed';
  /** null — доплата снята. */
  amount: string | null;
  date_from: string | null;
  date_to: string | null;
  prev_amount: string | null;
  prev_date_from: string | null;
  prev_date_to: string | null;
  /** Комментарий периода (миграция 364): стало и было; null — без комментария. */
  comment: string | null;
  prev_comment: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

/**
 * История плановой доплаты, новые сверху. У строки с replaces_id «было» — заменённая строка (правка, снятие —
 * архивная строка «снята» с prev — значениями снятой доплаты); копии без изменений (переписывание 337) не
 * показываются. Без replaces_id: строка журнала до 369 (legacy_journal) — «было» из предыдущей строки по id; новая
 * строка — самостоятельная доплата (369), «было» нет — «assigned», даже если у сотрудника есть другие доплаты.
 * Комментарий (миграция 364) — часть версии: правка только его — тоже «changed», копия — когда совпал и он.
 */
export const getPlannedSupplementChanges = async (employeeId: number): Promise<IPlannedSupplementChange[]> =>
  query<IPlannedSupplementChange>(
    `WITH ordered AS (
       SELECT s.id, s.amount, s.date_from, s.date_to, s.comment, s.created_by, s.created_at, s.replaces_id,
              s.legacy_journal,
              LAG(s.amount) OVER w AS lag_amount,
              LAG(s.date_from) OVER w AS lag_date_from,
              LAG(s.date_to) OVER w AS lag_date_to,
              LAG(s.comment) OVER w AS lag_comment
         FROM payroll_planned_supplements s
        WHERE s.employee_id = $1
       WINDOW w AS (ORDER BY s.id)
     ),
     versions AS (
       SELECT o.id, o.amount, o.date_from, o.date_to, o.comment, o.created_by, o.created_at,
              CASE WHEN o.replaces_id IS NOT NULL THEN r.amount WHEN o.legacy_journal THEN o.lag_amount END AS prev_amount,
              CASE WHEN o.replaces_id IS NOT NULL THEN r.date_from WHEN o.legacy_journal THEN o.lag_date_from END AS prev_date_from,
              CASE WHEN o.replaces_id IS NOT NULL THEN r.date_to WHEN o.legacy_journal THEN o.lag_date_to END AS prev_date_to,
              CASE WHEN o.replaces_id IS NOT NULL THEN r.comment WHEN o.legacy_journal THEN o.lag_comment END AS prev_comment,
              o.replaces_id IS NOT NULL
                AND o.amount IS NOT DISTINCT FROM r.amount
                AND o.date_from IS NOT DISTINCT FROM r.date_from
                AND o.date_to IS NOT DISTINCT FROM r.date_to
                AND o.comment IS NOT DISTINCT FROM r.comment AS is_copy
         FROM ordered o
         LEFT JOIN payroll_planned_supplements r ON r.id = o.replaces_id
     )
     SELECT v.id,
            CASE
              WHEN v.amount IS NULL THEN 'removed'
              WHEN v.prev_amount IS NULL THEN 'assigned'
              ELSE 'changed'
            END AS action,
            v.amount::text AS amount,
            v.date_from,
            v.date_to,
            v.prev_amount::text AS prev_amount,
            v.prev_date_from,
            v.prev_date_to,
            v.comment,
            v.prev_comment,
            up.full_name AS changed_by_name,
            v.created_at AS changed_at
       FROM versions v
       LEFT JOIN user_profiles up ON up.id = v.created_by
      WHERE NOT v.is_copy
      ORDER BY v.id DESC`,
    [employeeId],
  );

/** Запись общей истории условий: изменение оклада / ставки или плановой доплаты. */
export type ITermsChange =
  | (ISalaryChange & { kind: 'salary' })
  | (IPlannedSupplementChange & { kind: 'supplement' });

const changedAtMs = (change: ITermsChange): number => new Date(change.changed_at).getTime();

/**
 * История условий для карточки: оклад / ставка и плановая доплата одним журналом,
 * по времени изменения (новые сверху). Период — внутри записи: у оклада и доплаты
 * свои даты действия, и сортировка по ним смешала бы две хронологии.
 */
export const getTermsChanges = async (employeeId: number): Promise<ITermsChange[]> => {
  const [salary, supplements] = await Promise.all([
    getSalaryChanges(employeeId),
    getPlannedSupplementChanges(employeeId),
  ]);
  const merged: ITermsChange[] = [
    ...salary.map(change => ({ ...change, kind: 'salary' as const })),
    ...supplements.map(change => ({ ...change, kind: 'supplement' as const })),
  ];
  return merged.sort((a, b) => changedAtMs(b) - changedAtMs(a));
};

/** Условия, действующие на дату. null — условий на эту дату нет. */
export const getTermsOnDate = async (
  employeeId: number,
  date: string,
  exec?: DbExecutor,
): Promise<IPayrollTerms | null> => {
  const sql = `SELECT ${TERMS_COLUMNS}
                 FROM payroll_compensation_terms
                WHERE employee_id = $1
                  AND effective_from <= $2::date
                  AND (effective_to IS NULL OR effective_to >= $2::date)
                LIMIT 1`;
  if (exec) {
    const res = await exec.query<IPayrollTerms>(sql, [employeeId, date]);
    return res.rows[0] ?? null;
  }
  return queryOne<IPayrollTerms>(sql, [employeeId, date]);
};

/**
 * Все условия, пересекающиеся с периодом, по возрастанию даты начала.
 * Именно отсюда расчёт получит сегменты: перевод «оклад → часы» 16-го числа
 * даёт две строки, и период режется по их границам.
 */
export const getTermsForPeriod = async (
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<Map<number, IPayrollTerms[]>> => {
  const result = new Map<number, IPayrollTerms[]>();
  if (employeeIds.length === 0) return result;

  const rows = await query<IPayrollTerms>(
    `SELECT ${TERMS_COLUMNS}
       FROM payroll_compensation_terms
      WHERE employee_id = ANY($1::int[])
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY employee_id, effective_from`,
    [employeeIds, startDate, endDate],
  );

  for (const row of rows) {
    const list = result.get(row.employee_id);
    if (list) list.push(row);
    else result.set(row.employee_id, [row]);
  }
  return result;
};

/** Сотрудники без условий оплаты на дату — их нельзя молча пропустить в расчёте. */
export const findEmployeesWithoutTerms = async (
  employeeIds: number[],
  date: string,
): Promise<number[]> => {
  if (employeeIds.length === 0) return [];
  const rows = await query<{ employee_id: number }>(
    `SELECT e.id AS employee_id
       FROM unnest($1::int[]) AS e(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM payroll_compensation_terms t
         WHERE t.employee_id = e.id
           AND t.effective_from <= $2::date
           AND (t.effective_to IS NULL OR t.effective_to >= $2::date))`,
    [employeeIds, date],
  );
  return rows.map(r => r.employee_id);
};

/**
 * Назначить условия одному сотруднику: закрыть действующие и открыть новые.
 *
 * Обе операции в одной транзакции — иначе при сбое между ними сотрудник остался бы
 * либо без условий, либо с двумя открытыми строками.
 */
export const assignTerms = async (
  input: IAssignTermsInput,
  exec?: DbExecutor,
): Promise<number> => {
  const run = async (client: DbExecutor): Promise<number> => {
    // Закрываем действующие на дату условия.
    await client.query(
      `UPDATE payroll_compensation_terms
          SET effective_to = ($2::date - INTERVAL '1 day')::date,
              updated_at = now()
        WHERE employee_id = $1
          AND effective_from < $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [input.employeeId, input.effectiveFrom],
    );
    // Условия, начинающиеся в эту дату или позже, заменяются: назначение задним
    // числом не должно оставлять «хвост» из более поздних строк.
    await client.query(
      `DELETE FROM payroll_compensation_terms
        WHERE employee_id = $1 AND effective_from >= $2::date`,
      [input.employeeId, input.effectiveFrom],
    );

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO payroll_compensation_terms
         (employee_id, organization_id, staff_category, calc_type,
          monthly_salary, hourly_rate, staff_units,
          effective_from, change_reason, order_number, order_date, note, created_by,
          bonus_amount, housing_compensation,
          travel_compensation, communication_compensation, deduction_amount, proration_rounding, contract_type)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 1.000), $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20)
       RETURNING id`,
      [
        input.employeeId,
        input.organizationId ?? null,
        input.staffCategory,
        input.calcType,
        input.calcType === 'salary' ? input.monthlySalary ?? null : null,
        input.calcType === 'hourly' ? input.hourlyRate ?? null : null,
        input.staffUnits ?? null,
        input.effectiveFrom,
        input.changeReason ?? null,
        input.orderNumber ?? null,
        input.orderDate ?? null,
        input.note ?? null,
        input.createdBy,
        input.bonusAmount ?? null,
        input.housingCompensation ?? null,
        input.travelCompensation ?? null,
        input.communicationCompensation ?? null,
        input.deductionAmount ?? null,
        input.prorationRounding ?? 'ruble',
        input.contractType ?? 'labor',
      ],
    );
    return inserted.rows[0].id;
  };

  return exec ? run(exec) : withTransaction(run);
};
