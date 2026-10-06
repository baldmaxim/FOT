import { useState, type FC } from 'react';
import { ChevronDown } from 'lucide-react';

import { usePayrollDeductionKinds } from '../../hooks/usePayrollDeductionKinds';
import type { PayrollEmployeeDeductionsApi } from '../../hooks/usePayrollEmployeeDeductions';
import { formatDeductionKinds } from '../../utils/payrollDeductions';
import { DeductionKindsMenu } from './DeductionKindsMenu';
import fields from './PayrollTermsFields.module.css';
import styles from './DeductionKindsField.module.css';

interface IDeductionKindsFieldProps {
  id: string;
  deductions: PayrollEmployeeDeductionsApi;
  readOnly?: boolean;
}

/**
 * «Вид» в «Удержании» карточки: несколько видов из справочника, как в столбце «Удержание»
 * на «Расчётах». Новый вид добавляется в том же меню. Сохраняется с карточкой.
 */
export const DeductionKindsField: FC<IDeductionKindsFieldProps> = ({ id, deductions, readOnly = false }) => {
  const kinds = usePayrollDeductionKinds();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const list = kinds.data ?? [];
  const label = formatDeductionKinds(deductions.selected, list);
  const placeholder = deductions.isError || kinds.isError ? 'ошибка загрузки' : '—';

  /** Закрытие возвращает фокус на поле — клавиатура не теряет место. */
  const close = () => {
    anchor?.focus();
    setAnchor(null);
  };

  return (
    <div className={fields.field}>
      <label htmlFor={id} className={fields.label}>Вид</label>
      <button
        id={id}
        type="button"
        className={`${fields.control} ${styles.trigger}`}
        disabled={readOnly || !deductions.ready || !kinds.data}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        title={label || undefined}
        onClick={event => setAnchor(event.currentTarget)}
      >
        <span className={styles.value}>{label || placeholder}</span>
        <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
      </button>
      {anchor && (
        <DeductionKindsMenu
          anchor={anchor}
          kinds={list}
          selected={deductions.selected}
          onToggle={(kindId, checked) => deductions.toggle(kindId, checked, list)}
          onClose={close}
        />
      )}
    </div>
  );
};
