/**
 * Ввод, ответы и аудит удержания (миграции 318, 321, 383) — общие для вкладки кадров «Удержания» и таблицы
 * «Удержания» окна «Справочник» «Зарплаты»: вид, подвид (необязателен), месяц удержания, сумма; место и дата
 * нарушения — у вида с признаком (staff-deduction-violation.ts).
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { getEmployeeState, type IDormitoryEmployeeState } from '../services/dormitory-stays.service.js';
import { getPaidAmounts } from '../services/payroll/payroll-paid.service.js';
import { needsSummaryCalc } from '../services/payroll/payroll-summary-calc.rules.js';
import {
  listViolationObjects,
  type IStaffDeduction,
  type StaffDeductionWriteRefusal,
} from '../services/staff-deductions.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
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
const OBJECT_MESSAGE = 'Выберите место нарушения';
const DATE_MESSAGE = 'Укажите дату нарушения';
const FUTURE_DATE_MESSAGE = 'Дата нарушения не может быть позже сегодняшней';
export const VIOLATION_PLACE_MAX = 200;

/** YYYY-MM-DD настоящей даты календаря (не 2026-02-30). */
const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Не прислано, null или пусто — null (старый клиент полей нарушения не шлёт). */
const optionalNullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional()
  .transform(value => (value ?? null) as z.output<T> | null);

/**
 * Дата нарушения: YYYY-MM-DD, не позже сегодня по МСК. «Сегодня» — на каждый разбор: прод живёт в UTC, а процесс —
 * неделями.
 */
const violationDateSchema = z.string({ invalid_type_error: DATE_MESSAGE })
  .refine(isCalendarDate, DATE_MESSAGE)
  .refine(value => value <= moscowTodayIso(), FUTURE_DATE_MESSAGE);

const violationPlaceSchema = z.string({ invalid_type_error: 'Уточнение места — текстом' })
  .transform(value => value.replace(/\s+/g, ' ').trim())
  .refine(value => value.length <= VIOLATION_PLACE_MAX, `Уточнение места — не длиннее ${VIOLATION_PLACE_MAX} символов`)
  .transform(value => value || null);

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
  violation_object_id: optionalNullable(z.string({ invalid_type_error: OBJECT_MESSAGE }).uuid(OBJECT_MESSAGE)),
  violation_place: optionalNullable(violationPlaceSchema),
  violation_date: optionalNullable(violationDateSchema),
});

export const staffDeductionAddSchema = staffDeductionFieldsSchema.extend({ employee_id: payrollEmployeeIdSchema });

type StaffDeductionWriteAnswer = { status: number; body: { success: false; error: string; code: string } };

/**
 * Ответ на отказ записи: 409 — вида, подвида (или подвид не этого вида) или объекта уже нет; 400 — у вида с признаком
 * не указаны место и дата нарушения.
 */
export const STAFF_DEDUCTION_WRITE_REFUSALS: Record<StaffDeductionWriteRefusal, StaffDeductionWriteAnswer> = {
  kind_missing: {
    status: 409,
    body: { success: false, error: 'Вид удержания не найден — обновите список видов', code: 'KIND_MISSING' },
  },
  subkind_missing: {
    status: 409,
    body: { success: false, error: 'Подвид удержания не найден — обновите список видов', code: 'SUBKIND_MISSING' },
  },
  object_missing: {
    status: 409,
    body: { success: false, error: 'Объект не найден — обновите список объектов', code: 'OBJECT_MISSING' },
  },
  place_required: {
    status: 400,
    body: { success: false, error: 'Укажите место и дату нарушения', code: 'PLACE_REQUIRED' },
  },
};

/** Ответ 409 плановому (миграция 357) на вид или подвид, которого уже нет (или подвид не этого вида). */
export const STAFF_DEDUCTION_REF_MISSING: Record<'kind_missing' | 'subkind_missing', StaffDeductionWriteAnswer['body']> = {
  kind_missing: STAFF_DEDUCTION_WRITE_REFUSALS.kind_missing.body,
  subkind_missing: STAFF_DEDUCTION_WRITE_REFUSALS.subkind_missing.body,
};

export const sendStaffDeductionWriteRefusal = (res: Response, refusal: StaffDeductionWriteRefusal): void => {
  const answer = STAFF_DEDUCTION_WRITE_REFUSALS[refusal];
  res.status(answer.status).json(answer.body);
};

type StaffDeductionRefusal = { status: number; body: { success: false; error: string } };

const refuse = (status: number, error: string): StaffDeductionRefusal => ({ status, body: { success: false, error } });

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
] as const;

const MONTHS_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
] as const;

/** «2026-10-23» → «Уволен 23.10.2026 — удержание не позже октября 2026». */
const afterDismissalMessage = (dismissalDate: string): string => {
  const [year, month, day] = dismissalDate.split('-');
  return `Уволен ${day}.${month}.${year} — удержание не позже ${MONTHS_GENITIVE[Number(month) - 1]} ${year}`;
};

