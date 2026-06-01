import { type FC, useState, useMemo } from 'react';
import { X, Plus } from 'lucide-react';
import type { TimesheetEmployee, TimesheetStatus } from '../../types';
import { CREATABLE_STATUS_META } from '../../utils/correctionStatus';
import { StagedCorrectionAttachments } from './StagedCorrectionAttachments';

interface IProps {
  open: boolean;
  employees: TimesheetEmployee[];
  pending: boolean;
  onClose: () => void;
  onConfirm: (params: {
    employeeId: number;
    dateFrom: string;
    dateTo: string;
    status: TimesheetStatus;
    hours: number | null;
    notes: string;
    files?: File[];
  }) => void;
}

const STATUS_OPTIONS: { value: TimesheetStatus; label: string }[] = CREATABLE_STATUS_META.map(meta => ({
  value: meta.status,
  label: `${meta.icon} ${meta.label}`,
}));

// work/manual («Корректировка табеля») требуют часы; remote — опционально (пусто = из графика).
const HOURS_EDITABLE = new Set<TimesheetStatus>(['work', 'manual', 'remote']);
const MAX_RANGE_DAYS = 60;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number => {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  return Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
};

export const TimesheetBulkCorrectionModal: FC<IProps> = ({ open, employees, pending, onClose, onConfirm }) => {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [status, setStatus] = useState<TimesheetStatus>('vacation');
  const [hours, setHours] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const sortedEmployees = useMemo(
    () => [...employees].sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru')),
    [employees],
  );

  const rangeValid = dateFrom && dateTo && dateFrom <= dateTo;
  const days = rangeValid ? daysBetween(dateFrom, dateTo) : 0;
  const tooLong = days > MAX_RANGE_DAYS;
  const canSubmit = !!employeeId && rangeValid && !tooLong && notes.trim().length > 0 && !pending;
  const showHours = HOURS_EDITABLE.has(status);

  if (!open) return null;

  const handleSubmit = () => {
    if (!canSubmit || !employeeId) return;
    onConfirm({
      employeeId,
      dateFrom,
      dateTo,
      status,
      hours: showHours && hours ? Number(hours) : null,
      notes: notes.trim(),
      files,
    });
  };

  const reset = () => {
    setEmployeeId(null);
    setDateFrom(todayIso());
    setDateTo(todayIso());
    setStatus('vacation');
    setHours('');
    setNotes('');
    setFiles([]);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <div className="ts-bulk-modal-overlay" onClick={handleClose}>
      <div className="ts-bulk-modal" onClick={e => e.stopPropagation()}>
        <div className="ts-bulk-modal-header">
          <h3>Массовая корректировка</h3>
          <button type="button" className="ts-bulk-modal-close" onClick={handleClose} disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <div className="ts-bulk-modal-body">
          <div className="ts-bulk-modal-row">
            <label htmlFor="ts-bulk-emp">Сотрудник <span className="ts-bulk-modal-required">*</span></label>
            <select
              id="ts-bulk-emp"
              value={employeeId ?? ''}
              onChange={e => setEmployeeId(e.target.value ? Number(e.target.value) : null)}
              disabled={pending}
            >
              <option value="">— Выберите —</option>
              {sortedEmployees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.full_name}</option>
              ))}
            </select>
          </div>
          <div className="ts-bulk-modal-row-pair">
            <div className="ts-bulk-modal-row">
              <label htmlFor="ts-bulk-from">С</label>
              <input
                id="ts-bulk-from"
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                disabled={pending}
              />
            </div>
            <div className="ts-bulk-modal-row">
              <label htmlFor="ts-bulk-to">По</label>
              <input
                id="ts-bulk-to"
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                disabled={pending}
              />
            </div>
          </div>
          {rangeValid && (
            <div className={`ts-bulk-modal-info ${tooLong ? 'error' : ''}`}>
              {tooLong
                ? `Слишком большой диапазон: ${days} дн. Максимум — ${MAX_RANGE_DAYS} дней.`
                : `Будет создано ${days} ${days === 1 ? 'корректировка' : days < 5 ? 'корректировки' : 'корректировок'}.`}
            </div>
          )}
          <div className="ts-bulk-modal-row">
            <label htmlFor="ts-bulk-status">Статус <span className="ts-bulk-modal-required">*</span></label>
            <select
              id="ts-bulk-status"
              value={status}
              onChange={e => setStatus(e.target.value as TimesheetStatus)}
              disabled={pending}
            >
              {STATUS_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          {showHours && (
            <div className="ts-bulk-modal-row">
              <label htmlFor="ts-bulk-hours">Часы (необязательно)</label>
              <input
                id="ts-bulk-hours"
                type="number"
                min="0"
                max="24"
                step="0.5"
                value={hours}
                onChange={e => setHours(e.target.value)}
                disabled={pending}
                placeholder="Пусто = из графика"
              />
            </div>
          )}
          <div className="ts-bulk-modal-row">
            <label htmlFor="ts-bulk-notes">Комментарий <span className="ts-bulk-modal-required">*</span></label>
            <textarea
              id="ts-bulk-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={pending}
              rows={3}
              placeholder="Например: Переходящий отпуск с прошлого месяца"
            />
          </div>
          <div style={{ paddingTop: 12 }}>
            <StagedCorrectionAttachments files={files} onChange={setFiles} />
          </div>
        </div>
        <div className="ts-bulk-modal-footer">
          <button type="button" className="ts-bulk-modal-cancel" onClick={handleClose} disabled={pending}>
            Отмена
          </button>
          <button type="button" className="ts-bulk-modal-confirm" onClick={handleSubmit} disabled={!canSubmit}>
            <Plus size={14} />
            {pending ? 'Сохранение…' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
};
