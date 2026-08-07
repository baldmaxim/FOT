import type { ILeaveRequest } from '../services/leaveRequestService';
import { getDaysInMonth, getMonthLabel } from './calendarUtils';
import { leaveRequestMonthKeys } from './leaveRequestDates';

/** Значение селекта «без ограничения по периоду». */
export const LEAVE_PERIOD_ALL = 'all';

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface ILeaveMonthOption {
  key: string;
  label: string;
}

/**
 * Опции селекта периода: месяцы, реально встречающиеся в заявлениях, от новых к старым.
 * `selected` остаётся в списке, даже если в данных его уже нет (последнюю карточку
 * месяца согласовали/ознакомились) — иначе селект молча сбросился бы на «Все периоды».
 */
export const leaveMonthOptions = (requests: ILeaveRequest[], selected: string): ILeaveMonthOption[] => {
  const keys = new Set<string>();
  for (const r of requests) {
    for (const key of leaveRequestMonthKeys(r)) keys.add(key);
  }
  if (selected !== LEAVE_PERIOD_ALL && MONTH_KEY_RE.test(selected)) keys.add(selected);

  return Array.from(keys)
    .sort((a, b) => b.localeCompare(a))
    .map(key => {
      const [year, month] = key.split('-').map(Number);
      return { key, label: getMonthLabel(year, month) };
    });
};

/** 'YYYY-MM' → границы месяца включительно; для «Все периоды» и мусора — null. */
export const leaveMonthRange = (key: string): { from: string; to: string } | null => {
  if (!MONTH_KEY_RE.test(key)) return null;
  const [year, month] = key.split('-').map(Number);
  // Строками, без toISOString(): в положительном UTC-смещении он даёт предыдущую дату.
  return { from: `${key}-01`, to: `${key}-${String(getDaysInMonth(year, month)).padStart(2, '0')}` };
};
