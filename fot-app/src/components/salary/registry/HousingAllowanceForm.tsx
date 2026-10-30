import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import {
  payrollRegistryService,
  type IHousingAllowanceRow,
  type IPayrollRegistryCandidate,
} from '../../../services/payrollRegistryService';
import {
  DORMITORY_ADDRESS_MAX_LENGTH,
  parseDormitoryStay,
  type DormitoryStayField,
} from '../../../utils/dormitoryStayForm';
import { rateAmountInputValue } from '../../../utils/payrollDictionary';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IHousingAllowanceFormProps {
  /** Передано — ✎ этой квартиры (сотрудник не меняется); нет — «Добавить сотрудника». */
  row?: IHousingAllowanceRow;
  /** Значение ставки «Доплата за проживание» — сумма по умолчанию при добавлении. */
  defaultAmount: string | number | null;
  onClose: () => void;
  onSaved: () => void;
}

const isNotEditable = (candidate: IPayrollRegistryCandidate): boolean => !candidate.can_edit;

/**
 * «Добавить сотрудника» / ✎ в «Квартире» (и ✎ строки квартиры в «Доплате»): сотрудник, ставка ₽/день (миграция 339:
 * расчёт — ставка × дни проживания без отпуска и больничного), въезд, выезд (пусто — живёт),
 * адрес по желанию. Пишется квартира «Проживания» — та же запись, что во вкладке кадров (миграция 320).
 */
export const HousingAllowanceForm: FC<IHousingAllowanceFormProps> = ({ row, defaultAmount, onClose, onSaved }) => {
  const errorId = useId();
  const isEdit = row !== undefined;
  const [employee, setEmployee] = useState<IPayrollRegistryCandidate | null>(null);
  const [amount, setAmount] = useState(rateAmountInputValue(row ? row.amount : defaultAmount));
  const [checkIn, setCheckIn] = useState(row?.check_in ?? '');
  const [checkOut, setCheckOut] = useState(row?.check_out ?? '');
  const [address, setAddress] = useState(row?.address ?? '');
  const [error, setError] = useState<{ field: DormitoryStayField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const clearError = () => setError(null);
  const invalid = (field: DormitoryStayField): true | undefined => (error?.field === field ? true : undefined);
  const dateClass = (field: DormitoryStayField): string =>
    (error?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parseDormitoryStay(
      { checkIn, checkOut, address, amount },
      { required: !isEdit, selected: employee !== null },
      'apartment',
    );
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) await payrollRegistryService.updateHousing(row.id, parsed.payload);
      else await payrollRegistryService.addHousing(employee!.id, parsed.payload);
      onSaved();
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? 'Квартира' : 'Добавить сотрудника'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error?.message ?? null}
      errorId={errorId}
      raised
    >
      <div className={styles.field}>
        <span className={styles.label}>Сотрудник</span>
        {isEdit ? (
          <div className={styles.fixed}>
            <span>
              {row.full_name}
              {row.department && <span className={styles.muted}> — {row.department}</span>}
            </span>
          </div>
        ) : (
          <EmployeeSearchField
            value={employee}
            onChange={value => { setEmployee(value); clearError(); }}
            search={payrollRegistryService.searchEmployees}
            isDisabled={isNotEditable}
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

      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>Ставка, ₽/день</span>
          <ClearableInput
            value={amount}
            onValueChange={value => { setAmount(value); clearError(); }}
            inputMode="decimal"
            autoComplete="off"
            disabled={saving}
            aria-invalid={invalid('amount')}
            aria-describedby={error ? errorId : undefined}
            clearLabel="Очистить ставку"
          />
        </label>
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
      </div>
    </RegistryFormModal>
  );
};
