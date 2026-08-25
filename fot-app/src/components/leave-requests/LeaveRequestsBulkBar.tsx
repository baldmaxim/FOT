import { type FC } from 'react';
import { Check, X } from 'lucide-react';
import { TriStateCheckbox, type CheckboxSelectionState } from '../ui/TriStateCheckbox';

interface ILeaveRequestsBulkBarProps {
  /** Сколько заявлений вообще можно выбрать на текущей вкладке. */
  selectableCount: number;
  selectedCount: number;
  selectionState: CheckboxSelectionState;
  onToggleAll: (checked: boolean) => void;
  comment: string;
  onCommentChange: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  /** Идёт массовая операция либо данные ещё не актуальны (placeholder). */
  disabled: boolean;
}

/**
 * Панель массовых действий над выбранными заявлениями. Показывается только на
 * вкладке «Ожидающие» тем, кто может согласовывать.
 */
export const LeaveRequestsBulkBar: FC<ILeaveRequestsBulkBarProps> = ({
  selectableCount,
  selectedCount,
  selectionState,
  onToggleAll,
  comment,
  onCommentChange,
  onApprove,
  onReject,
  disabled,
}) => {
  const actionsDisabled = disabled || selectedCount === 0;

  return (
    <div className="lrm-bulkbar">
      <TriStateCheckbox
        className="lrm-bulkbar-check"
        state={selectionState}
        onChange={onToggleAll}
        ariaLabel="Выбрать все ожидающие заявления"
        disabled={disabled}
      />
      <span className="lrm-bulkbar-summary">
        {selectedCount > 0
          ? <>Выбрано: <b>{selectedCount}</b> из <b>{selectableCount}</b></>
          : <><b>{selectableCount}</b> ожидают решения</>}
      </span>
      <input
        className="lrm-bulkbar-comment"
        placeholder="Комментарий ко всем выбранным (необязательно)"
        value={comment}
        onChange={e => onCommentChange(e.target.value)}
        disabled={disabled}
      />
      <div className="lrm-bulkbar-btns">
        <button
          type="button"
          className="lrm-bulkbar-btn lrm-bulkbar-btn--approve"
          onClick={onApprove}
          disabled={actionsDisabled}
        >
          <Check size={15} /> Согласовать{selectedCount > 0 ? ` (${selectedCount})` : ''}
        </button>
        <button
          type="button"
          className="lrm-bulkbar-btn lrm-bulkbar-btn--reject"
          onClick={onReject}
          disabled={actionsDisabled}
        >
          <X size={15} /> Отклонить{selectedCount > 0 ? ` (${selectedCount})` : ''}
        </button>
      </div>
    </div>
  );
};
