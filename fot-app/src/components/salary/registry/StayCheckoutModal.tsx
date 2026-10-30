import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { stayCheckoutError } from '../../../utils/payrollRegistries';
import { DateInput } from '../../ui/DateInput';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

/** Проживание, из которого выселяют: квартира или общежитие. */
export interface IStayCheckoutTarget {
  full_name: string;
  department: string | null;
  /** YYYY-MM-DD. */
  check_in: string;
  /** YYYY-MM-DD; живёт — null. */
  check_out: string | null;
}

interface IStayCheckoutModalProps {
  stay: IStayCheckoutTarget;
  onClose: () => void;
  /** Записать выезд; ошибка сервера — под полем, ввод не теряется. */
  onSubmit: (checkOut: string) => Promise<void>;
}

/**
 * 🗑 «Убрать» у идущего проживания (квартира, общежитие): дата выезда — день, когда уже не живёт, по умолчанию
 * сегодня. Деньги считаются по дням (миграция 339), поэтому дата — любая, а не 1-е число месяца.
 */
export const StayCheckoutModal: FC<IStayCheckoutModalProps> = ({ stay, onClose, onSubmit }) => {
  const errorId = useId();
  const [checkOut, setCheckOut] = useState(moscowTodayIso);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (requestClose: () => void) => {
    const invalid = stayCheckoutError(checkOut, stay);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(checkOut);
      requestClose();
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить');
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title="Выезд"
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error}
      errorId={errorId}
      raised
    >
      <div className={styles.field}>
        <span className={styles.label}>Сотрудник</span>
        <div className={styles.fixed}>
          {/* Одним элементом: во flex-контейнере пробел перед «—» у отдельного span пропал бы. */}
          <span>
            {stay.full_name}
            {stay.department && <span className={styles.muted}> — {stay.department}</span>}
          </span>
        </div>
      </div>
      {/* Не <label>: внутри поля даты — кнопка календаря, клик по подписи открыл бы её. */}
      <div className={styles.field}>
        <span className={styles.label}>Дата выезда</span>
        <DateInput
          value={checkOut}
          onChange={value => { setCheckOut(value); setError(null); }}
          className={error ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput}
          disabled={saving}
        />
      </div>
    </RegistryFormModal>
  );
};
