import type { FC, ReactNode } from 'react';

import {
  CALC_TYPE_LABELS,
  PRORATION_ROUNDING_LABELS,
  STAFF_CATEGORY_LABELS,
  type PayrollCalcType,
  type ProrationRounding,
  type StaffCategory,
} from '../../services/payrollService';
import type { PayrollTermsFormApi } from '../../hooks/usePayrollTermsForm';
import { formatDate } from '../../utils/formatMoney';
import { formatPaidAmount } from '../../utils/payrollPaid';
import { formatPayrollMoney, formatPayrollRubles } from '../../utils/payrollFormat';
import {
  payrollFieldId,
  payrollTermsTotal,
  type PayrollTermsFieldKey,
} from '../../utils/payrollTermsForm';
import styles from './PayrollTermsFields.module.css';

interface IPayrollTermsFieldsProps {
  form: PayrollTermsFormApi;
  /** Префикс id полей: по нему карточка и окно ставят фокус на первое поле с ошибкой. */
  idPrefix: string;
  /** Только просмотр: поля заблокированы. */
  readOnly?: boolean;
  /** Категория сотрудника — по табелю (сервер), только для чтения. */
  category: StaffCategory;
  /** «Итого, ₽/мес» — сумма оклада и премии в их строке (только в окне сотрудника). */
  total?: boolean;
  /** Фокус на выбранный «Вид оплаты» при открытии карточки или окна. */
  autoFocus?: boolean;
  /** Блок «Оплачено» под окладом и премией, на всю ширину формы; не передан — блока нет. */
  paid?: ReactNode;
  /** «Основная оплата» в одну колонку: сумма и премия — под «Категорией · Видом оплаты · Действует с». */
  stacked?: boolean;
  /**
   * «Удержание» — удержания сотрудника (вид, подвид, месяц, сумма; только чтение — вносят в «Справочнике» и у кадров,
   * миграция 321). Не передан — секции нет.
   */
  staffDeductions?: ReactNode;
  /**
   * Вкладка «Подробно» — только просмотр: в «Основной оплате» Категория, действующие оклад, премия, итого и
   * «Оплачено» текстом; секций Компенсация, Плановые доплаты, Удержание нет. Условия вносят в окне сотрудника
   * на «Расчётах».
   */
  detailsOnly?: boolean;
  /** «Проезд» в «Компенсации» — значение ставки, если положен (travelAllowance), как в поле ввода; нет — пусто. */
  travel?: string;
  /** «Подробно»: с какой даты действуют показанные условия; null — условий нет, «Действует с» не показываем. */
  termsFrom?: string | null;
}

/** Сумма текстом «195 000,00 ₽/мес»; пусто — «—» без единицы. */
const formatTermsMoney = (value: string | number | null, unit: string): string => {
  const money = formatPayrollMoney(value);
  return money === null ? '—' : `${money} ${unit}`;
};

/** Оклад, премия и итого в «Подробно»: «250 000 ₽», копейки — только если есть. */
const formatTermsRubles = (value: string | number | null): string => formatPayrollRubles(value) ?? '—';

const CALC_TYPES = Object.keys(CALC_TYPE_LABELS) as PayrollCalcType[];
const PRORATION_ROUNDINGS = Object.keys(PRORATION_ROUNDING_LABELS) as ProrationRounding[];

/**
 * Форма условий оплаты. Секции — две половины: слева Категория (только чтение) · Вид оплаты · Действует с,
 * компенсации, плановая доплата (только в карточке сотрудника) и удержание; справа оклад (или ставка) с премией.
 * «Оплачено» (только в «Подробно») — под ними на всю ширину формы. В узком окне и при stacked половины встают
 * друг под друга, на телефоне поля — в столбик (container queries). Ошибки — под своим полем.
 * detailsOnly («Подробно») — Категория, действующие оклад · премия · итого и «Оплачено».
 */
