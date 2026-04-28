import { type FC, useState } from 'react';
import { X, UserMinus } from 'lucide-react';
import type { TimesheetEmployee } from '../../types';

interface IProps {
  open: boolean;
  employee: TimesheetEmployee | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (effectiveDate: string) => void;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export const TimesheetExcludeEmployeeModal: FC<IProps> = ({ open, employee, pending, onClose, onConfirm }) => {
  const [effectiveDate, setEffectiveDate] = useState(todayIso());

  if (!open || !employee) return null;

  const handleConfirm = () => {
    if (!effectiveDate) return;
    onConfirm(effectiveDate);
  };

  return (
    <div className="ts-exclude-modal-overlay" onClick={onClose}>
      <div className="ts-exclude-modal" onClick={e => e.stopPropagation()}>
        <div className="ts-exclude-modal-header">
          <h3>Исключить из табеля</h3>
          <button type="button" className="ts-exclude-modal-close" onClick={onClose} disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <div className="ts-exclude-modal-body">
          <div className="ts-exclude-modal-row">
            <span className="ts-exclude-modal-label">Сотрудник</span>
            <span className="ts-exclude-modal-value">{employee.full_name}</span>
          </div>
          <div className="ts-exclude-modal-row">
            <label htmlFor="ts-exclude-date" className="ts-exclude-modal-label">Дата исключения (включительно)</label>
            <input
              id="ts-exclude-date"
              type="date"
              value={effectiveDate}
              onChange={e => setEffectiveDate(e.target.value)}
              disabled={pending}
            />
          </div>
          <p className="ts-exclude-modal-hint">
            До этой даты сотрудник будет отображаться как обычно. С указанной даты ячейки станут неактивными,
            а в следующем месяце сотрудник пропадёт из табеля.
          </p>
        </div>
        <div className="ts-exclude-modal-footer">
          <button type="button" className="ts-exclude-modal-cancel" onClick={onClose} disabled={pending}>
            Отмена
          </button>
          <button type="button" className="ts-exclude-modal-confirm" onClick={handleConfirm} disabled={pending || !effectiveDate}>
            <UserMinus size={14} />
            {pending ? 'Сохранение…' : 'Исключить'}
          </button>
        </div>
      </div>
    </div>
  );
};
