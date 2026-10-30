import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import {
  dormitoryService,
  type DormitoryStayKind,
  type IDormitoryCandidate,
  type IDormitoryStay,
  type IDormitoryStayPayload,
} from '../../../services/dormitoryService';
import {
  DORMITORY_ADDRESS_MAX_LENGTH,
  DORMITORY_STAY_KIND_LABELS,
  parseDormitoryStay,
  type DormitoryStayField,
} from '../../../utils/dormitoryStayForm';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';
import { DormitoryAddressField } from './DormitoryAddressField';

/** Заселение из «Зарплаты» («Справочник» → «Общежитие»): только общежитие, свои поиск и запись. */
export interface IDormitoryStayModalPayroll {
  search: (term: string, signal: AbortSignal) => Promise<IDormitoryCandidate[]>;
  add: (employeeId: number, payload: IDormitoryStayPayload) => Promise<IDormitoryStay>;
}

interface IDormitoryStayModalProps {
  /** Передано — правка этого проживания (сотрудник не меняется); нет — добавление. */
  stay?: IDormitoryStay;
  /** Сохранённые адреса общежитий — подсказки под полем «Адрес / номер». */
  addresses: readonly string[];
  /** Передано — заселение из «Зарплаты» (окно поверх таблицы «Справочника»); нет — вкладка кадров. */
  payroll?: IDormitoryStayModalPayroll;
  onClose: () => void;
  onSaved: (stay: IDormitoryStay) => void;
}

const KINDS: DormitoryStayKind[] = ['dormitory', 'apartment'];

/**
 * «Добавить сотрудника» и ✎ во вкладке «Проживание»: сотрудник (поиск по ФИО), вид (общежитие или квартира —
 * при правке не меняется), дата въезда, дата выезда (пусто — живёт). Общежитие — адрес или номер (сохранённые —
 * списком под полем); квартира — адрес по желанию. Сумму квартиры кадры не задают: новой сервер ставит ставку
 * «Доплата за проживание», меняет её «Зарплата». Ошибка сервера — под полями, ввод не теряется. Из «Зарплаты»
 * (payroll) — только заселение в общежитие: без выбора вида, поиск и запись — «Справочника».
 */
export const DormitoryStayModal: FC<IDormitoryStayModalProps> = ({ stay, addresses, payroll, onClose, onSaved }) => {
  const errorId = useId();
  const addressId = useId();
  const isEdit = stay !== undefined;
  const [kind, setKind] = useState<DormitoryStayKind>(stay?.kind ?? 'dormitory');
  const [employee, setEmployee] = useState<IDormitoryCandidate | null>(null);
  const [checkIn, setCheckIn] = useState(stay?.check_in ?? '');
  const [checkOut, setCheckOut] = useState(stay?.check_out ?? '');
  const [address, setAddress] = useState(stay?.address ?? '');
  const isApartment = kind === 'apartment';
  const [error, setError] = useState<{ field: DormitoryStayField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const clearError = () => setError(null);
  const invalid = (field: DormitoryStayField): true | undefined => (error?.field === field ? true : undefined);
  const dateClass = (field: DormitoryStayField): string =>
    (error?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  /** Адрес общежития в квартиру не переносится. */
  const changeKind = (next: DormitoryStayKind) => {
    if (next === kind) return;
    setKind(next);
    setAddress('');
    clearError();
  };

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parseDormitoryStay(
      { checkIn, checkOut, address },
      { required: !isEdit, selected: employee !== null },
      kind,
    );
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let saved: IDormitoryStay;
      if (isEdit) saved = await dormitoryService.update(stay.id, parsed.payload);
      else if (payroll) saved = await payroll.add(employee!.id, parsed.payload);
      else saved = await dormitoryService.add(employee!.id, kind, parsed.payload);
      onSaved(saved);
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? DORMITORY_STAY_KIND_LABELS[kind] : 'Добавить сотрудника'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error?.message ?? null}
      errorId={errorId}
      raised={payroll !== undefined}
    >
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
          <EmployeeSearchField
            value={employee}
            onChange={value => { setEmployee(value); clearError(); }}
            search={payroll?.search ?? dormitoryService.searchEmployees}
            disabled={saving}
            invalid={error?.field === 'employee'}
          />
        )}
      </div>

      {!isEdit && !payroll && (
        <div className={styles.field}>
          <div className={styles.segmented} role="group" aria-label="Где живёт">
            {KINDS.map(value => (
              <button
                key={value}
                type="button"
                className={styles.segment}
                aria-pressed={kind === value}
                onClick={() => changeKind(value)}
                disabled={saving}
              >
                {DORMITORY_STAY_KIND_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      )}

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

      {isApartment ? (
        <label className={styles.field}>
          <span className={styles.label}>Адрес</span>
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
      ) : (
        /* Не обёрткой <label>: в её текст попали бы адреса списка. */
        <div className={styles.field}>
          <label htmlFor={addressId} className={styles.label}>Адрес / номер</label>
          <DormitoryAddressField
            id={addressId}
            options={addresses}
            value={address}
            onValueChange={value => { setAddress(value); clearError(); }}
            maxLength={DORMITORY_ADDRESS_MAX_LENGTH}
            disabled={saving}
            aria-invalid={invalid('address')}
            aria-describedby={error ? errorId : undefined}
            clearLabel="Очистить адрес"
          />
        </div>
      )}
    </RegistryFormModal>
  );
};
