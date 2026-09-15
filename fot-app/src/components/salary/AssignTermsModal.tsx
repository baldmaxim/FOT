import { useState, type FC, type FormEvent } from 'react';

import {
  STAFF_CATEGORY_LABELS,
  CALC_TYPE_LABELS,
  type IAssignTermsPayload,
  type IPayrollTermsRow,
  type PayrollCalcType,
  type StaffCategory,
} from '../../services/payrollService';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import styles from './AssignTermsModal.module.css';

interface IAssignTermsModalProps {
  /** Один сотрудник — правка карточки; несколько — массовое назначение с общей датой. */
  rows: IPayrollTermsRow[];
  defaultDate: string;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (payload: IAssignTermsPayload) => void;
  resolveDefaultCalcType: (category: StaffCategory) => PayrollCalcType;
}

const toInputValue = (value: string | number | null | undefined): string => (
  value === null || value === undefined ? '' : String(value)
);

/** Необязательная сумма: пусто → undefined, некорректно или < 0 → null. */
const parseOptionalMoney = (raw: string): number | undefined | null => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const AssignTermsModal: FC<IAssignTermsModalProps> = ({
  rows,
  defaultDate,
  isSaving,
  onClose,
  onSubmit,
  resolveDefaultCalcType,
}) => {
  const single = rows.length === 1 ? rows[0] : null;

  const [category, setCategory] = useState<StaffCategory>(single?.staff_category ?? 'worker');
  const [calcType, setCalcType] = useState<PayrollCalcType>(
    single?.calc_type ?? resolveDefaultCalcType(single?.staff_category ?? 'worker'),
  );
  const [amount, setAmount] = useState<string>(() => {
    if (!single?.terms_id) return '';
    const value = single.calc_type === 'salary' ? single.monthly_salary : single.hourly_rate;
    return value === null || value === undefined ? '' : String(value);
  });
  const [bonus, setBonus] = useState(() => toInputValue(single?.terms_id ? single.bonus_amount : null));
  const [housing, setHousing] = useState(() => toInputValue(single?.terms_id ? single.housing_compensation : null));
  const [effectiveFrom, setEffectiveFrom] = useState(defaultDate);
  const [orderNumber, setOrderNumber] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const overlayHandlers = useOverlayDismiss(onClose);

  /**
   * Смена категории подставляет вид оплаты по умолчанию (Офис — оклад, стройка — часы),
   * но не запрещает выбрать другой: ИТР на окладе и офисный на часах — рабочие случаи.
   */
  const handleCategoryChange = (next: StaffCategory) => {
    setCategory(next);
    setCalcType(resolveDefaultCalcType(next));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(amount.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError(calcType === 'salary' ? 'Укажите оклад' : 'Укажите часовую ставку');
      return;
    }
    const bonusAmount = parseOptionalMoney(bonus);
    const housingCompensation = parseOptionalMoney(housing);
    if (bonusAmount === null || housingCompensation === null) {
      setError('Премиальная часть и компенсация проживания — число не меньше нуля');
      return;
    }
    setError(null);
    onSubmit({
      staff_category: category,
      calc_type: calcType,
      monthly_salary: calcType === 'salary' ? parsed : undefined,
      hourly_rate: calcType === 'hourly' ? parsed : undefined,
      bonus_amount: bonusAmount,
      housing_compensation: housingCompensation,
      effective_from: effectiveFrom,
      order_number: orderNumber.trim() || undefined,
      order_date: orderDate || undefined,
      change_reason: reason.trim() || undefined,
    });
  };

  return (
    <div className={styles.overlay} {...overlayHandlers}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <h2 className={styles.title}>
          {single ? 'Условия оплаты' : `Условия оплаты: ${rows.length} сотрудников`}
        </h2>
        {single && <p className={styles.subtitle}>{single.full_name}</p>}

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>Категория</span>
            <select
              className={styles.input}
              value={category}
              onChange={event => handleCategoryChange(event.target.value as StaffCategory)}
            >
              {(Object.keys(STAFF_CATEGORY_LABELS) as StaffCategory[]).map(key => (
                <option key={key} value={key}>{STAFF_CATEGORY_LABELS[key]}</option>
              ))}
            </select>
          </label>

          <fieldset className={styles.radioGroup}>
            <legend className={styles.label}>Вид оплаты</legend>
            {(Object.keys(CALC_TYPE_LABELS) as PayrollCalcType[]).map(key => (
              <label key={key} className={styles.radio}>
                <input
                  type="radio"
                  name="calc_type"
                  value={key}
                  checked={calcType === key}
                  onChange={() => setCalcType(key)}
                />
                <span>{CALC_TYPE_LABELS[key]}</span>
              </label>
            ))}
          </fieldset>

          <label className={styles.field}>
            <span className={styles.label}>
              {calcType === 'salary' ? 'Оклад, ₽/мес' : 'Часовая ставка, ₽/час'}
            </span>
            <input
              className={styles.input}
              inputMode="decimal"
              value={amount}
              onChange={event => setAmount(event.target.value)}
              placeholder={calcType === 'salary' ? '175000' : '450'}
            />
          </label>

          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>Премиальная часть, ₽/мес</span>
              <input
                className={styles.input}
                inputMode="decimal"
                value={bonus}
                onChange={event => setBonus(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Компенсация проживания, ₽/мес</span>
              <input
                className={styles.input}
                inputMode="decimal"
                value={housing}
                onChange={event => setHousing(event.target.value)}
              />
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.label}>Действует с</span>
            <input
              type="date"
              className={styles.input}
              value={effectiveFrom}
              onChange={event => setEffectiveFrom(event.target.value)}
              required
            />
          </label>

          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>Приказ №</span>
              <input
                className={styles.input}
                value={orderNumber}
                onChange={event => setOrderNumber(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Дата приказа</span>
              <input
                type="date"
                className={styles.input}
                value={orderDate}
                onChange={event => setOrderDate(event.target.value)}
              />
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.label}>Основание</span>
            <input
              className={styles.input}
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="Например: перевод на почасовую оплату"
            />
          </label>

          <p className={styles.hint}>
            Условия действуют с указанной даты. Прошлые расчёты не пересчитываются:
            прежние условия сохраняются в истории.
          </p>

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.footer}>
            <button type="button" className={styles.secondaryButton} onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className={styles.primaryButton} disabled={isSaving}>
              {isSaving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
