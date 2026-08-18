/**
 * Дата «сегодня» по Москве.
 *
 * Сервер живёт в Europe/Moscow (TZ задана в окружении), а `new Date().toISOString()`
 * на клиенте даёт UTC: с 00:00 до 03:00 МСК это ВЧЕРАШНЯЯ дата. На закреплениях такая
 * ошибка стоит суток ответственности за объект, поэтому дата считается явным поясом.
 */
const moscowFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD. */
export const moscowTodayIso = (): string => moscowFormatter.format(new Date());

/** YYYY-MM. */
export const moscowCurrentMonth = (): string => moscowTodayIso().slice(0, 7);

/** Сдвиг даты на N дней с сохранением формата YYYY-MM-DD. */
export const shiftDateIso = (dateIso: string, days: number): string => {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Сдвиг месяца YYYY-MM на N месяцев. */
export const shiftMonth = (month: string, delta: number): string => {
  const [year, value] = month.split('-').map(Number);
  const total = year * 12 + (value - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};
