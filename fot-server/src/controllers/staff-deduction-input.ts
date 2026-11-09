/**
 * Ввод, ответы и аудит удержания (миграции 318, 321) — общие для вкладки кадров «Удержания» и таблицы
 * «Удержания» окна «Справочник» «Зарплаты»: вид, подвид (необязателен), месяц удержания, сумма.
 */
import { z } from 'zod';

import { getEmployeeState, type IDormitoryEmployeeState } from '../services/dormitory-stays.service.js';
import type { IStaffDeduction, StaffDeductionRefMissing } from '../services/staff-deductions.service.js';
import {
  payrollDictionaryNameSchema,
  payrollEmployeeIdSchema,
  payrollMonthSchema,
  payrollPositiveMoneySchema,
} from './payroll-dictionary.helpers.js';

/** Вид или подвид справочника: название и сумма по умолчанию (не задана или не прислана — null). */
export const deductionDictionaryEntrySchema = (emptyNameMessage: string) => z.object({
  name: payrollDictionaryNameSchema(emptyNameMessage),
  default_amount: payrollPositiveMoneySchema('Сумма должна быть числом')
    .nullable()
    .optional()
    .transform(value => value ?? null),
});

const KIND_MESSAGE = 'Выберите вид удержания';
const SUBKIND_MESSAGE = 'Неверный подвид удержания';

/** Поля удержания; подвид не прислан или null — без подвида. Ошибка — ZodError (400). */
export const staffDeductionFieldsSchema = z.object({
  kind_id: z.number({ required_error: KIND_MESSAGE, invalid_type_error: KIND_MESSAGE })
    .int(KIND_MESSAGE).positive(KIND_MESSAGE),
  subkind_id: z.number({ invalid_type_error: SUBKIND_MESSAGE })
    .int(SUBKIND_MESSAGE).positive(SUBKIND_MESSAGE)
    .nullable()
    .optional()
    .transform(value => value ?? null),
  month: payrollMonthSchema('Укажите месяц'),
  amount: payrollPositiveMoneySchema('Укажите сумму'),
});

export const staffDeductionAddSchema = staffDeductionFieldsSchema.extend({ employee_id: payrollEmployeeIdSchema });

/** Ответ 409 на вид или подвид, которого уже нет (или подвид не этого вида). */
export const STAFF_DEDUCTION_REF_MISSING: Record<StaffDeductionRefMissing, { success: false; error: string; code: string }> = {
  kind_missing: { success: false, error: 'Вид удержания не найден — обновите список видов', code: 'KIND_MISSING' },
  subkind_missing: { success: false, error: 'Подвид удержания не найден — обновите список видов', code: 'SUBKIND_MISSING' },
};

type StaffDeductionRefusal = { status: number; body: { success: false; error: string } };

const refuse = (status: number, error: string): StaffDeductionRefusal => ({ status, body: { success: false, error } });

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
] as const;

/** «2026-10-23» → «Уволен 23.10.2026 — удержание не позже октября 2026». */
const afterDismissalMessage = (dismissalDate: string): string => {
  const [year, month, day] = dismissalDate.split('-');
  return `Уволен ${day}.${month}.${year} — удержание не позже ${MONTHS_GENITIVE[Number(month) - 1]} ${year}`;
};

