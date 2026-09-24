import type { FC } from 'react';

import {
  CALC_TYPE_LABELS,
  STAFF_CATEGORY_LABELS,
  type PayrollCalcType,
  type StaffCategory,
} from '../../services/payrollService';
import type { PayrollTermsFormApi } from '../../hooks/usePayrollTermsForm';
import {
  payrollFieldId,
  type PayrollMoneyField,
  type PayrollTermsFieldKey,
} from '../../utils/payrollTermsForm';
import styles from './PayrollTermsFields.module.css';

interface IPayrollTermsFieldsProps {
  form: PayrollTermsFormApi;
  /** Префикс id полей: по нему модалка ставит фокус на первое поле с ошибкой. */
  idPrefix: string;
  /** Только просмотр: поля заблокированы. */
  readOnly?: boolean;
  /** Фокус на «Категорию» при открытии окна. */
  autoFocus?: boolean;
}

/** «Компенсация» 2×2 — в порядке на экране: проживание | удержание, проезд | связь. */
const COMPENSATION_FIELDS: ReadonlyArray<{ field: PayrollMoneyField; label: string }> = [
  { field: 'housing', label: 'Проживание, ₽/мес' },
  { field: 'deduction', label: 'Удержание, ₽/мес' },
  { field: 'travel', label: 'Проезд, ₽/мес' },
  { field: 'communication', label: 'Связь, ₽/мес' },
];

const CALC_TYPES = Object.keys(CALC_TYPE_LABELS) as PayrollCalcType[];

/**
 * Форма условий оплаты: основная оплата (оклад или ставка и премия — парой в одной ячейке)
 * и «Компенсация» 2×2. Две колонки, в узком окне — одна (container query). Ошибки — под своим полем.
 */
export const PayrollTermsFields: FC<IPayrollTermsFieldsProps> = ({ form, idPrefix, readOnly = false, autoFocus = false }) => {
  const fieldId = (key: PayrollTermsFieldKey | 'category') => payrollFieldId(idPrefix, key);

  /** Денежное поле с подписью сверху и ошибкой снизу. Без числовых подсказок: подсказка — не значение. */
  const renderMoney = (key: PayrollTermsFieldKey, label: string, value: string, onChange: (next: string) => void) => {
    const error = form.fieldErrors[key];
    const id = fieldId(key);
    return (
      <div className={styles.field} key={key}>
        <label htmlFor={id} className={styles.label}>{label}</label>
        <input
          id={id}
          className={styles.control}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          disabled={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => onChange(event.target.value)}
        />
        {error && <p id={`${id}-error`} className={styles.error}>{error}</p>}
      </div>
    );
  };

  const dateError = form.fieldErrors.effectiveFrom;
  const dateId = fieldId('effectiveFrom');

  return (
    <div className={styles.form}>
      <section className={styles.section} aria-labelledby={`${idPrefix}-main`}>
        <h3 id={`${idPrefix}-main`} className={styles.sectionTitle}>Основная оплата</h3>
        <div className={styles.grid}>
          <div className={styles.field}>
            <label htmlFor={fieldId('category')} className={styles.label}>Категория</label>
            <select
              id={fieldId('category')}
              className={styles.control}
              value={form.category}
              disabled={readOnly}
              autoFocus={autoFocus && !readOnly}
              onChange={event => form.changeCategory(event.target.value as StaffCategory)}
            >
              {(Object.keys(STAFF_CATEGORY_LABELS) as StaffCategory[]).map(key => (
                <option key={key} value={key}>{STAFF_CATEGORY_LABELS[key]}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor={dateId} className={styles.label}>Действует с</label>
            <input
              id={dateId}
              type="date"
              className={styles.control}
              value={form.effectiveFrom}
              disabled={readOnly}
              required
              aria-invalid={dateError ? true : undefined}
              aria-describedby={dateError ? `${dateId}-error` : undefined}
              onChange={event => form.setEffectiveFrom(event.target.value)}
            />
            {dateError && <p id={`${dateId}-error`} className={styles.error}>{dateError}</p>}
          </div>

          <div className={styles.field}>
            <span id={`${idPrefix}-calc-type`} className={styles.label}>Вид оплаты</span>
            <div
              role="radiogroup"
              aria-labelledby={`${idPrefix}-calc-type`}
              className={readOnly ? `${styles.segmented} ${styles.segmentedDisabled}` : styles.segmented}
            >
              {CALC_TYPES.map(key => (
                <label key={key} className={styles.segment}>
                  <input
                    type="radio"
                    className={styles.segmentInput}
                    name={`${idPrefix}-calc-type`}
                    value={key}
                    checked={form.calcType === key}
                    disabled={readOnly}
                    onChange={() => form.setCalcType(key)}
                  />
                  <span className={styles.segmentLabel}>{CALC_TYPE_LABELS[key]}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Два отдельных поля в одной ячейке: оклад (или ставка) и премия. Сохраняются раздельно. */}
          <div className={styles.pair}>
            {renderMoney(
              'amount',
              form.calcType === 'salary' ? 'Оклад, ₽/мес' : 'Часовая ставка, ₽/час',
              form.amount,
              form.setAmount,
            )}
            {renderMoney('bonus', 'Премиальная часть, ₽/мес', form.money.bonus, value => form.changeMoney('bonus', value))}
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby={`${idPrefix}-compensation`}>
        <h3 id={`${idPrefix}-compensation`} className={styles.sectionTitle}>Компенсация</h3>
        <div className={styles.grid}>
          {COMPENSATION_FIELDS.map(({ field, label }) => renderMoney(
            field,
            label,
            form.money[field],
            value => form.changeMoney(field, value),
          ))}
        </div>
      </section>
    </div>
  );
};
