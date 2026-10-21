/**
 * Ввод, ответы и аудит удержания (миграции 318, 321) — общие для вкладки кадров «Удержания» и таблицы
 * «Удержания» окна «Справочник» «Зарплаты»: вид, подвид (необязателен), месяц удержания, сумма.
 */
import { z } from 'zod';

import { getEmployeeState } from '../services/dormitory-stays.service.js';
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

/**
 * Кому можно добавить удержание: работающему, не из архива, не подрядчику. Поиск в окне отдаёт только таких,
 * но тело запроса могут собрать и руками. Можно — null, иначе — ответ. Правку и удаление прошлых строк
 * уволенного эта проверка не касается.
 */
export const staffDeductionAddRefusal = async (
  employeeId: number,
): Promise<{ status: number; body: { success: false; error: string } } | null> => {
  const employee = await getEmployeeState(employeeId);
  if (!employee) return { status: 404, body: { success: false, error: 'Сотрудник не найден' } };
  if (employee.employment_status !== 'active' || employee.is_archived) {
    return { status: 400, body: { success: false, error: 'Добавить можно только работающего сотрудника' } };
  }
  if (employee.is_contractor) return { status: 400, body: { success: false, error: 'Подрядчика добавить нельзя' } };
  return null;
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
