/**
 * Ввод и аудит проживания (миграции 314, 320) — общие для вкладки кадров «Проживание» и таблицы «Доплата за
 * проживание» «Зарплаты»: даты въезда и выезда, у общежития — адрес (обязателен), у квартиры — адрес по желанию
 * и сумма ₽/мес. Сумму квартиры задаёт только «Зарплата»: кадры её не присылают (см. dormitory-stays.controller.ts).
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

/** Дата YYYY-MM-DD из календаря — пауза и возобновление компенсации (миграция 374). */
export const stayDateSchema = dateSchema;

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

/** Адрес квартиры — по желанию (пусто — нет). */
const apartmentAddressSchema = z.string({ invalid_type_error: 'Неверный адрес' })
  .transform(squeeze)
  .pipe(z.string().max(200, ADDRESS_TOO_LONG))
  .nullable()
  .optional()
  .transform(value => value || null);

/** Квартира в «Зарплате»: сумма доплаты за проживание обязательна. */
const apartmentSchema = z.object({
  ...dates,
  amount: payrollPositiveMoneySchema('Укажите сумму доплаты'),
  address: apartmentAddressSchema,
}).refine(checkOutAfterCheckIn, DATES_ORDER)
  .transform((value): IDormitoryStayFields => ({ ...value, address: value.address ?? null }));

/** Квартира у кадров: сумму задаёт «Зарплата» — присланную (прежний клиент) не читаем, amount — null. */
const apartmentWithoutAmountSchema = z.object({
  ...dates,
  address: apartmentAddressSchema,
}).refine(checkOutAfterCheckIn, DATES_ORDER)
  .transform((value): IDormitoryStayFields => ({ ...value, address: value.address ?? null, amount: null }));

/**
 * Поля проживания этого вида из тела запроса; ошибка — ZodError (400). withAmount false — квартира без суммы
 * (вкладка кадров): сумму подставляет вызывающий.
 */
export const parseStayFields = (
  kind: DormitoryStayKind,
  body: unknown,
  { withAmount = true }: { withAmount?: boolean } = {},
): IDormitoryStayFields => {
  if (kind === 'dormitory') return dormitorySchema.parse(body);
  return withAmount ? apartmentSchema.parse(body) : apartmentWithoutAmountSchema.parse(body);
};

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
  apartment_id: stay.apartment_id ?? null,
  paid: stay.paid ?? false,
  comment: stay.comment ?? null,
  suspended: stay.suspended ?? false,
  resumed_from_id: stay.resumed_from_id ?? null,
});

/** Изменилось ли что-то в записи — без изменений аудита нет. */
export const dormitoryStayChanged = (before: IDormitoryStay, after: IDormitoryStay): boolean => (
  before.check_in !== after.check_in || before.check_out !== after.check_out
  || before.address !== after.address || before.amount !== after.amount
  || (before.apartment_id ?? null) !== (after.apartment_id ?? null)
  || (before.paid ?? false) !== (after.paid ?? false)
  || (before.comment ?? null) !== (after.comment ?? null)
  || (before.suspended ?? false) !== (after.suspended ?? false)
);

/**
 * Адрес «Кв. …» — служебная квартира (миграция 371): общежитием с таким адресом её не завести, только жильцом
 * квартиры во вкладке «Квартира» (в БД — CHECK employee_dormitory_stay_no_pseudo_apartment).
 */
export const isPseudoApartmentAddress = (address: string | null): boolean => /^\s*кв[.\s]/i.test(address ?? '');

export const PSEUDO_APARTMENT_ERROR = 'Служебную квартиру заселяют во вкладке «Квартира»: адрес «Кв. …» у общежития не указывают';

/** Заселение жильцом служебной квартиры: её id (адрес берётся из квартиры). */
export const stayApartmentIdSchema = z.object({
  apartment_id: z.number({ invalid_type_error: 'Неверная квартира' }).int('Неверная квартира').positive('Неверная квартира')
    .nullable().optional().transform(value => value ?? null),
});

const COMMENT_MAX = 500;

/** Комментарий: пробелы по краям убираются, пусто — нет комментария (NULL). */
const commentSchema = z.string({ invalid_type_error: 'Неверный комментарий' })
  .transform(value => value.trim())
  .pipe(z.string().max(COMMENT_MAX, `Комментарий — не больше ${COMMENT_MAX} символов`))
  .nullable()
  .transform(value => value || null);

/**
 * PATCH /stays/:id/meta — частичная правка: «Платно» и/или комментарий, остальные поля не трогаются. Ни одного
 * поля — 400.
 */
export const stayMetaSchema = z.object({
  paid: z.boolean({ invalid_type_error: 'Неверное значение «Платно»' }).optional(),
  comment: commentSchema.optional(),
}).strict('Можно изменить только «Платно» и комментарий')
  .refine(value => value.paid !== undefined || value.comment !== undefined, { message: 'Нечего сохранять' });

export type IStayMetaInput = z.infer<typeof stayMetaSchema>;

/**
 * POST /stays/:id/move — переселение: дата и ровно одно из двух — адрес общежития или служебная квартира; комментарий
 * новой записи — по желанию (не прислан или пусто — переносится прежний).
 */
export const stayMoveSchema = z.object({
  date: dateSchema('Укажите дату переселения'),
  comment: commentSchema.optional().transform(value => value ?? null),
  address: z.string({ invalid_type_error: 'Неверный адрес' })
    .transform(squeeze)
    .pipe(z.string().max(200, ADDRESS_TOO_LONG))
    .nullable().optional().transform(value => value || null),
  apartment_id: z.number({ invalid_type_error: 'Неверная квартира' }).int('Неверная квартира').positive('Неверная квартира')
    .nullable().optional().transform(value => value ?? null),
}).refine(value => (value.address === null) !== (value.apartment_id === null), {
  message: 'Выберите общежитие или квартиру — одно из двух',
});

export type IStayMoveInput = z.infer<typeof stayMoveSchema>;
