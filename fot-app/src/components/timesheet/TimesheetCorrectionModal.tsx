import { type FC, useState } from 'react';
import { X } from 'lucide-react';
import type { TimesheetStatus } from '../../types';

interface ICorrectionModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (status: TimesheetStatus, hours: number | null, notes: string) => void;
  initialStatus?: TimesheetStatus;
  initialHours?: number | null;
  dayLabel?: string;
}

interface ITypeOption {
  status: TimesheetStatus;
  icon: string;
  label: string;
}

const formatHM = (decimal: number): string => {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

const TYPE_OPTIONS: ITypeOption[] = [
  { status: 'work', icon: '✓', label: 'Присутствие' },
  { status: 'sick', icon: '🏥', label: 'Больничный' },
  { status: 'vacation', icon: '🏖', label: 'Отпуск' },
  { status: 'business_trip', icon: '✈️', label: 'Командировка' },
  { status: 'absent', icon: '❌', label: 'Прогул' },
  { status: 'manual', icon: '✏️', label: 'Ручная корр.' },
];

const CorrectionForm: FC<Omit<ICorrectionModalProps, 'open'>> = ({
  onClose,
  onSave,
  initialStatus = 'work',
  initialHours = 8,
  dayLabel,
}) => {
  const [selectedStatus, setSelectedStatus] = useState<TimesheetStatus>(initialStatus);
  const [hours, setHours] = useState<number>(initialHours ?? 8);
  const [notes, setNotes] = useState('');

  const handleSave = () => {
    const needsHours = selectedStatus === 'work' || selectedStatus === 'manual';
    onSave(selectedStatus, needsHours ? hours : null, notes);
  };

  return (
    <div className="ts-modal" onClick={e => e.stopPropagation()}>
      <div className="ts-modal-header">
        <h3 className="ts-modal-title">
          Корректировка{dayLabel ? ` — ${dayLabel}` : ''}
        </h3>
        <button className="ts-panel-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="ts-modal-body">
        <div className="ts-form-group">
          <label className="ts-form-label">Тип записи</label>
          <div className="ts-type-options">
            {TYPE_OPTIONS.map(opt => (
              <div
                key={opt.status}
                className={`ts-type-option ${selectedStatus === opt.status ? 'ts-type-option--selected' : ''}`}
                onClick={() => setSelectedStatus(opt.status)}
              >
                <div className="ts-type-option-icon">{opt.icon}</div>
                <div className="ts-type-option-label">{opt.label}</div>
              </div>
            ))}
          </div>
        </div>

        {(selectedStatus === 'work' || selectedStatus === 'manual') && (
          <div className="ts-form-group">
            <label className="ts-form-label">Часы</label>
            <input
              type="number"
              className="ts-form-input"
              value={hours}
              onChange={e => setHours(parseFloat(e.target.value) || 0)}
              min={0}
              max={24}
              step={0.5}
            />
            <span className="ts-hours-hint">{formatHM(hours)}</span>
          </div>
        )}

        <div className="ts-form-group">
          <label className="ts-form-label">Комментарий</label>
          <input
            type="text"
            className="ts-form-input"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Причина корректировки..."
          />
        </div>
      </div>
      <div className="ts-modal-footer">
        <button className="ts-btn" onClick={onClose}>Отмена</button>
        <button className="ts-btn ts-btn--primary" onClick={handleSave}>Сохранить</button>
      </div>
    </div>
  );
};

export const TimesheetCorrectionModal: FC<ICorrectionModalProps> = ({ open, ...rest }) => (
  <div
    className={`ts-modal-overlay ${open ? 'ts-modal-overlay--open' : ''}`}
    onClick={rest.onClose}
  >
    {open && <CorrectionForm {...rest} />}
  </div>
);
