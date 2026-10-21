/**
 * Окно «Добавить сотрудника» / ✎ во вкладке «Проживание» и в «Доплате за проживание» «Зарплаты»: разбор полей
 * повторяет проверку сервера (dormitory-stay-input.ts) — ошибка видна до запроса, а не ответом 400.
 */
import type { DormitoryStayKind, IDormitoryStayPayload } from '../services/dormitoryService';
import { parseRateAmount } from './payrollDictionary';

export interface IDormitoryStayDraft {
  /** YYYY-MM-DD или '' (поле не заполнено целиком). */
  checkIn: string;
  checkOut: string;
  address: string;
  /**
   * Только у квартиры в «Зарплате»: сумма ₽/мес как в поле («1 250,5»). Не передана — окно суммы не спрашивает
   * (вкладка кадров): квартира без суммы, её задаёт «Зарплата».
   */
  amount?: string;
}

export type DormitoryStayField = 'employee' | 'check_in' | 'check_out' | 'address' | 'amount';

export const DORMITORY_STAY_KIND_LABELS: Record<DormitoryStayKind, string> = {
  dormitory: 'Общежитие',
  apartment: 'Квартира',
};

export type DormitoryStayParse =
  | { ok: true; payload: IDormitoryStayPayload }
  | { ok: false; field: DormitoryStayField; message: string };

export const DORMITORY_ADDRESS_MAX_LENGTH = 200;

/** Общежития компании — в подсказках «Адрес / номер» всегда, даже без проживаний. */
export const DORMITORY_PRESET_ADDRESSES: readonly string[] = [
  'Общ. Мал.Почтовая 2\\2',
  'Общ. Нагатинская 34',
  'Общ. Верхнелихоборская 6',
  'Общ. Свободы 35',
  'Общ. Рязанский пр-кт 86/1с3',
  'Общ. Боровское ш. 12А',
  'Общ. База Мытищи',
  'Общ. База Химки',
  'Общ. г.Химки, ул.Рабочая д.2а',
];

/** Адрес так, как его сохранит сервер: пробелы схлопнуты, по краям обрезаны. */
const normalizeAddress = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Дата, которая есть в календаре: поле даты пропускает и «31.02.2026». */
export const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2100
    && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/**
 * Общежитие: адрес обязателен, суммы нет. Квартира: адрес — по желанию (пусто — null); сумма ₽/мес больше нуля
 * обязательна, если её спрашивают («Зарплата»), у кадров — null. Даты у обоих: въезд обязателен, выезд позже въезда
 * или пусто (живёт).
 */
export const parseDormitoryStay = (
  draft: IDormitoryStayDraft,
  employee: { required: boolean; selected: boolean },
  kind: DormitoryStayKind = 'dormitory',
): DormitoryStayParse => {
  if (employee.required && !employee.selected) return { ok: false, field: 'employee', message: 'Выберите сотрудника' };
  if (!draft.checkIn) return { ok: false, field: 'check_in', message: 'Укажите дату въезда' };
  if (!isCalendarDate(draft.checkIn)) return { ok: false, field: 'check_in', message: 'Такой даты нет' };
  if (draft.checkOut && !isCalendarDate(draft.checkOut)) return { ok: false, field: 'check_out', message: 'Такой даты нет' };
  if (draft.checkOut && draft.checkOut <= draft.checkIn) {
    return { ok: false, field: 'check_out', message: 'Дата выезда должна быть позже даты въезда' };
  }
  const address = normalizeAddress(draft.address);
  if (address.length > DORMITORY_ADDRESS_MAX_LENGTH) {
    return { ok: false, field: 'address', message: 'Адрес — не больше 200 символов' };
  }
  const dates = { check_in: draft.checkIn, check_out: draft.checkOut || null };
  if (kind === 'dormitory') {
    if (!address) return { ok: false, field: 'address', message: 'Укажите адрес или номер общежития' };
    return { ok: true, payload: { ...dates, address, amount: null } };
  }
  if (draft.amount === undefined) return { ok: true, payload: { ...dates, address: address || null, amount: null } };
  const parsed = parseRateAmount(draft.amount);
  if (parsed.error !== null) {
    return { ok: false, field: 'amount', message: 'Сумма — число больше нуля, до двух знаков после запятой' };
  }
  if (parsed.amount === null) return { ok: false, field: 'amount', message: 'Укажите сумму доплаты' };
  if (parsed.amount <= 0) return { ok: false, field: 'amount', message: 'Сумма должна быть больше нуля' };
  return { ok: true, payload: { ...dates, address: address || null, amount: parsed.amount } };
};

/**
 * Подсказки поля «Адрес / номер»: общежития компании и сохранённые адреса (миграция 319) без повторов (регистр и пробелы не в счёт,
 * из написаний — самое частое), по алфавиту, числа — по значению: «Общ2» раньше «Общ10».
 */
export const dormitoryAddressOptions = (addresses: readonly string[]): string[] => {
  const spellingsByKey = new Map<string, Map<string, number>>();
  for (const raw of addresses) {
    const address = normalizeAddress(raw);
    if (!address) continue;
    const key = address.toLocaleLowerCase('ru');
    const spellings = spellingsByKey.get(key) ?? new Map<string, number>();
    spellings.set(address, (spellings.get(address) ?? 0) + 1);
    spellingsByKey.set(key, spellings);
  }
  return [...spellingsByKey.values()]
    .map(spellings => [...spellings].reduce((best, next) => (next[1] > best[1] ? next : best))[0])
    .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' }));
};

/** Подсказки под введённым: пусто — все, иначе содержащие его; ровно введённый адрес не показываем. */
export const filterDormitoryAddresses = (options: readonly string[], typed: string): string[] => {
  const needle = normalizeAddress(typed).toLocaleLowerCase('ru');
  if (!needle) return [...options];
  return options.filter(option => {
    const value = option.toLocaleLowerCase('ru');
    return value !== needle && value.includes(needle);
  });
};
