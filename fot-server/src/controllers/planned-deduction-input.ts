/**
 * Ввод, ответы и аудит планового удержания (миграция 357) — общие для кадров («Удержания») и «Зарплаты»
 * («Справочник» → «Удержания»): вид, подвид, сумма ₽/мес, «с месяца», «по месяц» (пусто — бессрочно), сумма в
 * последнем месяце (миграция 362; пусто — как в остальных).
 */
import { z } from 'zod';

import type { IPlannedDeduction } from '../services/payroll/payroll-planned-deductions.service.js';
import {
  parsePayrollMonthsQuery,
  payrollEmployeeIdSchema,
  payrollMonthSchema,
  payrollMonthStarts,
  payrollPositiveMoneySchema,
} from './payroll-dictionary.helpers.js';

const KIND_MESSAGE = 'Выберите вид удержания';
const SUBKIND_MESSAGE = 'Неверный подвид удержания';
const STALE_MESSAGE = 'Удержание уже изменили — обновите таблицу';

const plannedDeductionObject = z.object({
  kind_id: z.number({ required_error: KIND_MESSAGE, invalid_type_error: KIND_MESSAGE })
    .int(KIND_MESSAGE).positive(KIND_MESSAGE),
  subkind_id: z.number({ invalid_type_error: SUBKIND_MESSAGE })
    .int(SUBKIND_MESSAGE).positive(SUBKIND_MESSAGE)
    .nullable()
    .optional()
    .transform(value => value ?? null),
  amount: payrollPositiveMoneySchema('Укажите сумму'),
  month_from: payrollMonthSchema('Укажите месяц начала'),
  month_to: payrollMonthSchema('Месяц окончания — в формате ГГГГ-ММ')
    .nullable()
    .optional()
    .transform(value => value ?? null),
  last_month_amount: payrollPositiveMoneySchema('Укажите сумму в последнем месяце')
    .nullable()
    .optional()
    .transform(value => value ?? null),
});

interface IPlannedDeductionPeriod {
  amount: number;
  month_from: string;
  month_to: string | null;
  last_month_amount: number | null;
}

/** «По» не раньше «С» (YYYY-MM сравниваются строкой). */
const periodOrdered = (value: IPlannedDeductionPeriod): boolean => (
  value.month_to === null || value.month_to >= value.month_from
);
const PERIOD_MESSAGE = { message: '«По месяц» не может быть раньше «С месяца»', path: ['month_to'] };

/** Сумма последнего месяца — только у периода с концом длиннее месяца (CHECK миграции 362). */
const lastMonthHasPeriod = (value: IPlannedDeductionPeriod): boolean => (
  value.last_month_amount === null || (value.month_to !== null && value.month_to > value.month_from)
);
const LAST_MONTH_PERIOD_MESSAGE = {
  message: 'Другая сумма в последнем месяце — только если «По месяц» позже «С месяца»',
  path: ['last_month_amount'],
};

/** Сумма последнего месяца отличается от ежемесячной (в копейках; ввод — не больше двух знаков). */
const lastMonthDiffers = (value: IPlannedDeductionPeriod): boolean => (
  value.last_month_amount === null || Math.round(value.last_month_amount * 100) !== Math.round(value.amount * 100)
);
const LAST_MONTH_SAME_MESSAGE = {
  message: 'Сумма в последнем месяце равна сумме в месяц — снимите галочку',
  path: ['last_month_amount'],
};

/** Метка версии строки из таблицы: правка и «Убрать» без неё не принимаются (защита от повтора и гонки). */
const expectedUpdatedAtSchema = z.string({ required_error: STALE_MESSAGE, invalid_type_error: STALE_MESSAGE })
  .datetime({ message: STALE_MESSAGE });

export const plannedDeductionAddSchema = plannedDeductionObject
  .extend({ employee_id: payrollEmployeeIdSchema })
  .refine(periodOrdered, PERIOD_MESSAGE)
  .refine(lastMonthHasPeriod, LAST_MONTH_PERIOD_MESSAGE)
  .refine(lastMonthDiffers, LAST_MONTH_SAME_MESSAGE);

export const plannedDeductionUpdateSchema = plannedDeductionObject
  .extend({ expected_updated_at: expectedUpdatedAtSchema })
  .refine(periodOrdered, PERIOD_MESSAGE)
  .refine(lastMonthHasPeriod, LAST_MONTH_PERIOD_MESSAGE)
  .refine(lastMonthDiffers, LAST_MONTH_SAME_MESSAGE);

export const plannedDeductionRemoveSchema = z.object({ expected_updated_at: expectedUpdatedAtSchema });

/**
 * ?months= списка периодов: без параметра — текущий месяц (currentMonth), 'all' — все периоды (null), иначе — эти
 * месяцы. Первые числа месяцев для SQL.
 */
export const plannedListMonthStarts = (raw: unknown, currentMonth: string): string[] | null => {
  const selection = parsePayrollMonthsQuery(raw);
  if (selection === null) return payrollMonthStarts([currentMonth]);
  return selection === 'all' ? null : payrollMonthStarts(selection);
};

/**
 * ?months= развёртки по месяцам: без параметра — текущий месяц; 'all' — ZodError (400): бессрочное «на все месяцы»
 * не развернуть.
 */
export const plannedByMonthStarts = (raw: unknown, currentMonth: string): string[] => {
  const selection = parsePayrollMonthsQuery(raw);
  if (selection === 'all') {
    throw new z.ZodError([{ code: 'custom', path: ['months'], message: 'Выберите месяцы — «весь период» здесь нельзя' }]);
  }
  return payrollMonthStarts(selection ?? [currentMonth]);
};

const MONTH_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
] as const;

/** «2026-11» → «ноябрь 2026». */
const monthLabel = (month: string): string => {
  const [year, value] = month.split('-');
  return `${MONTH_NAMES[Number(value) - 1]} ${year}`;
};

/** «ноябрь 2026 – январь 2027» / «с ноября 2026, бессрочно» (для текста ответа). */
const periodLabel = (row: Pick<IPlannedDeduction, 'month_from' | 'month_to'>): string => (
  row.month_to === null
    ? `${monthLabel(row.month_from)} — бессрочно`
    : `${monthLabel(row.month_from)} – ${monthLabel(row.month_to)}`
);

const kindLabel = (row: Pick<IPlannedDeduction, 'kind_name' | 'subkind_name'>): string => (
  row.subkind_name ? `${row.kind_name} — ${row.subkind_name}` : row.kind_name
);

/** 409: пересечение с периодом того же вида и подвида. */
export const plannedDeductionExistsBody = (existing: IPlannedDeduction) => ({
  success: false as const,
  error: `У сотрудника уже есть плановое удержание «${kindLabel(existing)}» на ${periodLabel(existing)}`,
  code: 'PLANNED_DEDUCTION_EXISTS',
});

/** 409: строку уже изменили (или это повтор того же запроса). */
export const PLANNED_DEDUCTION_STALE = { success: false as const, error: STALE_MESSAGE, code: 'PLANNED_DEDUCTION_STALE' };

export const PLANNED_DEDUCTION_NOT_FOUND = { success: false as const, error: 'Плановое удержание не найдено' };

/** Плановое удержание в аудите. */
export const plannedDeductionAuditDetails = (row: IPlannedDeduction) => ({
  employee_id: row.employee_id,
  full_name: row.full_name,
  kind_id: row.kind_id,
  kind_name: row.kind_name,
  subkind_id: row.subkind_id,
  subkind_name: row.subkind_name,
  amount: row.amount,
  month_from: row.month_from,
  month_to: row.month_to,
  last_month_amount: row.last_month_amount,
});
