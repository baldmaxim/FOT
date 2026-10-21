/**
 * Ввод и аудит проживания (миграции 314, 320) — общие для вкладки кадров «Проживание» и таблицы «Доплата за
 * проживание» «Зарплаты»: даты въезда и выезда, у общежития — адрес (обязателен), у квартиры — сумма ₽/мес
 * и адрес по желанию.
 */
import { z } from 'zod';

import type { DormitoryStayKind, IDormitoryStay, IDormitoryStayFields } from '../services/dormitory-stays.service.js';
import { payrollPositiveMoneySchema } from './payroll-dictionary.helpers.js';

/** YYYY-MM-DD, и такая дата есть в календаре: 31.02 — 400, а не ошибка PostgreSQL (500). */
const isCalendarDate = (value: string): boolean => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2100
    && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const dateSchema = (message: string) => z.string({ required_error: message, invalid_type_error: message })
  .regex(/^\d{4}-\d{2}-\d{2}$/, message)
  .refine(isCalendarDate, message);

/** Пробелы внутри схлопываются, по краям — убираются. */
const squeeze = (value: string): string => value.replace(/\s+/g, ' ').trim();
const ADDRESS_TOO_LONG = 'Адрес — не больше 200 символов';

const dates = {
  check_in: dateSchema('Укажите дату въезда'),
  check_out: dateSchema('Неверная дата выезда').nullable().optional().transform(value => value ?? null),
};

/** Выезд строго позже въезда: в день выезда можно въехать снова (переселение). */
const checkOutAfterCheckIn = (value: { check_in: string; check_out: string | null }): boolean =>
  value.check_out === null || value.check_out > value.check_in;
const DATES_ORDER = { message: 'Дата выезда должна быть позже даты въезда', path: ['check_out'] };

/** Общежитие: адрес или номер обязателен, суммы нет (присланную не читаем). */
const dormitorySchema = z.object({
  ...dates,
  address: z.string({ required_error: 'Укажите адрес или номер общежития' })
    .transform(squeeze)
    .pipe(z.string().min(1, 'Укажите адрес или номер общежития').max(200, ADDRESS_TOO_LONG)),
}).refine(checkOutAfterCheckIn, DATES_ORDER)
  .transform((value): IDormitoryStayFields => ({ ...value, amount: null }));

/** Квартира: сумма доплаты за проживание обязательна, адрес — по желанию (пусто — нет). */
const apartmentSchema = z.object({
  ...dates,
  amount: payrollPositiveMoneySchema('Укажите сумму доплаты'),
  address: z.string({ invalid_type_error: 'Неверный адрес' })
    .transform(squeeze)
    .pipe(z.string().max(200, ADDRESS_TOO_LONG))
    .nullable()
    .optional()
    .transform(value => value || null),
}).refine(checkOutAfterCheckIn, DATES_ORDER)
  .transform((value): IDormitoryStayFields => ({ ...value, address: value.address ?? null }));

/** Поля проживания этого вида из тела запроса; ошибка — ZodError (400). */
export const parseStayFields = (kind: DormitoryStayKind, body: unknown): IDormitoryStayFields => (
  kind === 'apartment' ? apartmentSchema.parse(body) : dormitorySchema.parse(body)
);

/** Вид при добавлении во вкладке кадров; не прислан — общежитие (прежний клиент). */
export const stayKindSchema = z.object({
  kind: z.enum(['dormitory', 'apartment'], { invalid_type_error: 'Неверный вид проживания' }).default('dormitory'),
});

export const stayEmployeeIdSchema = z.object({
  employee_id: z.number({ required_error: 'Выберите сотрудника', invalid_type_error: 'Выберите сотрудника' })
    .int('Выберите сотрудника').positive('Выберите сотрудника'),
});

/** Запись проживания в аудите (добавлено, удалено, «было → стало»). */
export const dormitoryStayAuditDetails = (stay: IDormitoryStay) => ({
  employee_id: stay.employee_id,
  full_name: stay.full_name,
  kind: stay.kind,
  check_in: stay.check_in,
  check_out: stay.check_out,
  address: stay.address,
  amount: stay.amount,
});

/** Изменилось ли что-то в записи — без изменений аудита нет. */
export const dormitoryStayChanged = (before: IDormitoryStay, after: IDormitoryStay): boolean => (
  before.check_in !== after.check_in || before.check_out !== after.check_out
  || before.address !== after.address || before.amount !== after.amount
);
