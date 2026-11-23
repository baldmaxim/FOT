import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import { dormitoryService, type ICompanyApartment, type IDormitoryStay } from '../../../services/dormitoryService';
import { ClearableInput } from '../../ui/ClearableInput';
import { formatDate } from '../../../utils/formatMoney';
import { apartmentTitle } from '../../../utils/housingTables';
import { DateInput } from '../../ui/DateInput';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';
import { DormitorySelect } from './DormitorySelect';

type Target = 'dormitory' | 'flat';

interface IStayMoveModalProps {
  stay: IDormitoryStay;
  /** Названия общежитий справочника (миграция 377). */
  addresses: readonly string[];
  apartments: readonly ICompanyApartment[];
  /** false — только в другое общежитие (вкладка «Общежитие»): выбора «Квартира» нет. */
  allowFlat?: boolean;
  /** Сегодня по Москве (YYYY-MM-DD): дата по умолчанию и верхняя граница. */
  today: string;
  raised?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/** Первое число месяца даты YYYY-MM-DD. */
const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;
/** Как CHECK employee_dormitory_stay_comment (миграция 371). */
const COMMENT_MAX_LENGTH = 500;

/**
 * «Переселить» (миграция 371): с даты сотрудник живёт в другом общежитии или служебной квартире. Прежняя запись
 * закрывается этой датой и остаётся в истории, новая — с неё. Дата — с 1-го числа текущего месяца по сегодня
 * (закрытые месяцы «Зарплаты» не трогаются). Деньги не меняются: доплата за общежитие не идёт ни там, ни там.
 * Комментарий — новой записи; пусто — переносится прежний.
 */
export const StayMoveModal: FC<IStayMoveModalProps> = ({
  stay, addresses, apartments, allowFlat = true, today, raised = false, onClose, onSaved,
}) => {
  const errorId = useId();
  const addressId = useId();
  const apartmentId = useId();
  const [target, setTarget] = useState<Target>('dormitory');
  const [comment, setComment] = useState('');
  const [date, setDate] = useState(today);
  const [address, setAddress] = useState('');
  const [flatId, setFlatId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const otherApartments = apartments.filter(apartment => apartment.id !== stay.apartment_id);

  const handleSubmit = async (requestClose: () => void) => {
    if (!date) { setError('Укажите дату переселения'); return; }
    if (date < monthStart(today) || date > today) {
      setError(`Дата переселения — с ${formatDate(monthStart(today))} по ${formatDate(today)}`);
      return;
    }
    if (date <= stay.check_in) { setError('Дата переселения должна быть позже даты въезда'); return; }
    const trimmed = address.replace(/\s+/g, ' ').trim();
    if (target === 'dormitory' && !trimmed) { setError('Выберите общежитие'); return; }
    if (target === 'flat' && flatId === null) { setError('Выберите квартиру'); return; }
    setSaving(true);
    setError(null);
    try {
      await dormitoryService.move(
        stay.id,
        date,
        target === 'flat' ? { apartment_id: flatId! } : { address: trimmed },
        comment.trim() || null,
      );
      onSaved();
      requestClose();
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : 'Не удалось переселить');
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title="Переселить"
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error}
      errorId={errorId}
      raised={raised}
    >
      <div className={styles.field}>
        <span className={styles.label}>Сотрудник</span>
        <div className={styles.fixed}>
          <span>
            {stay.full_name}
            {stay.address && <span className={styles.muted}> — {stay.address}</span>}
          </span>
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Дата переселения</span>
        <DateInput
          value={date}
          onChange={value => { setDate(value); setError(null); }}
          className={styles.dateInput}
          disabled={saving}
        />
      </div>

      {allowFlat && (
        <div className={styles.field}>
          <div className={styles.segmented} role="group" aria-label="Куда">
            {(['dormitory', 'flat'] as const).map(value => (
              <button
                key={value}
                type="button"
                className={styles.segment}
                aria-pressed={target === value}
                onClick={() => { setTarget(value); setError(null); }}
                disabled={saving || (value === 'flat' && otherApartments.length === 0)}
              >
                {value === 'dormitory' ? 'Общежитие' : 'Квартира'}
              </button>
            ))}
          </div>
        </div>
      )}

      {target === 'dormitory' ? (
        <div className={styles.field}>
          <label htmlFor={addressId} className={styles.label}>Общежитие</label>
          <DormitorySelect
            id={addressId}
            options={addresses}
            value={address}
            onChange={value => { setAddress(value); setError(null); }}
            disabled={saving}
            describedBy={error ? errorId : undefined}
            exclude={stay.apartment_id ? null : stay.address}
          />
        </div>
      ) : (
        <div className={styles.field}>
          <label htmlFor={apartmentId} className={styles.label}>Квартира</label>
          <select
            id={apartmentId}
            className={styles.select}
            value={flatId ?? ''}
            onChange={event => { setFlatId(event.target.value ? Number(event.target.value) : null); setError(null); }}
            disabled={saving}
          >
            <option value="">Выберите квартиру</option>
            {otherApartments.map(apartment => (
              <option key={apartment.id} value={apartment.id}>{apartmentTitle(apartment)}</option>
            ))}
          </select>
        </div>
      )}

      <label className={styles.field}>
        <span className={styles.label}>Комментарий</span>
        <ClearableInput
          value={comment}
          onValueChange={value => { setComment(value); setError(null); }}
          maxLength={COMMENT_MAX_LENGTH}
          autoComplete="off"
          disabled={saving}
          clearLabel="Очистить комментарий"
        />
      </label>
    </RegistryFormModal>
  );
};