/** «2026-11-05» → «Принят 05.11.2026 — удержание не раньше ноября 2026». */
const beforeHireMessage = (hireDate: string): string => {
  const [year, month, day] = hireDate.split('-');
  return `Принят ${day}.${month}.${year} — удержание не раньше ${MONTHS_GENITIVE[Number(month) - 1]} ${year}`;
};

/** «2026-09» → «Зарплата за сентябрь 2026 уже загружена из 1С — укажите текущий или следующий месяц». */
const loadedFrom1cMessage = (yearMonth: string): string => {
  const [year, month] = yearMonth.split('-');
  return `Зарплата за ${MONTHS_NOMINATIVE[Number(month) - 1]} ${year} уже загружена из 1С — укажите текущий или следующий месяц`;
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
 * - не раньше месяца приёма (решение пользователя 27.11.2026): за месяц до приёма человека нет в «Расчётах» и
 *   «Своде», и сумма нигде бы не учлась; даты приёма нет — без ограничения;
 * - работающему — любой месяц с месяца приёма;
 * - уволенному — не позже месяца увольнения (иначе в «Расчётах» этого месяца удержания не видно); без даты
 *   увольнения — нельзя;
 * - правка, месяц не меняется (previousMonth = month) — можно всегда: прежние строки после увольнения
 *   (загрузки 1С) правятся по виду и сумме.
 * month, previousMonth — YYYY-MM. Можно — null, иначе — текст ошибки.
 */
export const staffDeductionMonthRefusal = (
  employee: Pick<IDormitoryEmployeeState, 'employment_status' | 'dismissal_date'> & { hire_date?: string | null },
  month: string,
  previousMonth?: string,
): string | null => {
  if (previousMonth !== undefined && previousMonth === month) return null;
  if (employee.hire_date && month < employee.hire_date.slice(0, 7)) return beforeHireMessage(employee.hire_date);
  if (employee.employment_status === 'active') return null;
  if (!employee.dismissal_date) return 'У уволенного нет даты увольнения — удержание не добавить';
  return month > employee.dismissal_date.slice(0, 7) ? afterDismissalMessage(employee.dismissal_date) : null;
};

/**
 * Загружена ли зарплата сотрудника за month (YYYY-MM) из 1С: есть «Зарплата» или ГПХ 1С — то же правило, по которому
 * «Свод» берёт месяц целиком из 1С (needsSummaryCalc). Удержание в таком месяце не попало бы ни в «Свод», ни в
 * выплату — месяц уже выплачен (решение пользователя 27.11.2026: такой месяц не принимать).
 */
export const isPayrollMonthLoadedFrom1c = async (employeeId: number, month: string): Promise<boolean> => {
  const paid = await getPaidAmounts(employeeId, month, month);
  return !needsSummaryCalc(new Map(paid.map(row => [row.item, row.amount])));
};

/**
 * Кому можно добавить удержание за month (YYYY-MM): работающему или уволенному до месяца увольнения, не раньше
 * месяца приёма (staffDeductionMonthRefusal), не из архива, не подрядчику (у уволенного — по отделу, из которого
 * уволен), и не в месяц, зарплата за который уже загружена из 1С. Поиск в окне отдаёт только таких, но тело запроса
 * могут собрать и руками. Можно — null, иначе — ответ.
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
  if (monthRefusal) return refuse(400, monthRefusal);
  return await isPayrollMonthLoadedFrom1c(employeeId, month) ? refuse(400, loadedFrom1cMessage(month)) : null;
};

/**
 * Правка удержания: месяц не меняется — можно (прежние строки месяцев из 1С правятся как раньше); сменить месяц —
 * только на месяц не раньше приёма, уволенному — не позже увольнения (staffDeductionMonthRefusal) и не на месяц,
 * зарплата за который уже загружена из 1С. Сотрудника нет — null (правку решает существование строки).
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
  if (monthRefusal) return refuse(400, monthRefusal);
  return await isPayrollMonthLoadedFrom1c(employeeId, month) ? refuse(400, loadedFrom1cMessage(month)) : null;
};

/**
 * GET …/objects — объекты для «Места» нарушения (миграция 383): общий обработчик вкладки кадров и «Справочника»
 * «Зарплаты»; право — просмотр раздела (галочке «Удержания» список тоже нужен).
 */
export const listViolationObjectsHandler = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listViolationObjects() });
  } catch (err) {
    console.error('staffDeductions.violationObjects error:', err);
    res.status(500).json({ success: false, error: 'Не удалось загрузить объекты' });
  }
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
  violation_object_id: deduction.violation_object_id,
  violation_object_name: deduction.violation_object_name,
  violation_place: deduction.violation_place,
  violation_date: deduction.violation_date,
});

/** Изменилось ли что-то в удержании — без изменений аудита нет. */
export const staffDeductionChanged = (before: IStaffDeduction, after: IStaffDeduction): boolean => (
  before.kind_id !== after.kind_id || before.subkind_id !== after.subkind_id
  || before.month !== after.month || before.amount !== after.amount
  || before.violation_object_id !== after.violation_object_id || before.violation_place !== after.violation_place
  || before.violation_date !== after.violation_date
);
