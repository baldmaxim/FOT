/**
 * Универсальные компактные форматтеры дат и часов для плотных списков
 * согласования. Раньше жили в `pages/approvals/approvalsShared.ts`; вынесены
 * сюда, чтобы одинаково выглядящие экраны (`/approvals` и `/leave-requests`)
 * не тянули импорты друг из друга.
 */

export const WEEKDAY_SHORT_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
export const MONTH_GENITIVE_SHORT_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** ISO-дата → «9 авг» + «вс» (для узкой колонки даты). */
export const formatDateCompact = (iso: string): { day: string; weekday: string } => {
  const d = new Date(iso + 'T00:00:00');
  return {
    day: `${d.getDate()} ${MONTH_GENITIVE_SHORT_RU[d.getMonth()]}`,
    weekday: WEEKDAY_SHORT_RU[d.getDay()].toLowerCase(),
  };
};

/** Метка времени → «9 авг, 14:05». */
export const formatDateTimeShort = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getDate();
  const m = MONTH_GENITIVE_SHORT_RU[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${m}, ${hh}:${mm}`;
};

/** Склонение слова «день» по числу: 1 день, 2 дня, 5 дней. */
export function pluralDays(n: number): string {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return 'день';
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return 'дня';
  return 'дней';
}

/** Десятичные часы → «9ч» / «8ч 30м»; null → «—». */
export const formatHM = (decimal: number | null): string => {
  if (decimal == null) return '—';
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};
