import { useId, useMemo, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import type {
  IStaffDeduction,
  IStaffDeductionKind,
  IStaffDeductionPayload,
} from '../../../services/staffDeductionService';
import { formatMonthLabel } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { rateAmountInputValue } from '../../../utils/payrollDictionary';
import { oneTimeMonthOptions } from '../../../utils/payrollRegistryForms';
import {
  amountAfterKindChange,
  deductionDefaultAmount,
  parseStaffDeduction,
  type StaffDeductionField,
} from '../../../utils/staffDeductionForm';
import { ClearableInput } from '../../ui/ClearableInput';
import { EmployeeSearchField, type IEmployeeSearchCandidate } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

/** Кандидат «Добавить сотрудника»; can_edit false — строка неактивна (нет права на сотрудника). */
type DeductionCandidate = IEmployeeSearchCandidate & { can_edit?: boolean };

/** Где правят удержание: кадры или «Зарплата» — те же записи, у каждого раздела свои поиск, права и охват. */
export interface IStaffDeductionEditorApi {
  searchEmployees: (term: string, signal: AbortSignal) => Promise<DeductionCandidate[]>;
  add: (employeeId: number, payload: IStaffDeductionPayload) => Promise<unknown>;
  update: (deductionId: number, payload: IStaffDeductionPayload) => Promise<unknown>;
}

interface IStaffDeductionModalProps {
  /** Передано — правка этого удержания (сотрудник не меняется); нет — добавление. */
  deduction?: IStaffDeduction;
  /** Виды с подвидами — списки «Вид удержания» и «Подвид», суммы по умолчанию. */
  kinds: readonly IStaffDeductionKind[];
  api: IStaffDeductionEditorApi;
  /** Поверх другого окна («Справочник» «Зарплаты»). */
  raised?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const isNotEditable = (candidate: DeductionCandidate): boolean => candidate.can_edit === false;

/**
 * «Добавить сотрудника» и ✎ удержания — во вкладке кадров «Удержания» и в «Справочнике» → «Удержания» «Зарплаты»:
 * сотрудник (поиск по ФИО), вид, подвид (список — если у вида есть подвиды; можно «Без подвида»), месяц удержания
 * и сумма — выбор вида или подвида подставляет сумму по умолчанию (подвида, иначе вида). Ошибка сервера — под
 * полями, ввод не теряется.
 */
export const StaffDeductionModal: FC<IStaffDeductionModalProps> = ({ deduction, kinds, api, raised, onClose, onSaved }) => {
  const errorId = useId();
  const isEdit = deduction !== undefined;
  const [employee, setEmployee] = useState<DeductionCandidate | null>(null);
  const [kindId, setKindId] = useState<number | null>(deduction?.kind_id ?? null);
  const [subkindId, setSubkindId] = useState<number | null>(deduction?.subkind_id ?? null);
  const currentMonth = moscowTodayIso().slice(0, 7);
  const [month, setMonth] = useState(deduction?.month ?? currentMonth);
  const [amount, setAmount] = useState(rateAmountInputValue(deduction?.amount));
  const [error, setError] = useState<{ field: StaffDeductionField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Месяц правки мог уйти за пределы списка — оставляем его выбранным.
  const editMonth = deduction?.month ?? null;
  const monthOptions = useMemo(() => {
    const options = oneTimeMonthOptions(currentMonth);
    return editMonth && !options.includes(editMonth) ? [...options, editMonth] : options;
  }, [currentMonth, editMonth]);

  // Вид или подвид правки могли удалить из справочника — оставляем их в списках, сервер ответит понятной ошибкой.
  const kindOptions = useMemo(() => {
    if (!deduction) return kinds;
    const kept = kinds.find(kind => kind.id === deduction.kind_id)
      ?? { id: deduction.kind_id, name: deduction.kind_name, default_amount: null, subkinds: [] };
    const subkinds = deduction.subkind_id === null || deduction.subkind_name === null
      || kept.subkinds.some(subkind => subkind.id === deduction.subkind_id)
      ? kept.subkinds
      : [...kept.subkinds, { id: deduction.subkind_id, kind_id: deduction.kind_id, name: deduction.subkind_name, default_amount: null }];
    const patched = { ...kept, subkinds };
    return kinds.some(kind => kind.id === kept.id)
      ? kinds.map(kind => (kind.id === kept.id ? patched : kind))
      : [...kinds, patched];
  }, [kinds, deduction]);
  const subkindOptions = kindOptions.find(kind => kind.id === kindId)?.subkinds ?? [];

  const clearError = () => setError(null);
  const invalid = (field: StaffDeductionField): true | undefined => (error?.field === field ? true : undefined);

  /** Смена вида или подвида: сумму по умолчанию подставляем, введённую руками — не трогаем. */
  const changeSelection = (nextKindId: number | null, nextSubkindId: number | null) => {
    const previousDefault = deductionDefaultAmount(kindOptions, kindId, subkindId);
    const nextDefault = deductionDefaultAmount(kindOptions, nextKindId, nextSubkindId);
    setAmount(current => amountAfterKindChange(current, previousDefault, nextDefault));
    setKindId(nextKindId);
    setSubkindId(nextSubkindId);
    clearError();
  };

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parseStaffDeduction({ selected: isEdit || employee !== null, kindId, subkindId, month, amount });
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) await api.update(deduction.id, parsed.payload);
      else await api.add(employee!.id, parsed.payload);
      onSaved();
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? 'Удержание' : 'Добавить сотрудника'}
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
            onChange={value => { setEmployee(value); clearError(); }}
            search={api.searchEmployees}
            isDisabled={isNotEditable}
            disabled={saving}
            invalid={error?.field === 'employee'}
          />
        )}
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Вид удержания</span>
        <select
          className={styles.select}
          value={kindId ?? ''}
          onChange={event => changeSelection(event.target.value ? Number(event.target.value) : null, null)}
          disabled={saving}
          aria-invalid={invalid('kind')}
          aria-describedby={error ? errorId : undefined}
        >
          <option value="" disabled>Выберите вид</option>
          {kindOptions.map(kind => (
            <option key={kind.id} value={kind.id}>{kind.name}</option>
          ))}
        </select>
      </label>

      {subkindOptions.length > 0 && (
        <label className={styles.field}>
          <span className={styles.label}>Подвид</span>
          <select
            className={styles.select}
            value={subkindId ?? ''}
            onChange={event => changeSelection(kindId, event.target.value ? Number(event.target.value) : null)}
            disabled={saving}
          >
            <option value="">Без подвида</option>
            {subkindOptions.map(subkind => (
              <option key={subkind.id} value={subkind.id}>{subkind.name}</option>
            ))}
          </select>
        </label>
      )}

      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>Месяц</span>
          <select
            className={styles.select}
            value={month}
            onChange={event => { setMonth(event.target.value); clearError(); }}
            disabled={saving}
            aria-invalid={invalid('month')}
          >
            {monthOptions.map(option => (
              <option key={option} value={option}>{formatMonthLabel(option)}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Сумма, ₽</span>
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
      </div>
    </RegistryFormModal>
  );
};
