/**
 * «Компенсация аренды»: закрытые месяцы (решения пользователя 25–26.11.2026, миграция 380).
 *
 * Расчёт «Зарплаты» считает компенсацию по записям на лету, поэтому правка дат или 🗑 меняли уже выплаченные месяцы
 * (25.11 так пропал Киличов Ш. Р.: запись с 01.09.2026 удалили, новой поставили «Окончание» 19.02.2026). Во вкладке
 * кадров дни компенсации в закрытых месяцах не меняются:
 * - открытый период — с 1-го числа текущего месяца, а по 10-е число включительно — ещё и прошлый месяц
 *   (CLOSED_MONTH_GRACE_DAY: в начале месяца кадры доводят список прошлого);
 * - дни записи в закрытых месяцах — [max(начало, COMPENSATION_CALC_FLOOR), min(окончание, открытый период)): до
 *   01.09.2026 компенсацию ФОТ не считал, эти дни не учитываются;
 * - «Начало» раньше открытого периода у новой записи — справочное (since_on), расчёт — с начала открытого периода;
 *   у старой записи «Начало» раньше прежнего — тоже справочное, расчёт прежний;
 * - «Окончание», пауза, возобновление и 🗑 не меняют дни закрытых месяцев — иначе CompensationClosedMonthsError.
 * «Доплата → Квартира» «Зарплаты» правит те же записи без этих ограничений — правка прошлого остаётся там.
 */

/** До этой даты компенсацию ФОТ не считал («Компенсация аренды» — с сентября 2026). */
export const COMPENSATION_CALC_FLOOR = '2026-09-01';

/** По это число месяца включительно прошлый месяц ещё открыт. */
export const CLOSED_MONTH_GRACE_DAY = 10;

interface IStayDates {
  /** YYYY-MM-DD. */
  check_in: string;
  /** YYYY-MM-DD; без окончания — null. */
  check_out: string | null;
}

/** dd.mm.yyyy. */
const formatDay = (date: string): string => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;

/** Первое число месяца на shift месяцев от первого числа monthStart (YYYY-MM-01). */
const shiftMonthStart = (monthStart: string, shift: number): string => {
  const total = Number(monthStart.slice(0, 4)) * 12 + Number(monthStart.slice(5, 7)) - 1 + shift;
  const year = Math.floor(total / 12);
  const month = total % 12 + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
};

/** Начало открытого периода на сегодня (YYYY-MM-DD по Москве): 1-е число текущего, по 10-е — прошлого месяца. */
export const compensationOpenFrom = (today: string): string => {
  const monthStart = `${today.slice(0, 7)}-01`;
  return Number(today.slice(8, 10)) > CLOSED_MONTH_GRACE_DAY ? monthStart : shiftMonthStart(monthStart, -1);
};

/** Дни записи в закрытых месяцах: [с, по); нет — null. */
export const closedDaysOf = (stay: IStayDates, openFrom: string): { from: string; to: string } | null => {
  const from = stay.check_in > COMPENSATION_CALC_FLOOR ? stay.check_in : COMPENSATION_CALC_FLOOR;
  const to = stay.check_out !== null && stay.check_out < openFrom ? stay.check_out : openFrom;
  return from < to ? { from, to } : null;
};

/** Начало расчёта и справочное «Начало» записи. */
export interface ICompensationStart {
  check_in: string;
  since_on: string | null;
}

/**
 * Введённое «Начало» start → начало расчёта и справочное начало. Новая запись (before null): раньше открытого периода —
 * расчёт с его начала, введённое — справочно. Правка: «Начало» не изменилось — справочное прежнее; раньше прежнего
 * начала в закрытом месяце — расчёт прежний, введённое справочно; прежнее начало в открытом периоде, введённое раньше
 * него — расчёт с начала открытого периода; иначе — как введено (сдвиг внутри закрытых месяцев отклонит guard).
 */
export const resolveCompensationStart = (
  start: string,
  openFrom: string,
  before: { check_in: string; since_on: string | null } | null,
): ICompensationStart => {
  if (before === null) return start < openFrom ? { check_in: openFrom, since_on: start } : { check_in: start, since_on: null };
  if (start === before.check_in) return { check_in: before.check_in, since_on: before.since_on };
  if (start >= openFrom) return { check_in: start, since_on: null };
  if (before.check_in < openFrom) {
    return start < before.check_in ? { check_in: before.check_in, since_on: start } : { check_in: start, since_on: null };
  }
  return { check_in: openFrom, since_on: start };
};

/** Правку нельзя: меняет дни компенсации в закрытых месяцах (или удаляет запись с ними) — ответ 400. */
export class CompensationClosedMonthsError extends Error {
  readonly code = 'COMPENSATION_CLOSED_MONTHS';

  constructor(message: string) {
    super(message);
    this.name = 'CompensationClosedMonthsError';
  }
}

/** Что именно меняет закрытые месяцы — от этого текст ошибки. */
export type ClosedMonthsField = 'check_in' | 'check_out' | 'delete' | 'suspend' | 'resume';

export const closedMonthsMessage = (field: ClosedMonthsField, openFrom: string): string => {
  const closed = `Месяцы до ${formatDay(openFrom)} закрыты — компенсация за них уже рассчитана`;
  switch (field) {
    case 'check_in': return `${closed}: «Начало» в них не меняется`;
    case 'check_out': return `${closed}: «Окончание» — не раньше ${formatDay(openFrom)}`;
    case 'delete': return `${closed}: запись с ними не удаляют — чтобы закончить компенсацию, поставьте «Окончание»`;
    case 'suspend': return `${closed}: дата приостановки — не раньше ${formatDay(openFrom)}`;
    case 'resume': return `${closed}: дата возобновления — не раньше ${formatDay(openFrom)}`;
  }
};

/**
 * Меняет ли запись after дни закрытых месяцев записи before (before null — новая запись): что именно — по первой
 * разнице (начало, иначе окончание); не меняет — null.
 */
export const closedMonthsChange = (
  before: IStayDates | null,
  after: IStayDates,
  openFrom: string,
): 'check_in' | 'check_out' | null => {
  const was = before === null ? null : closedDaysOf(before, openFrom);
  const will = closedDaysOf(after, openFrom);
  if (was?.from === will?.from && was?.to === will?.to) return null;
  if (before !== null && before.check_in === after.check_in) return 'check_out';
  return was?.from !== will?.from ? 'check_in' : 'check_out';
};

/** Бросает CompensationClosedMonthsError, если after меняет дни закрытых месяцев before. */
export const assertClosedMonthsKept = (before: IStayDates | null, after: IStayDates, openFrom: string): void => {
  const field = closedMonthsChange(before, after, openFrom);
  if (field !== null) throw new CompensationClosedMonthsError(closedMonthsMessage(field, openFrom));
};
