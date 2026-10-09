import type { FC, ReactNode } from 'react';

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
  /** Префикс id полей: по нему карточка и окно ставят фокус на первое поле с ошибкой. */
  idPrefix: string;
  /** Только просмотр: поля заблокированы. */
  readOnly?: boolean;
  /** Категория по отделу сотрудника — только для чтения. Не передана — поля нет (массовое назначение). */
  category?: StaffCategory | null;
  /** Фокус на выбранный «Вид оплаты» при открытии карточки или окна. */
  autoFocus?: boolean;
  /** Блок «Оплачено» под окладом и премией, на всю ширину формы; не передан — блока нет. */
  paid?: ReactNode;
  /** «Основная оплата» в одну колонку: сумма и премия — под «Категорией · Видом оплаты · Действует с». */
  stacked?: boolean;
  /**
   * «Вид» в «Удержании» — виды удержаний сотрудника (только в карточке). Не передан — поля нет:
   * в «Назначить выделенным» виды у каждого свои.
   */
  deductionKinds?: ReactNode;
  /**
   * Компенсация, плановая доплата и удержание. false — секций нет: в «Подробно» их не вносят
   * (только в окне сотрудника на «Расчётах»), значения из условий в форме остаются как были.
   */
  paymentSections?: boolean;
}

/** «Компенсация» в одну строку — в порядке на экране. */
const COMPENSATION_FIELDS: ReadonlyArray<{ field: PayrollMoneyField; label: string }> = [
  { field: 'housing', label: 'Проживание, ₽/мес' },
  { field: 'travel', label: 'Проезд, ₽/мес' },
];

const CALC_TYPES = Object.keys(CALC_TYPE_LABELS) as PayrollCalcType[];

/**
 * Форма условий оплаты. Секции — две половины: слева Категория (только чтение) · Вид оплаты · Действует с,
 * компенсации, плановая доплата (только в карточке сотрудника) и удержание; справа оклад (или ставка) с премией.
 * «Оплачено» (только в карточке) — под ними на всю ширину формы. В узком окне и при stacked половины встают
 * друг под друга, на телефоне поля — в столбик (container queries). Ошибки — под своим полем.
 */
export const PayrollTermsFields: FC<IPayrollTermsFieldsProps> = ({
  form,
  idPrefix,
  readOnly = false,
  category,
  autoFocus = false,
  paid,
  stacked = false,
  deductionKinds,
  paymentSections = true,
}) => {
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

  /** Поле даты с подписью сверху и ошибкой снизу. */
  const renderDate = (
    key: PayrollTermsFieldKey,
    label: string,
    value: string,
    onChange: (next: string) => void,
    required = false,
  ) => {
    const error = form.fieldErrors[key];
    const id = fieldId(key);
    return (
      <div className={styles.field} key={key}>
        <label htmlFor={id} className={styles.label}>{label}</label>
        <input
          id={id}
          type="date"
          className={styles.control}
          value={value}
          disabled={readOnly}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => onChange(event.target.value)}
        />
        {error && <p id={`${id}-error`} className={styles.error}>{error}</p>}
      </div>
    );
  };

  return (
    <div className={styles.form}>
      <section className={styles.section} aria-labelledby={`${idPrefix}-main`}>
        <h3 id={`${idPrefix}-main`} className={styles.sectionTitle}>Основная оплата</h3>
        <div className={stacked ? `${styles.halves} ${styles.halvesStacked}` : styles.halves}>
          <div className={styles.half}>
            <div className={category === undefined ? `${styles.mainRow} ${styles.mainRowNoCategory}` : styles.mainRow}>
              {/* Категорию не выбирают: её ставит сервер по отделу сотрудника. */}
              {category !== undefined && (
                <div className={styles.field}>
                  <label htmlFor={fieldId('category')} className={styles.label}>Категория</label>
                  <input
                    id={fieldId('category')}
                    className={`${styles.control} ${styles.controlReadOnly}`}
                    value={category ? STAFF_CATEGORY_LABELS[category] : '—'}
                    readOnly
                  />
                </div>
              )}

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
                        autoFocus={autoFocus && !readOnly && form.calcType === key}
                        onChange={() => form.setCalcType(key)}
                      />
                      <span className={styles.segmentLabel}>{CALC_TYPE_LABELS[key]}</span>
                    </label>
                  ))}
                </div>
              </div>

              {renderDate('effectiveFrom', 'Действует с', form.effectiveFrom, form.setEffectiveFrom, true)}
            </div>
          </div>

          <div className={styles.half}>
            {/* Два отдельных поля: оклад (или ставка) и премия. Сохраняются раздельно. */}
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
        </div>
        {/* Таблица статей × месяцев шире половины — на всю ширину формы. */}
        {paid}
      </section>

      {paymentSections && (
        <>
          <section className={styles.section} aria-labelledby={`${idPrefix}-compensation`}>
            <h3 id={`${idPrefix}-compensation`} className={styles.sectionTitle}>Компенсация</h3>
            <div className={styles.halves}>
              <div className={styles.half}>
                <div className={styles.row}>
                  {COMPENSATION_FIELDS.map(({ field, label }) => renderMoney(
                    field,
                    label,
                    form.money[field],
                    value => form.changeMoney(field, value),
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Одна доплата на сотрудника: поля — последняя сохранённая, очистить и сохранить — снять. */}
          {form.plannedSupplement && (
            <section className={styles.section} aria-labelledby={`${idPrefix}-supplement-title`}>
              <h3 id={`${idPrefix}-supplement-title`} className={styles.sectionTitle}>Плановые доплаты</h3>
              <div className={styles.halves}>
                <div className={styles.half}>
                  <div className={styles.row}>
                    {renderMoney(
                      'supplementAmount',
                      'Сумма, ₽/мес',
                      form.supplement.amount,
                      value => form.changeSupplement('amount', value),
                    )}
                    {renderDate('supplementFrom', 'Дата начала', form.supplement.from, value => form.changeSupplement('from', value))}
                    {renderDate('supplementTo', 'Дата окончания', form.supplement.to, value => form.changeSupplement('to', value))}
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className={styles.section} aria-labelledby={`${idPrefix}-deduction-title`}>
            <h3 id={`${idPrefix}-deduction-title`} className={styles.sectionTitle}>Удержание</h3>
            <div className={styles.halves}>
              <div className={styles.half}>
                <div className={styles.row}>
                  {deductionKinds}
                  {renderMoney('deduction', 'Сумма, ₽/мес', form.money.deduction, value => form.changeMoney('deduction', value))}
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
