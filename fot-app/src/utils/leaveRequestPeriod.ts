/**
 * Пресеты периода для фильтров вкладок «Заявления» и «Отпуска».
 * Границы календарные и целиком — включая будущие дни текущего месяца
 * (отпуска часто оформляют вперёд), в отличие от presetRange в feedback/deptStats.
 */
export type LeavePeriodKey = 'all' | 'week' | 'month' | 'prevmonth' | 'quarter';

export const LEAVE_PERIOD_OPTIONS: Array<{ key: LeavePeriodKey; label: string }> = [
  { key: 'all', label: 'Все периоды' },
  { key: 'week', label: 'Текущая неделя' },
  { key: 'month', label: 'Текущий месяц' },
  { key: 'prevmonth', label: 'Прошлый месяц' },
  { key: 'quarter', label: 'Последние 3 месяца' },
];

/** Сегодня в Europe/Moscow (как на бэкенде), формат YYYY-MM-DD. */
export const leaveTodayIso = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

const pad2 = (n: number): string => String(n).padStart(2, '0');

const fmtIso = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const parseIso = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Границы периода (ISO включительно) или null для «Все периоды». */
export const leavePeriodRange = (
  key: LeavePeriodKey,
  today: string,
): { from: string; to: string } | null => {
  if (key === 'all') return null;
  const t = parseIso(today);

  if (key === 'week') {
    // Неделя Пн–Вс: getDay() 0 = воскресенье.
    const day = t.getDay();
    const mon = new Date(t);
    mon.setDate(t.getDate() + (day === 0 ? -6 : 1 - day));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { from: fmtIso(mon), to: fmtIso(sun) };
  }

  if (key === 'month') {
    return {
      from: fmtIso(new Date(t.getFullYear(), t.getMonth(), 1)),
      to: fmtIso(new Date(t.getFullYear(), t.getMonth() + 1, 0)),
    };
  }

  if (key === 'prevmonth') {
    return {
      from: fmtIso(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
      to: fmtIso(new Date(t.getFullYear(), t.getMonth(), 0)),
    };
  }

  // quarter — с 1-го числа месяца «минус 2» по последнее число текущего.
  return {
    from: fmtIso(new Date(t.getFullYear(), t.getMonth() - 2, 1)),
    to: fmtIso(new Date(t.getFullYear(), t.getMonth() + 1, 0)),
  };
};
