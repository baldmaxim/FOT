import type { ITeamSalaryResponse, TeamSalaryRow } from '../services/teamSalaryService';
import { calcMissingNote } from './payrollCalc';
import { formatPaidAmount } from './payrollPaid';

/**
 * Столбец «Зарплата» в табеле руководителя (миграция 382): подписи, тексты причин и время смены месяца. Месяц —
 * всегда прошлый, его выбирает сервер; переход — в 00:00 МСК 10-го числа (next_from ответа).
 */

const MONTH_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
const MONTH_PREPOSITIONAL = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
];
const MONTH_SHORT = ['янв.', 'фев.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сен.', 'окт.', 'нояб.', 'дек.'];

/** Таймер смены месяца — не дольше суток за раз (вкладка может уснуть; дальше перевзвод). */
export const TEAM_SALARY_TIMER_MAX_MS = 24 * 60 * 60 * 1000;

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const monthIndex = (month: string): number => Number(month.slice(5, 7)) - 1;

/** «2026-10» → «октябрь 2026». */
export const teamSalaryMonthName = (month: string): string => `${MONTH_NOMINATIVE[monthIndex(month)]} ${month.slice(0, 4)}`;

/** «2026-10» → «2026-11». */
const nextMonth = (month: string): string => {
  const index = Number(month.slice(0, 4)) * 12 + monthIndex(month) + 1;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

/** Заголовок столбца: «Зарплата · окт.». */
export const teamSalaryHeader = (month: string): string => `Зарплата · ${MONTH_SHORT[monthIndex(month)]}`;

/** ISO-момент → «10.12» по МСК. */
const formatMskDayMonth = (iso: string): string => {
  const msk = new Date(Date.parse(iso) + MSK_OFFSET_MS).toISOString();
  return `${msk.slice(8, 10)}.${msk.slice(5, 7)}`;
};

/** Подсказка заголовка: «Зарплата за октябрь 2026 — к выплате, без НДФЛ. За ноябрь — с 10.12». */
export const teamSalaryColumnTitle = (data: Pick<ITeamSalaryResponse, 'month' | 'next_from'>): string => (
  `Зарплата за ${teamSalaryMonthName(data.month)} — к выплате, без НДФЛ. `
  + `За ${MONTH_NOMINATIVE[monthIndex(nextMonth(data.month))]} — с ${formatMskDayMonth(data.next_from)}`
);

/** Сумма ячейки: «188 942,00»; суммы нет — «—». */
export const teamSalaryCellText = (row: TeamSalaryRow | undefined): string => (
  row?.status === 'ready' ? formatPaidAmount(Number(row.net)) : '—'
);

/** Почему в ячейке «—» — словами, без цифр; у строки с суммой — null. */
export const teamSalaryReasonText = (row: TeamSalaryRow, month: string): string | null => {
  const name = MONTH_NOMINATIVE[monthIndex(month)];
  if (row.status === 'ready') return null;
  if (row.status === 'not_ready') {
    const missing = calcMissingNote(row.missing);
    return missing ? `Сумма за ${name} неполная (${missing})` : `Сумма за ${name} ещё не готова`;
  }
  switch (row.reason) {
    case 'not_covered':
      return `Табель за ${name} не закрыт`;
    case 'norm_conflict':
      return `Расчёт за ${name} не готов: расходятся нормы графика`;
    case 'no_period':
      return `В ${MONTH_PREPOSITIONAL[monthIndex(month)]} не было периода работы`;
    case 'brigade_open':
      return `Расчёт бригады за ${name} не закрыт`;
  }
};

/** Сдвиг часов клиента: сервер − клиент в момент получения ответа, мс. */
export const teamSalaryClockOffset = (serverNowIso: string, receivedAt: number): number => (
  Date.parse(serverNowIso) - receivedAt
);

/** Сколько мс до смены месяца по часам сервера; ≤ 0 — месяц уже сменился. */
export const msUntilNextMonth = (nextFromIso: string, clockOffsetMs: number, now: number): number => (
  Date.parse(nextFromIso) - (now + clockOffsetMs)
);

/**
 * Ответ истёк ещё на сервере: запрос начался до полуночи 10-го, а очередь ответила после — месяц в нём прежний.
 * Такие суммы не показываются, столбец запрашивается заново.
 */
export const isTeamSalaryExpired = (data: Pick<ITeamSalaryResponse, 'next_from' | 'server_now'>): boolean => (
  Date.parse(data.server_now) >= Date.parse(data.next_from)
);

export interface ITeamSalaryViewInput {
  /** Запрос включён: доступ по профилю, нужный экран, выбран отдел. */
  active: boolean;
  /** Последний запрос закончился ошибкой (React Query при этом держит прежние данные). */
  isError: boolean;
  /** Ошибка — отказ сервера в доступе (403) или слишком большой отдел (422). */
  refused: boolean;
  data: ITeamSalaryResponse | undefined;
}

export interface ITeamSalaryView {
  visible: boolean;
  loading: boolean;
  data: ITeamSalaryResponse | undefined;
  failed: boolean;
}

/**
 * Что показывать: после любой ошибки прежние суммы скрыты (403 после снятия доступа не оставит чужие суммы на экране);
 * отказ в доступе прячет столбец; истёкший ответ — как ещё не пришедший.
 */
export const resolveTeamSalaryView = ({ active, isError, refused, data }: ITeamSalaryViewInput): ITeamSalaryView => {
  const shown = !active || isError || (data !== undefined && isTeamSalaryExpired(data)) ? undefined : data;
  return {
    visible: active && !refused,
    loading: active && !isError && shown === undefined,
    data: shown,
    failed: active && isError && !refused,
  };
};
