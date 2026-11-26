import { formatDate } from './formatMoney';

/** По это число месяца включительно прошлый месяц ещё открыт (как сервер, dormitory-compensation-dates.ts). */
export const CLOSED_MONTH_GRACE_DAY = 10;

/**
 * «Компенсация аренды» (миграция 380): начало открытого периода на сегодня (YYYY-MM-DD по Москве) — 1-е число
 * текущего месяца, а по 10-е включительно — прошлого. Даты паузы и возобновления раньше него сервер не примет: дни
 * закрытых месяцев не меняются.
 */
export const compensationOpenFrom = (today: string): string => {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  if (Number(today.slice(8, 10)) > CLOSED_MONTH_GRACE_DAY) return `${today.slice(0, 7)}-01`;
  return month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`;
};

/** Текст ошибки даты раньше открытого периода — те же слова, что у сервера. */
export const closedMonthsDateError = (what: 'приостановки' | 'возобновления', openFrom: string): string => (
  `Месяцы до ${formatDate(openFrom)} закрыты — компенсация за них уже рассчитана: дата ${what} — не раньше ${formatDate(openFrom)}`
);