/** YYYY-MM со сдвигом на delta месяцев. */
const shiftYearMonth = (yearMonth: string, delta: number): string => {
  const [year, month] = yearMonth.split('-').map(Number);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

/** Месяцев назад в выборе месяца удержания: как в окне (oneTimeMonthOptions на фронте — следующий, текущий, 11 прошлых). */
const DEDUCTION_MONTHS_BACK = 11;

/**
 * С какой даты увольнения уволенный есть в поиске «Добавить сотрудника» (YYYY-MM-DD): 1-е число самого раннего
 * месяца в выборе месяца — уволенного раньше удержанием, которое можно выбрать, не добавить. todayIso — по МСК.
 */
export const dismissedSearchFrom = (todayIso: string): string => `${shiftYearMonth(todayIso.slice(0, 7), -DEDUCTION_MONTHS_BACK)}-01`;

/**
 * Месяц удержания сотрудника (решение пользователя 09.11.2026: удержания вносят в ФОТ, уволенным — тоже):
 * - работающему — любой месяц;
 * - уволенному — не позже месяца увольнения (иначе в «Расчётах» этого месяца удержания не видно); без даты
 *   увольнения — нельзя;
 * - правка, месяц не меняется (previousMonth = month) — можно всегда: прежние строки после увольнения
 *   (загрузки 1С) правятся по виду и сумме.
 * month, previousMonth — YYYY-MM. Можно — null, иначе — текст ошибки.
 */
export const staffDeductionMonthRefusal = (
  employee: Pick<IDormitoryEmployeeState, 'employment_status' | 'dismissal_date'>,
  month: string,
  previousMonth?: string,
): string | null => {
  if (previousMonth !== undefined && previousMonth === month) return null;
  if (employee.employment_status === 'active') return null;
  if (!employee.dismissal_date) return 'У уволенного нет даты увольнения — удержание не добавить';
  return month > employee.dismissal_date.slice(0, 7) ? afterDismissalMessage(employee.dismissal_date) : null;
};

/**
 * Кому можно добавить удержание за month (YYYY-MM): работающему или уволенному до месяца увольнения
 * (staffDeductionMonthRefusal), не из архива, не подрядчику (у уволенного — по отделу, из которого уволен). Поиск в
 * окне отдаёт только таких, но тело запроса могут собрать и руками. Можно — null, иначе — ответ.
 */
export const staffDeductionAddRefusal = async (
  employeeId: number,
  month: string,
): Promise<StaffDeductionRefusal | null> => {
  const employee = await getEmployeeState(employeeId);
  if (!employee) return refuse(404, 'Сотрудник не найден');
  if (employee.is_archived || (employee.employment_status !== 'active' && employee.employment_status !== 'fired')) {
    return refuse(400, 'Добавить можно только работающего или уволенного сотрудника');
  }
  if (employee.is_contractor) return refuse(400, 'Подрядчика добавить нельзя');
  const monthRefusal = staffDeductionMonthRefusal(employee, month);
  return monthRefusal ? refuse(400, monthRefusal) : null;
};

/**
 * Правка удержания: сменить месяц уволенному можно только на месяц не позже увольнения; месяц не меняется —
 * можно (staffDeductionMonthRefusal). Сотрудника нет — null (правку решает существование строки).
 */
export const staffDeductionUpdateRefusal = async (
  employeeId: number,
  month: string,
  previousMonth: string,
): Promise<StaffDeductionRefusal | null> => {
  if (month === previousMonth) return null;
  const employee = await getEmployeeState(employeeId);
  if (!employee) return null;
  const monthRefusal = staffDeductionMonthRefusal(employee, month, previousMonth);
  return monthRefusal ? refuse(400, monthRefusal) : null;
};

/** Удержание в аудите (добавлено, удалено, «было → стало»). */
export const staffDeductionAuditDetails = (deduction: IStaffDeduction) => ({
  employee_id: deduction.employee_id,
  full_name: deduction.full_name,
  kind_id: deduction.kind_id,
  kind_name: deduction.kind_name,
  subkind_id: deduction.subkind_id,
  subkind_name: deduction.subkind_name,
  month: deduction.month,
  amount: deduction.amount,
});

/** Изменилось ли что-то в удержании — без изменений аудита нет. */
export const staffDeductionChanged = (before: IStaffDeduction, after: IStaffDeduction): boolean => (
  before.kind_id !== after.kind_id || before.subkind_id !== after.subkind_id
  || before.month !== after.month || before.amount !== after.amount
);
