import { useId, useMemo, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import type {
  IPlannedDeduction,
  IPlannedDeductionPayload,
  IStaffDeductionKind,
} from '../../../services/staffDeductionService';
import { formatMonthLabel } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { rateAmountInputValue } from '../../../utils/payrollDictionary';
import {
  amountAfterKindChange,
  deductionDefaultAmount,
  monthForDismissed,
  monthToAfterFromChange,
  parsePlannedDeduction,
  plannedFromMonthOptions,
  plannedLastMonthAllowed,
  plannedToMonthOptions,
  withKeptKind,
  type PlannedDeductionField,
} from '../../../utils/staffDeductionForm';
import { ClearableInput } from '../../ui/ClearableInput';
import { EmployeeSearchField, type IEmployeeSearchCandidate } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';
import { DeductionKindFields } from './DeductionKindFields';

/** Кандидат «Добавить сотрудника»: can_edit false — неактивен; dismissal_date — уволен (начало не позже увольнения). */
type PlannedCandidate = IEmployeeSearchCandidate & { can_edit?: boolean; dismissal_date?: string | null };

/** Где правят плановое: кадры или «Зарплата» — те же записи, у разделов свои поиск, права и охват. */
export interface IPlannedDeductionEditorApi {
  searchEmployees: (term: string, signal: AbortSignal) => Promise<PlannedCandidate[]>;
  add: (employeeId: number, payload: IPlannedDeductionPayload) => Promise<unknown>;
  update: (row: Pick<IPlannedDeduction, 'id' | 'updated_at'>, payload: IPlannedDeductionPayload) => Promise<unknown>;
}

interface IPlannedDeductionFormProps {
  /** Передано — правка этого планового (сотрудник не меняется); нет — добавление. */
  deduction?: IPlannedDeduction;
  kinds: readonly IStaffDeductionKind[];
  api: IPlannedDeductionEditorApi;
  /** Поверх другого окна («Справочник» «Зарплаты»). */
  raised?: boolean;
  onClose: () => void;
  /** После сохранения и после отказа «уже изменили» — таблицы перечитываются. */
  onSaved: () => void;
}

const isNotEditable = (candidate: PlannedCandidate): boolean => candidate.can_edit === false;

/**
 * «Добавить сотрудника» и ✎ на вкладке «Плановые удержания» (кадры и «Справочник» «Зарплаты», миграция 357):
 * сотрудник, вид, подвид, сумма ₽/мес, «С месяца» и «По месяц» (пусто — бессрочно). В каждом месяце периода
 * удерживается вся сумма; галочка «Другая сумма в последнем месяце» (миграция 362) — в месяце «По месяц» своя сумма.
 * Галочка видна всегда (иначе её не найти при «Бессрочно» по умолчанию), но ставится, только если «По месяц» позже
 * «С месяца»; иначе нажатие показывает подсказку. Ошибка сервера (пересечение, «уже изменили») — под полями, ввод не
 * теряется.
 */
export const PlannedDeductionForm: FC<IPlannedDeductionFormProps> = ({ deduction, kinds, api, raised, onClose, onSaved }) => {
  const errorId = useId();
  const lastMonthHintId = useId();
  const isEdit = deduction !== undefined;
  const [currentMonth] = useState(() => moscowTodayIso().slice(0, 7));
  const [employee, setEmployee] = useState<PlannedCandidate | null>(null);
  const [kindId, setKindId] = useState<number | null>(deduction?.kind_id ?? null);
  const [subkindId, setSubkindId] = useState<number | null>(deduction?.subkind_id ?? null);
  const [amount, setAmount] = useState(rateAmountInputValue(deduction?.amount));
  const [monthFrom, setMonthFrom] = useState(deduction?.month_from ?? currentMonth);
  const [monthTo, setMonthTo] = useState(deduction?.month_to ?? '');
  const [lastMonth, setLastMonth] = useState(deduction?.last_month_amount != null);
  const [lastMonthAmount, setLastMonthAmount] = useState(rateAmountInputValue(deduction?.last_month_amount));
  /** Нажали галочку при периоде без последнего месяца — подсказка; смена месяцев её прячет. */
  const [lastMonthHint, setLastMonthHint] = useState(false);
  const [error, setError] = useState<{ field: PlannedDeductionField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const kindOptions = useMemo(() => withKeptKind(kinds, deduction), [kinds, deduction]);
  const fromOptions = useMemo(
    () => plannedFromMonthOptions(currentMonth, deduction?.month_from),
    [currentMonth, deduction?.month_from],
  );
  const toOptions = useMemo(
    () => plannedToMonthOptions(monthFrom, currentMonth, deduction?.month_to),
    [monthFrom, currentMonth, deduction?.month_to],
  );

  const lastMonthAllowed = plannedLastMonthAllowed(monthFrom, monthTo);

  const clearError = () => setError(null);
  const invalid = (field: PlannedDeductionField): true | undefined => (error?.field === field ? true : undefined);

  /** Смена вида или подвида: сумму по умолчанию подставляем, введённую руками — не трогаем. */
  const changeSelection = (nextKindId: number | null, nextSubkindId: number | null) => {
    const previousDefault = deductionDefaultAmount(kindOptions, kindId, subkindId);
    const nextDefault = deductionDefaultAmount(kindOptions, nextKindId, nextSubkindId);
    setAmount(current => amountAfterKindChange(current, previousDefault, nextDefault));
    setKindId(nextKindId);
    setSubkindId(nextSubkindId);
    clearError();
  };

  const changeMonthFrom = (value: string) => {
    setMonthFrom(value);
    setMonthTo(current => monthToAfterFromChange(current, value));
    setLastMonthHint(false);
    clearError();
  };

  const changeLastMonth = (checked: boolean) => {
    if (!lastMonthAllowed) {
      setLastMonthHint(true);
      return;
    }
    setLastMonth(checked);
    clearError();
  };

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parsePlannedDeduction({
      selected: isEdit || employee !== null, kindId, subkindId, amount, monthFrom, monthTo, lastMonth, lastMonthAmount,
    });
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) await api.update(deduction, parsed.payload);
      else await api.add(employee!.id, parsed.payload);
      onSaved();
      requestClose();
    } catch (err) {
      // Строку изменили в соседнем окне — таблицы перечитываются, ввод остаётся.
      if (err instanceof ApiError && err.code === 'PLANNED_DEDUCTION_STALE') onSaved();
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? 'Плановое удержание' : 'Добавить сотрудника'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error?.message ?? null}
      errorId={errorId}
      raised={raised}
    >
      <div className={styles.field}>
        <span className={styles.label}>Сотрудник</span>
        {isEdit ? (
          <div className={styles.fixed}>
            {/* Одним элементом: во flex-контейнере пробел перед «—» у отдельного span пропал бы. */}
            <span>
              {deduction.full_name}
              {deduction.department && <span className={styles.muted}> — {deduction.department}</span>}
            </span>
          </div>
        ) : (
          <EmployeeSearchField
            value={employee}
            onChange={value => {
              setEmployee(value);
              if (value) changeMonthFrom(monthForDismissed(monthFrom, value.dismissal_date));
              clearError();
            }}
            search={api.searchEmployees}
            isDisabled={isNotEditable}
            disabled={saving}
            invalid={error?.field === 'employee'}
          />
        )}
      </div>

      <DeductionKindFields
        kinds={kindOptions}
        kindId={kindId}
        subkindId={subkindId}
        onChange={changeSelection}
        disabled={saving}
        kindInvalid={error?.field === 'kind'}
        describedBy={error ? errorId : undefined}
      />

      <label className={styles.field}>
        <span className={styles.label}>Сумма, ₽/мес</span>
        <ClearableInput
          value={amount}
          onValueChange={value => { setAmount(value); clearError(); }}
          inputMode="decimal"
          autoComplete="off"
          disabled={saving}
          aria-invalid={invalid('amount')}
          aria-describedby={error ? errorId : undefined}
          clearLabel="Очистить сумму"
        />
      </label>

      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>С месяца</span>
          <select
            className={styles.select}
            value={monthFrom}
            onChange={event => changeMonthFrom(event.target.value)}
            disabled={saving}
            aria-invalid={invalid('month_from')}
          >
            {fromOptions.map(option => (
              <option key={option} value={option}>{formatMonthLabel(option)}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>По месяц</span>
          <select
            className={styles.select}
            value={monthTo}
            onChange={event => { setMonthTo(event.target.value); setLastMonthHint(false); clearError(); }}
            disabled={saving}
            aria-invalid={invalid('month_to')}
          >
            <option value="">Бессрочно</option>
            {toOptions.map(option => (
              <option key={option} value={option}>{formatMonthLabel(option)}</option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.field}>
        <label className={styles.check}>
          {/* aria-disabled, а не disabled: нажатие при «Бессрочно» должно дойти и показать подсказку. */}
          <input
            type="checkbox"
            checked={lastMonth && lastMonthAllowed}
            onChange={event => changeLastMonth(event.target.checked)}
            disabled={saving}
            aria-disabled={lastMonthAllowed ? undefined : true}
            aria-describedby={lastMonthHint && !lastMonthAllowed ? lastMonthHintId : undefined}
          />
          <span>Другая сумма в последнем месяце</span>
        </label>
        {lastMonthHint && !lastMonthAllowed && (
          <p id={lastMonthHintId} className={styles.hint}>Выберите «По месяц» позже «С месяца»</p>
        )}
      </div>
      {lastMonthAllowed && lastMonth && (
        <label className={styles.field}>
          <span className={styles.label}>Сумма за {formatMonthLabel(monthTo)}, ₽</span>
          <ClearableInput
            value={lastMonthAmount}
            onValueChange={value => { setLastMonthAmount(value); clearError(); }}
            inputMode="decimal"
            autoComplete="off"
            disabled={saving}
            aria-invalid={invalid('last_month_amount')}
            aria-describedby={error ? errorId : undefined}
            clearLabel="Очистить сумму в последнем месяце"
          />
        </label>
      )}
    </RegistryFormModal>
  );
};
