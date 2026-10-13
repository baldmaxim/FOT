/**
 * Окно «Справочник» на «Расчётах»: виды удержаний и ставки. Разбор полей повторяет проверку сервера —
 * ошибка видна до запроса, а не ответом 400.
 */
import { toInputValue } from './payrollTermsForm';

/** Запись справочника при добавлении и правке. У видов удержаний значения нет — amount не читается. */
export interface IPayrollDictionaryPayload {
  name: string;
  amount: number | null;
}

/** Верхняя граница значения ставки — NUMERIC(12,2). */
export const MAX_RATE_AMOUNT = 9_999_999_999.99;

/** Пробелы схлопываются, как на сервере: «Штраф  за мусор» и «Штраф за мусор» — одно название. */
export const normalizeDictionaryName = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

export type RateAmountParse = { amount: number | null; error: null } | { amount: null; error: string };

/**
 * Значение ставки из поля. Пусто — «не задано» (null, а не 0). Допустимы запятая и пробелы между
 * разрядами («1 250,5»). Третий знак после запятой сервер округлил бы молча — не принимаем.
 */
export const parseRateAmount = (raw: string): RateAmountParse => {
  const compact = raw.replace(/\s/g, '').replace(',', '.');
  if (!compact) return { amount: null, error: null };
  if (!/^\d+(\.\d{1,2})?$/.test(compact)) {
    return { amount: null, error: 'Значение — число не меньше нуля, до двух знаков после запятой' };
  }
  const amount = Number(compact);
  if (amount > MAX_RATE_AMOUNT) return { amount: null, error: 'Слишком большое значение' };
  return { amount, error: null };
};

/** Значение в поле правки: «450.50» → «450,5», «520.00» → «520»; не задано — ''. */
export const rateAmountInputValue = (amount: string | number | null | undefined): string =>
  toInputValue(amount).replace('.', ',');
