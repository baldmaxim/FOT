/**
 * Общее для справочников «Зарплаты» (виды удержаний, ставки) и таблиц окна «Справочник»
 * («Доплата за проживание», «Доплата», «Без проезда», «Удержания»): схемы названия, дат, месяцев и сумм,
 * id из пути, ответ на ошибку проверки.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import type { PayrollTermsPeriod } from '../services/payroll/payroll-terms-amount.service.js';

/** Пробелы внутри схлопываются: «Штраф  за мусор» и «Штраф за мусор» — одно название. */
export const payrollDictionaryNameSchema = (emptyMessage: string) => z.string()
  .transform(value => value.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, emptyMessage).max(100, 'Не больше 100 символов'));

/** :id записи справочника; не целое положительное — null (записи с таким id быть не может). */
export const parsePayrollDictionaryId = (req: AuthenticatedRequest): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export const handlePayrollZodError = (error: unknown, res: Response): boolean => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
};

/** Верх NUMERIC(12,2): больше — переполнение в БД и 500 вместо понятной ошибки. */
export const PAYROLL_MAX_MONEY = 9_999_999_999.99;
/** Верх NUMERIC(12,4) — часовая ставка. */
export const PAYROLL_MAX_HOURLY_RATE = 99_999_999.9999;

export const MONEY_DECIMALS_MESSAGE = 'Не больше двух знаков после запятой';
export const HOURLY_RATE_DECIMALS_MESSAGE = 'Не больше четырёх знаков после запятой';

/**
 * Не больше digits знаков после запятой: лишний знак NUMERIC округлил бы молча (100.005 → 100.01).
 * Проверяется запись числа (String — кратчайшая, дающая то же число), а не value * 100:
 * во float 0.29 * 100 = 28.999999999999996. Экспоненту (1e-7) запись не пропускает.
 */
export const hasMaxDecimals = (value: number, digits: number): boolean => (
  new RegExp(`^-?\\d+(\\.\\d{1,${digits}})?$`).test(String(value))
);

/** YYYY-MM-DD, и такая дата есть в календаре: 31.02 — 400, а не ошибка PostgreSQL (500). */
const isCalendarDate = (value: string): boolean => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2100
    && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export const payrollDateSchema = (message: string) => z.string({ required_error: message, invalid_type_error: message })
  .regex(/^\d{4}-\d{2}-\d{2}$/, message)
  .refine(isCalendarDate, message);

/** Месяц YYYY-MM (1900–2100). */
export const payrollMonthSchema = (message: string) => z.string({ required_error: message, invalid_type_error: message })
  .regex(/^(19\d{2}|20\d{2}|2100)-(0[1-9]|1[0-2])$/, message);

/** Больше месяцев в ?months= не принимаем: выбор пикера — до трёх лет. */
export const PAYROLL_REGISTRY_MAX_MONTHS = 36;

/**
 * ?months= таблиц «Справочника» и «Свода»: параметра нет — null (прежнее «на сегодня» у старого клиента),
 * 'all' — весь период, иначе — список YYYY-MM через запятую (без повторов, по возрастанию).
 */
export type PayrollMonthsSelection = null | 'all' | string[];

const monthsListSchema = z.string()
  .transform(value => value.split(',').map(month => month.trim()).filter(Boolean))
  .pipe(z.array(payrollMonthSchema('Месяц — в формате ГГГГ-ММ'))
    .min(1, 'Выберите месяц')
    .max(PAYROLL_REGISTRY_MAX_MONTHS, 'Слишком много месяцев'));

/** Разбор ?months=; неверное значение — ZodError (400 через handlePayrollZodError). */
export const parsePayrollMonthsQuery = (raw: unknown): PayrollMonthsSelection => {
  if (raw === undefined) return null;
  if (raw === 'all') return 'all';
  return [...new Set(monthsListSchema.parse(raw))].sort();
};

/** Первые числа месяцев для SQL (date[]): '2026-10' → '2026-10-01'. */
export const payrollMonthStarts = (months: readonly string[]): string[] => months.map(month => `${month}-01`);

/** Период версий условий для таблиц «Справочника»: без ?months= — на дату today, иначе — месяцы. */
export const payrollRegistryTermsPeriod = (raw: unknown, today: string): PayrollTermsPeriod => {
  const selection = parsePayrollMonthsQuery(raw);
  if (selection === null) return { onDate: today };
  return { monthStarts: selection === 'all' ? null : payrollMonthStarts(selection) };
};

/** Сумма больше нуля, до копеек, без coerce: '' и false не должны превращаться в число. */
export const payrollPositiveMoneySchema = (message: string) => z.number({ required_error: message, invalid_type_error: message })
  .finite(message)
  .positive('Сумма должна быть больше нуля')
  .max(PAYROLL_MAX_MONEY, 'Слишком большая сумма')
  .refine(value => hasMaxDecimals(value, 2), MONEY_DECIMALS_MESSAGE);

export const payrollEmployeeIdSchema = z.number({ required_error: 'Выберите сотрудника', invalid_type_error: 'Выберите сотрудника' })
  .int('Выберите сотрудника').positive('Выберите сотрудника');

/** :empId в пути; не целое положительное — null. */
export const parsePayrollEmployeeIdParam = (req: AuthenticatedRequest): number | null => {
  const employeeId = Number(req.params.empId);
  return Number.isInteger(employeeId) && employeeId > 0 ? employeeId : null;
};

/** Строка таблицы «Справочника» с признаком правки (скоуп считается один раз на запрос). */
export const withCanEdit = <Row extends { employee_id: number }>(
  rows: Row[],
  canEdit: (employeeId: number) => boolean,
): Array<Row & { can_edit: boolean }> => rows.map(row => ({ ...row, can_edit: canEdit(row.employee_id) }));
