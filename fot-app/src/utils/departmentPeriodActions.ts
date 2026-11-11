import type {
  IDepartmentPeriodState,
  ITimesheetApproval,
  TimesheetApprovalStatus,
} from '../services/timesheetApprovalService';
import { formatTimesheetRangeLabel } from './timesheetApprovalPeriod';
import { isWaitingWeekends } from './pendingDecisions';

/** Кнопки «Открыть/Закрыть табель» отдела для одной половины месяца — как во вкладке «Выходные». */
export interface IDepartmentPeriodHalfButtons {
  half: 1 | 2;
  start_date: string;
  end_date: string;
  /** Подпись половины: «1–15 окт 2026». */
  periodLabel: string;
  /** Есть закрытые табели, держащие дни людей отдела в этой половине. */
  canOpen: boolean;
  /** Есть табели, открытые в этой половине, которые закроет кнопка. */
  canClose: boolean;
}

/**
 * Кнопки по половинам по ответу сервера: у каждой половины свои «Открыть» и «Закрыть». Половина, где нечего открыть
 * и закрыть, кнопок не получает; нет ответа — кнопок нет.
 */
export const resolveDepartmentPeriodHalfButtons = (
  state: IDepartmentPeriodState | null | undefined,
): IDepartmentPeriodHalfButtons[] => (state?.halves ?? [])
  .map(half => ({
    half: half.half,
    start_date: half.start_date,
    end_date: half.end_date,
    periodLabel: formatTimesheetRangeLabel(half.start_date, half.end_date),
    canOpen: half.open_ids.length > 0,
    canClose: half.close_ids.length > 0,
  }))
  .filter(half => half.canOpen || half.canClose);

/** Ранг статуса месяца: месяц «утверждён», только если утверждены обе половины. */
const STATUS_RANK: Record<TimesheetApprovalStatus, number> = {
  draft: 0,
  rejected: 1,
  returned: 2,
  submitted: 3,
  approved: 4,
};
const ACTIVE_STATUSES = new Set<TimesheetApprovalStatus>(['submitted', 'approved', 'returned']);

export interface IMonthHalvesSummary {
  /** В месяце есть подачи — подавать за весь месяц нельзя (подача по половинам). */
  hasApprovals: boolean;
  /** Статус месяца: «младший» по двум половинам, половина без подачи — черновик. */
  status: TimesheetApprovalStatus;
  /** Хотя бы одна поданная половина ждёт согласования выходных. */
  waitingWeekends: boolean;
}

/**
 * Сводка месяца по подачам половин — для «Весь месяц», когда подачи на 1–31 нет. Строится относительно ОБЕИХ
 * канонических половин: одна утверждённая половина без второй — месяц ещё черновик.
 */
export const summarizeMonthHalves = (params: {
  startDate: string;
  endDate: string;
  approvals: readonly ITimesheetApproval[];
}): IMonthHalvesSummary => {
  const { startDate, endDate } = params;
  const inRange = params.approvals.filter(a => a.start_date <= endDate && a.end_date >= startDate);
  const midEnd = `${startDate.slice(0, 7)}-15`;
  const midStart = `${startDate.slice(0, 7)}-16`;
  const halves = [
    { start: startDate, end: midEnd },
    { start: midStart, end: endDate },
  ];
  const covering = halves.map(half => {
    const candidates = inRange
      .filter(a => a.start_date <= half.start && a.end_date >= half.end)
      .sort((a, b) => {
        const activeDiff = Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status));
        return activeDiff !== 0 ? activeDiff : b.id - a.id;
      });
    return candidates[0] ?? null;
  });
  const status = covering
    .map(approval => approval?.status ?? 'draft')
    .reduce<TimesheetApprovalStatus>((min, next) => (STATUS_RANK[next] < STATUS_RANK[min] ? next : min), 'approved');
  return {
    hasApprovals: inRange.length > 0,
    status,
    waitingWeekends: covering.some(approval => isWaitingWeekends(approval)),
  };
};
