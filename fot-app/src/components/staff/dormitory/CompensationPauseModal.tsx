import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import { dormitoryService, type ICompensationMonthRow } from '../../../services/dormitoryService';
import { closedMonthsDateError, compensationOpenFrom } from '../../../utils/compensationDates';
import { formatDate } from '../../../utils/formatMoney';
import { DateInput } from '../../ui/DateInput';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

export type CompensationPauseAction = 'suspend' | 'resume';

interface ICompensationPauseModalProps {
  row: ICompensationMonthRow;
  action: CompensationPauseAction;
  /** Сегодня по Москве (YYYY-MM-DD) — дата по умолчанию. */
  today: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * «Компенсация аренды» (миграция 374): «Приостановить» — с даты компенсация не начисляется (дни месяца до неё
 * считаются); «Возобновить» — с даты снова начисляется, не раньше паузы; «Завершить без возобновления» — пауза
 * становится окончанием, строка уходит из следующих месяцев. Обе даты — не раньше открытого периода (миграция 380:
 * дни закрытых месяцев не меняются). Ошибка сервера — под полем, ввод не теряется.
 */
export const CompensationPauseModal: FC<ICompensationPauseModalProps> = ({ row, action, today, onClose, onSaved }) => {
  const errorId = useId();
  const isResume = action === 'resume';
  const pausedFrom = row.check_out ?? '';
  const [date, setDate] = useState(() => (isResume ? (today > pausedFrom ? today : pausedFrom) : (today > row.check_in ? today : '')));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (work: () => Promise<unknown>, requestClose: () => void) => {
    setSaving(true);
    setError(null);
    try {
      await work();
      onSaved();
      requestClose();
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить');
      setSaving(false);
    }
  };

  const handleSubmit = (requestClose: () => void) => {
    if (!date) { setError(isResume ? 'Укажите дату возобновления' : 'Укажите дату приостановки'); return; }
    if (!isResume && date <= row.check_in) {
      setError(`Дата приостановки — позже начала (${formatDate(row.check_in)})`);
      return;
    }
    if (isResume && date < pausedFrom) {
      setError(`Дата возобновления — не раньше ${formatDate(pausedFrom)}`);
      return;
    }
    const openFrom = compensationOpenFrom(today);
    if (date < openFrom) {
      setError(closedMonthsDateError(isResume ? 'возобновления' : 'приостановки', openFrom));
      return;
    }
    void save(
      () => (isResume ? dormitoryService.resumeCompensation(row.id, date) : dormitoryService.suspendCompensation(row.id, date)),
      requestClose,
    );
  };

  const finish = (requestClose: () => void) => {
    if (!window.confirm(`Завершить компенсацию ${row.full_name} без возобновления? С ${formatDate(pausedFrom)} её не будет.`)) return;
    void save(() => dormitoryService.finishCompensationPause(row.id), requestClose);
  };

  return (
    <RegistryFormModal
      title={isResume ? 'Возобновить компенсацию' : 'Приостановить компенсацию'}
      onClose={onClose}
      onSubmit={handleSubmit}
      saving={saving}
      error={error}
      errorId={errorId}
      raised
      submitLabel={isResume ? 'Возобновить' : 'Приостановить'}
    >
      {requestClose => (
        <>
          <div className={styles.field}>
            <span className={styles.label}>Сотрудник</span>
            <div className={styles.fixed}><span>{row.full_name}</span></div>
          </div>
          {isResume && (
            <div className={styles.field}>
              <span className={styles.label}>Приостановлена</span>
              <div className={styles.fixed}><span>{`с ${formatDate(pausedFrom)}`}</span></div>
            </div>
          )}
          <div className={styles.field}>
            <span className={styles.label}>{isResume ? 'Дата возобновления' : 'Дата приостановки'}</span>
            <DateInput
              value={date}
              onChange={value => { setDate(value); setError(null); }}
              className={styles.dateInput}
              disabled={saving}
            />
          </div>
          {isResume && (
            <button type="button" className={styles.linkButton} onClick={() => finish(requestClose)} disabled={saving}>
              Завершить без возобновления…
            </button>
          )}
        </>
      )}
    </RegistryFormModal>
  );
};
