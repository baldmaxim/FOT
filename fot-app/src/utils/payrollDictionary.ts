/**
 * Окно «Справочник» на «Расчётах»: виды удержаний и ставки. Разбор полей повторяет проверку сервера —
 * ошибка видна до запроса, а не ответом 400.
 */
import { toInputValue } from './payrollTermsForm';

export { MAX_RATE_AMOUNT, parseRateAmount, type RateAmountParse } from './payrollFormat';

/**
 * Запись справочника при добавлении и правке. У видов удержаний значения нет — amount не читается.
 * effective_month — с какого месяца значение ставки (миграция 324); не передан — с текущего.
 */
export interface IPayrollDictionaryPayload {
  name: string;
  amount: number | null;
  effective_month?: string;
}

/** Пробелы схлопываются, как на сервере: «Штраф  за мусор» и «Штраф за мусор» — одно название. */
export const normalizeDictionaryName = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

/** Значение в поле правки: «450.50» → «450,5», «520.00» → «520»; не задано — ''. */
export const rateAmountInputValue = (amount: string | number | null | undefined): string =>
  toInputValue(amount).replace('.', ',');
