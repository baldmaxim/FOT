import type { IApprovalAttachment, ITimesheetApproval } from '../services/timesheetApprovalService';

type ApprovalMemoState = Pick<ITimesheetApproval, 'status' | 'unlocked_at'>;

/** Служебку прикладывают и удаляют свободно: до подачи и после возврата. */
const MEMO_EDITABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'rejected', 'returned']);

/** Табель открыт кнопкой «Открыть табель»: подан или согласован и unlocked_at задан (как на сервере). */
export const isApprovalOpenedForEdits = (approval: ApprovalMemoState | null | undefined): boolean => (
  !!approval
  && (approval.status === 'submitted' || approval.status === 'approved')
  && approval.unlocked_at != null
);

/** Можно ли приложить служебку: подачи ещё нет, черновик / отклонён / на доработке или табель открыт. */
export const isApprovalMemoEditable = (approval: ApprovalMemoState | null | undefined): boolean => (
  !approval || MEMO_EDITABLE_STATUSES.has(approval.status) || isApprovalOpenedForEdits(approval)
);

/**
 * Корзина у файла в окне «Файлы табеля». Только служебки; в открытом табеле — лишь с deletable === true
 * от сервера (приложенные после открытия): старый бэкенд поля не шлёт, и корзины у служебок, по которым
 * табель согласовали, быть не должно. В черновике без поля — как раньше.
 */
export const canDeleteApprovalMemo = (
  approval: ApprovalMemoState | null | undefined,
  attachment: Pick<IApprovalAttachment, 'kind' | 'deletable'>,
): boolean => {
  if (attachment.kind !== 'weekend_memo') return false;
  if (isApprovalOpenedForEdits(approval)) return attachment.deletable === true;
  return isApprovalMemoEditable(approval) && attachment.deletable !== false;
};
