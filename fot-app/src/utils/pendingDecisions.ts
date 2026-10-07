import type { IPendingDecision, ITimesheetApproval } from '../services/timesheetApprovalService';
import { formatFioShort } from './formatFio';

export const PENDING_WEEKENDS_LABEL = 'Ждёт согласования выходных';

const formatDay = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

type IApprovalPendingFields = Pick<ITimesheetApproval, 'status' | 'pending_decisions' | 'pending_decisions_count'>;

/** Поданный табель ждёт решения по выходным: дни у согласующего или заявления на 1-м этапе. */
export const isWaitingWeekends = (approval: IApprovalPendingFields | null | undefined): boolean => {
  if (!approval || approval.status !== 'submitted') return false;
  if (approval.pending_decisions) return approval.pending_decisions.length > 0;
  return (approval.pending_decisions_count ?? 0) > 0;
};

const formatResponsible = (decision: IPendingDecision): string => (
  decision.responsible_names.length > 0
    ? decision.responsible_names.map(name => formatFioShort(name) ?? name).join(' / ')
    : 'ответственный не назначен'
);

/** «Чепиков А. В.: 05.09, 06.09; Иванов И. И. (заявление): 12.09». */
export const formatPendingDecisions = (decisions: IPendingDecision[]): string => decisions
  .map(decision => {
    const stage = decision.stage === 'request' ? ' (заявление)' : '';
    return `${formatResponsible(decision)}${stage}: ${decision.days.map(formatDay).join(', ')}`;
  })
  .join('; ');

/** Кто должен решить — без дней, без повторов: для подсказки кнопки «Утвердить». */
export const formatPendingResponsibles = (decisions: IPendingDecision[]): string => (
  [...new Set(decisions.map(formatResponsible))].join(', ')
);
