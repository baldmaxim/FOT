import { useId, type FC } from 'react';

import {
  CALC_TYPE_LABELS,
  STAFF_CATEGORY_LABELS,
  type PayrollCalcType,
  type StaffCategory,
} from '../../services/payrollService';
import type { PayrollMoneyField, PayrollTermsFormApi } from '../../hooks/usePayrollTermsForm';
import styles from './PayrollTermsFields.module.css';

interface IPayrollTermsFieldsProps {
  form: PayrollTermsFormApi;
  /** Только просмотр: поля заблокированы. */
  readOnly?: boolean;
  /** row — на широком экране разделы в одну строку (карточка сотрудника); stack — друг под другом. */
  layout?: 'stack' | 'row';
}

const COMPENSATION_FIELDS: ReadonlyArray<{ field: PayrollMoneyField; label: string }> = [
  { field: 'housing', label: 'Проживание, ₽/мес' },
  { field: 'travel', label: 'Проезд, ₽/мес' },
  { field: 'communication', label: 'Связь, ₽/мес' },
  { field: 'deduction', label: 'Удержание, ₽/мес' },
];

/** Разделы формы условий оплаты: Оклад, Премиальная часть, Компенсация. */
export const PayrollTermsFields: FC<IPayrollTermsFieldsProps> = ({ form, readOnly = false, layout = 'stack' }) => {
  // Имя группы радиокнопок уникально на экземпляр формы.
  const radioName = useId();

  return (
    <div className={layout === 'row' ? `${styles.sections} ${styles.row}` : styles.sections}>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Оклад</h3>
        <label className={styles.field}>
          <span className={styles.label}>Категория</span>
          <select
            className={styles.input}
            value={form.category}
            disabled={readOnly}
            onChange={event => form.changeCategory(event.target.value as StaffCategory)}
          >
            {(Object.keys(STAFF_CATEGORY_LABELS) as StaffCategory[]).map(key => (
              <option key={key} value={key}>{STAFF_CATEGORY_LABELS[key]}</option>
            ))}
          </select>
        </label>

        <fieldset className={styles.radioGroup} disabled={readOnly}>
          <legend className={styles.label}>Вид оплаты</legend>
          {(Object.keys(CALC_TYPE_LABELS) as PayrollCalcType[]).map(key => (
            <label key={key} className={styles.radio}>
              <input
                type="radio"
                name={radioName}
                value={key}
                checked={form.calcType === key}
                onChange={() => form.setCalcType(key)}
              />
              <span>{CALC_TYPE_LABELS[key]}</span>
            </label>
          ))}
        </fieldset>

        <label className={styles.field}>
          <span className={styles.label}>
            {form.calcType === 'salary' ? 'Оклад, ₽/мес' : 'Часовая ставка, ₽/час'}
          </span>
          <input
            className={styles.input}
            inputMode="decimal"
            value={form.amount}
            disabled={readOnly}
            onChange={event => form.setAmount(event.target.value)}
            placeholder={form.calcType === 'salary' ? '175000' : '450'}
          />
        </label>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Премиальная часть</h3>
        <label className={styles.field}>
          <span className={styles.label}>Премиальная часть, ₽/мес</span>
          <input
            className={styles.input}
            inputMode="decimal"
            value={form.money.bonus}
            disabled={readOnly}
            onChange={event => form.changeMoney('bonus', event.target.value)}
          />
        </label>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Компенсация</h3>
        <div className={styles.grid}>
          {COMPENSATION_FIELDS.map(({ field, label }) => (
            <label key={field} className={styles.field}>
              <span className={styles.label}>{label}</span>
              <input
                className={styles.input}
                inputMode="decimal"
                value={form.money[field]}
                disabled={readOnly}
                onChange={event => form.changeMoney(field, event.target.value)}
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
};
