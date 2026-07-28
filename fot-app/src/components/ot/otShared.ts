/** Общие хелперы обучения по ОТ: реестр подрядчиков и панель своих сотрудников. */

/** YYYY-MM-DD → DD.MM.YYYY строкой, без Date (иначе сдвиг дня по таймзоне). */
export const fmtDate = (ymd: string | null | undefined): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
};

/** Сегодня в локальной TZ как YYYY-MM-DD (sv-SE даёт ISO-формат), без UTC-сдвига. */
export const todayLocal = (): string => new Date().toLocaleDateString('sv-SE');

/** Полная и календарно существующая дата (31.02 не пройдёт). */
export const isValidIsoDate = (value: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
};