export const PayrollTermsFields: FC<IPayrollTermsFieldsProps> = ({
  form,
  idPrefix,
  readOnly = false,
  category,
  autoFocus = false,
  paid,
  stacked = false,
  staffDeductions,
  detailsOnly = false,
  total = false,
  travel = '',
  termsFrom = null,
}) => {
  const fieldId = (key: PayrollTermsFieldKey | 'category') => payrollFieldId(idPrefix, key);
  const travelId = `${idPrefix}-travel`;
  const totalValue = total ? payrollTermsTotal(form) : null;

  /** Денежное поле с подписью сверху и ошибкой снизу. Без числовых подсказок: подсказка — не значение. */
  const renderMoney = (
    key: PayrollTermsFieldKey,
    label: string,
    value: string,
    onChange: (next: string) => void,
    locked = false,
  ) => {
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
          disabled={readOnly || locked}
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
            <div className={styles.mainRow}>
              {/* Категория — по табелю, её ставит сервер; выбора нет. */}
              {/* «Подробно» — одной строкой текстом: значение короткое, широкое поле ни к чему. */}
              {detailsOnly && (
                <p className={styles.inlineField}>
                  <span className={styles.label}>Категория:</span>
                  {' '}
                  <span className={styles.inlineValue}>{STAFF_CATEGORY_LABELS[category]}</span>
                </p>
              )}
              {!detailsOnly && (
                <div className={styles.field}>
                  <label htmlFor={fieldId('category')} className={styles.label}>Категория</label>
                  <input
                    id={fieldId('category')}
                    className={`${styles.control} ${styles.controlReadOnly}`}
                    value={STAFF_CATEGORY_LABELS[category]}
                    readOnly
                  />
                </div>
              )}

              {!detailsOnly && (
                <>
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

                  {/* Как ЗУП округляет оклад за неполный месяц — для «К выплате (ФОТ)». */}
                  {form.calcType === 'salary' && (
                    <div className={styles.field}>
                      <span id={`${idPrefix}-rounding`} className={styles.label}>Округление оклада</span>
                      <div
                        role="radiogroup"
                        aria-labelledby={`${idPrefix}-rounding`}
                        className={readOnly ? `${styles.segmented} ${styles.segmentedDisabled}` : styles.segmented}
                      >
                        {PRORATION_ROUNDINGS.map(key => (
                          <label key={key} className={styles.segment}>
                            <input
                              type="radio"
                              className={styles.segmentInput}
                              name={`${idPrefix}-rounding`}
                              value={key}
                              checked={form.prorationRounding === key}
                              disabled={readOnly}
                              onChange={() => form.setProrationRounding(key)}
                            />
                            <span className={styles.segmentLabel}>{PRORATION_ROUNDING_LABELS[key]}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {renderDate('effectiveFrom', 'Действует с', form.effectiveFrom, form.setEffectiveFrom, true)}
                </>
              )}
            </div>

            {/* «Подробно» — действующие условия текстом, как «Категория»; форма здесь не меняется. */}
            {detailsOnly && (
              <dl className={styles.termsSummary}>
                <div>
                  <dt className={styles.label}>{form.calcType === 'salary' ? 'Оклад:' : 'Часовая ставка:'}</dt>
                  {' '}
                  <dd className={styles.inlineValue}>
                    {form.calcType === 'salary' ? formatTermsRubles(form.amount) : formatTermsMoney(form.amount, '₽/час')}
                  </dd>
                </div>
                <div>
                  <dt className={styles.label}>Премиальная часть:</dt>
                  {' '}
                  <dd className={styles.inlineValue}>{formatTermsRubles(form.money.bonus)}</dd>
                </div>
                <div>
                  <dt className={styles.label}>Итого:</dt>
                  {' '}
                  <dd className={styles.inlineValue}>{formatTermsRubles(totalValue)}</dd>
                </div>
                {termsFrom && (
                  <div>
                    <dt className={styles.label}>Действует с</dt>
                    {' '}
                    <dd className={styles.inlineValue}>{formatDate(termsFrom)}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>

          {!detailsOnly && (
            <div className={styles.half}>
              {/* Два отдельных поля: оклад (или ставка) и премия. Сохраняются раздельно; «Итого» — их сумма. */}
              <div className={total ? `${styles.pair} ${styles.pairWithTotal}` : styles.pair}>
                {renderMoney(
                  'amount',
                  form.calcType === 'salary' ? 'Оклад, ₽/мес' : 'Часовая ставка, ₽/час',
                  form.amount,
                  form.setAmount,
                )}
                {renderMoney('bonus', 'Премиальная часть, ₽/мес', form.money.bonus, value => form.changeMoney('bonus', value))}
                {total && (
                  <div className={styles.field}>
                    <label htmlFor={`${idPrefix}-total`} className={styles.label}>Итого, ₽/мес</label>
                    <input
                      id={`${idPrefix}-total`}
                      className={`${styles.control} ${styles.controlReadOnly}`}
                      value={totalValue === null ? '—' : formatPaidAmount(totalValue)}
                      readOnly
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {/* Таблица статей × месяцев шире половины — на всю ширину формы. */}
        {paid}
      </section>

      {!detailsOnly && (
        <>
          <section className={styles.section} aria-labelledby={`${idPrefix}-compensation`}>
            <h3 id={`${idPrefix}-compensation`} className={styles.sectionTitle}>Компенсация</h3>
            <div className={styles.halves}>
              <div className={styles.half}>
                {/*
                  Только показ. Проживание — квартира «Проживания» (миграция 320): вносят в «Доплате за проживание»
                  и во вкладке кадров. Проезд — ставка «Проезд» «Справочника» (миграция 324): всем, кроме «Рабочих»
                  и «Без проезда».
                */}
                <div className={styles.row}>
                  {renderMoney(
                    'housing',
                    'Проживание, ₽/мес',
                    form.money.housing,
                    value => form.changeMoney('housing', value),
                    true,
                  )}
                  <div className={styles.field}>
                    <label htmlFor={travelId} className={styles.label}>Проезд, ₽/мес</label>
                    <input id={travelId} className={styles.control} value={travel} disabled readOnly />
                  </div>
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

          {staffDeductions && (
            <section className={styles.section} aria-labelledby={`${idPrefix}-deduction-title`}>
              <h3 id={`${idPrefix}-deduction-title`} className={styles.sectionTitle}>Удержание</h3>
              {staffDeductions}
            </section>
          )}
        </>
      )}
    </div>
  );
};
