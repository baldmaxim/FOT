/**
 * Денежные пропорции и даты расчёта «К выплате (ФОТ)» — общие для расчёта по дням (payroll-calc.rules.ts) и оклада по
 * часам (payroll-calc-hours.rules.ts). Деньги — целые копейки (Math.round(x * 100), как во всей «Зарплате»).
 */
import { toCents } from './payroll-summary.attribution.js';

export const cents = (amount: string | null): number => (amount === null ? 0 : toCents(amount));

/** Ставка '730.5000' → 7 305 000 десятитысячных рубля. */
export const rateUnits = (rate: string | null): number => (rate === null ? 0 : Math.round(Number(rate) * 10_000));

/** Ставка × минуты / 60, половина вверх до копейки; в копейках. BigInt: ставка до 12 цифр × минуты не влезает в double. */
export const hourlyAmountCents = (units: number, minutes: number): number => Number(
  (2n * BigInt(units) * BigInt(minutes) + 6_000n) / 12_000n,
);

/** Сумма × дни / норма, половина вверх до рубля; в копейках. */
export const prorateToRubleCents = (amountCents: number, days: number, norm: number): number => {
  const normCents = norm * 100;
  return Math.floor((2 * amountCents * days + normCents) / (2 * normCents)) * 100;
};

/** Сумма × минуты / норма минут, половина вверх до копейки; в копейках. */
export const prorateMinutesCents = (amountCents: number, minutes: number, normMinutes: number): number => (
  Math.floor((2 * amountCents * minutes + normMinutes) / (2 * normMinutes))
);

/** Сумма × минуты / норма минут, половина вверх до рубля; в копейках (оклад по часам с округлением ruble). */
export const prorateMinutesToRubleCents = (amountCents: number, minutes: number, normMinutes: number): number => (
  prorateToRubleCents(amountCents, minutes, normMinutes)
);

/** Дневная ставка до копейки, половина вверх; в копейках. */
export const dailyKopeckRateCents = (amountCents: number, norm: number): number => (
  Math.floor((2 * amountCents + norm) / (2 * norm))
);

/** Дневная ставка до копейки (половина вверх) × дни; в копейках. */
export const prorateDailyKopeckCents = (amountCents: number, days: number, norm: number): number => (
  dailyKopeckRateCents(amountCents, norm) * days
);

export const inRange = (date: string, from: string, to: string | null): boolean => date >= from && (to === null || date <= to);

/** Период условий или доплаты в границах месяца — для подписи части. */
export const clampPeriod = (
  from: string,
  to: string | null,
  monthStart: string,
  monthEnd: string,
): { from: string; to: string } => ({
  from: from < monthStart ? monthStart : from,
  to: to === null || to > monthEnd ? monthEnd : to,
});
