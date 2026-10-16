import { useId, useState, type FC, type FormEvent } from 'react';
import { X } from 'lucide-react';

import { ApiError } from '../../../api/client';
import {
  dormitoryService,
  type IDormitoryCandidate,
  type IDormitoryStay,
} from '../../../services/dormitoryService';
import {
  DORMITORY_ADDRESS_MAX_LENGTH,
  parseDormitoryStay,
  type DormitoryStayField,
} from '../../../utils/dormitoryStayForm';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { ModalShell } from '../../ui/ModalShell';
import { DormitoryEmployeeSearch } from './DormitoryEmployeeSearch';
import styles from './DormitoryStayModal.module.css';

interface IDormitoryStayModalProps {
  /** Передано — правка этого проживания (сотрудник не меняется); нет — добавление. */
  stay?: IDormitoryStay;
  onClose: () => void;
  onSaved: (stay: IDormitoryStay) => void;
}

/**
 * «Добавить сотрудника» и ✎ во вкладке «Общежитие»: сотрудник (поиск по ФИО), дата въезда, дата
 * выезда (пусто — живёт), адрес или номер общежития. Ошибка сервера — под полями, ввод не теряется.
 */
export const DormitoryStayModal: FC<IDormitoryStayModalProps> = ({ stay, onClose, onSaved }) => {
  const titleId = useId();
  const errorId = useId();
  const isEdit = stay !== undefined;
  const [employee, setEmployee] = useState<IDormitoryCandidate | null>(null);
  const [checkIn, setCheckIn] = useState(stay?.check_in ?? '');
  const [checkOut, setCheckOut] = useState(stay?.check_out ?? '');
  const [address, setAddress] = useState(stay?.address ?? '');
  const [error, setError] = useState<{ field: DormitoryStayField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const clearError = () => setError(null);
  const invalid = (field: DormitoryStayField): true | undefined => (error?.field === field ? true : undefined);
  const dateClass = (field: DormitoryStayField): string =>
    (error?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  const handleSubmit = async (event: FormEvent, requestClose: () => void) => {
    event.preventDefault();
    if (saving) return;
    const parsed = parseDormitoryStay(
      { checkIn, checkOut, address },
      { required: !isEdit, selected: employee !== null },
    );
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = isEdit
        ? await dormitoryService.update(stay.id, parsed.payload)
        : await dormitoryService.add(employee!.id, parsed.payload);
      onSaved(saved);
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={styles.overlay}
      containerClassName={styles.container}
      closeOnEscape={!saving}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <form
          className={styles.form}
          onSubmit={event => { void handleSubmit(event, requestClose); }}
          noValidate
        >
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>{isEdit ? 'Проживание' : 'Добавить сотрудника'}</h2>
            <button type="button" className={styles.closeButton} onClick={requestClose} disabled={saving} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={styles.body}>
            <div className={styles.field}>
              <span className={styles.label}>Сотрудник</span>
              {isEdit ? (
                <div className={styles.fixed}>
                  {/* Одним элементом: во flex-контейнере пробел перед «—» у отдельного span пропал бы. */}
                  <span>
                    {stay.full_name}
                    {stay.department && <span className={styles.muted}> — {stay.department}</span>}
                  </span>
                </div>
              ) : (
                <DormitoryEmployeeSearch
                  value={employee}
                  onChange={value => { setEmployee(value); clearError(); }}
                  disabled={saving}
                  invalid={error?.field === 'employee'}
                />
              )}
            </div>

            {/* Не <label>: внутри поля даты — кнопка календаря, клик по подписи открыл бы её. */}
            <div className={styles.dates}>
              <div className={styles.field}>
                <span className={styles.label}>Дата въезда</span>
                <DateInput
                  value={checkIn}
                  onChange={value => { setCheckIn(value); clearError(); }}
                  className={dateClass('check_in')}
                  disabled={saving}
                />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Дата выезда</span>
                <DateInput
                  value={checkOut}
                  onChange={value => { setCheckOut(value); clearError(); }}
                  className={dateClass('check_out')}
                  disabled={saving}
                />
              </div>
            </div>

            <label className={styles.field}>
              <span className={styles.label}>Адрес / номер</span>
              <ClearableInput
                value={address}
                onValueChange={value => { setAddress(value); clearError(); }}
                maxLength={DORMITORY_ADDRESS_MAX_LENGTH}
                autoComplete="off"
                disabled={saving}
                aria-invalid={invalid('address')}
                aria-describedby={error ? errorId : undefined}
                clearLabel="Очистить адрес"
              />
            </label>

            {error && <p id={errorId} className={styles.error} role="alert">{error.message}</p>}
          </div>

          <footer className={styles.footer}>
            <button type="button" className={styles.secondaryButton} onClick={requestClose} disabled={saving}>
              Отмена
            </button>
            <button type="submit" className={styles.primaryButton} disabled={saving}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </footer>
        </form>
      )}
    </ModalShell>
  );
};
