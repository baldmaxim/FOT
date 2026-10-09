import { useEffect, useId, useMemo, useRef, useState, type FC, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  payrollService,
  type IAssignTermsPayload,
  type IPayrollTermsRow,
} from '../../services/payrollService';
import { usePayrollEmployeeDeductions } from '../../hooks/usePayrollEmployeeDeductions';
import { usePayrollPaid } from '../../hooks/usePayrollPaid';
import { usePayrollTermsForm } from '../../hooks/usePayrollTermsForm';
import { moscowCurrentMonth, shiftMonth } from '../../utils/moscowDate';
import { payrollMonthOptions } from '../../utils/payrollAccruals';
import { payrollFieldId, payrollRowCategory } from '../../utils/payrollTermsForm';
import { MonthsPicker } from '../ui/MonthsPicker';
import { DeductionKindsField } from './DeductionKindsField';
import { PayrollPaidTable } from './PayrollPaidTable';
import { PayrollTermsFields } from './PayrollTermsFields';
import { EmployeeVacationSection } from './EmployeeVacationSection';
import { SalaryHistorySection } from './SalaryHistorySection';
import styles from './EmployeePayrollDetails.module.css';

interface IEmployeePayrollDetailsProps {
  row: IPayrollTermsRow;
  defaultDate: string;
  /**
   * Окно сотрудника на «Расчётах» (true): условия, компенсация, плановая доплата и удержание вносятся и сохраняются.
   * Вкладка «Подробно» (false) — только просмотр: Категория, «Оплачено», история, отпуска; кнопок нет.
   */
  editable?: boolean;
  /** Класс корня: в окне «Расчётов» — без своей рамки. */
  className?: string;
  /** Вкладка «Подробно» открыта. Скрытая карточка остаётся смонтированной — введённое не теряется. */
  active: boolean;
  /** «Отмена» / «Закрыть» (только editable): карточка закрывается. */
  onClose?: () => void;
  /**
   * Условия сохранены (только editable). onScreen — карточка ещё на экране; иначе её успели закрыть
   * или открыли другого сотрудника — только закрыть устаревшую карточку этого.
   */
  onSaved?: (employeeId: number, onScreen: boolean) => void;
}

interface ISaveVariables {
  /** null — условия не правили: новую версию условий не создаём. */
  terms: IAssignTermsPayload | null;
  /** Виды удержаний; null — не меняли. */
  kinds: number[] | null;
}

/**
 * Карточка сотрудника раздела «Зарплата» — окно на «Расчётах» (editable) и вкладка «Подробно» (только просмотр).
 * В окне: условия оплаты (вид оплаты, оклад, премия) с «Оплачено», компенсация, плановая доплата, удержание; «Сохранить»
 * пишет условия и виды удержаний — что из них правили. В «Подробно»: Категория и «Оплачено», без полей и кнопок.
 * Ниже — свёрнутая справка: история изменений и отпуска; грузится отдельно, её ошибки форму не блокируют.
 * «Оплачено» — только чтение: суммы приходят из 1С. Категория — по отделу, в окне её можно сменить (сохраняется с условиями).
 * Месяцы у ФИО (один или несколько) задают таблицы «Оплачено»; условия от них не зависят.
 */
export const EmployeePayrollDetails: FC<IEmployeePayrollDetailsProps> = ({
  row,
  defaultDate,
  editable = false,
  className,
  active,
  onClose,
  onSaved,
}) => {
  const { canEditPage } = useAuth();
  const { success, error: showError } = useToast();
  const queryClient = useQueryClient();
  const titleId = useId();
  const idPrefix = useId();
  const nameRef = useRef<HTMLHeadingElement>(null);
  // Право на страницу и скоуп правки этого сотрудника (can_edit нет у старого бэкенда — решит сервер).
  const canEdit = editable && canEditPage('/salary/terms') && row.can_edit !== false;
  const form = usePayrollTermsForm({ row, defaultDate, plannedSupplement: editable });
  // «Сегодня» — на момент открытия карточки: defaultDate фиксируется при входе в раздел и через
  // границу месяца без перезагрузки устарел бы. По умолчанию — прошлый, уже закрытый месяц.
  const [currentMonth] = useState(moscowCurrentMonth);
  const [months, setMonths] = useState<string[]>(() => [shiftMonth(currentMonth, -1)]);
  // Выбор месяцев ждёт окно по возрастанию; payrollMonthOptions отдаёт от текущего назад.
  const monthOptions = useMemo(() => [...payrollMonthOptions(currentMonth)].reverse(), [currentMonth]);
  const paid = usePayrollPaid(row.employee_id, months);
  const deductions = usePayrollEmployeeDeductions(row.employee_id, editable);
  const meta = [row.department_name, row.position_name].filter(Boolean).join(' · ');

  // Ответ сервера приходит позже клика: к этому времени вкладку могли сменить, а карточку — закрыть.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
    return () => { activeRef.current = false; };
  }, [active]);

  const saveMutation = useMutation({
    // Сначала виды: запрос идемпотентен — если условия не сохранятся, повтор ничего не задвоит.
    mutationFn: async ({ terms, kinds }: ISaveVariables) => {
      if (kinds) await payrollService.saveEmployeeDeductions(row.employee_id, kinds);
      if (terms) await payrollService.assign(row.employee_id, terms);
    },
    onSuccess: (_data, { terms }) => {
      // Префикс сбрасывает список, «Расчёты», историю изменений условий, «Оплачено» и виды удержаний.
      queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      success(terms ? 'Условия оплаты назначены: 1' : 'Удержания сохранены');
      onSaved?.(row.employee_id, activeRef.current);
    },
    // Ошибку показывает карточка (ввод не теряется). Тост — если карточки на экране уже нет.
    onError: (err: Error) => {
      if (!activeRef.current) showError(err.message || 'Не удалось назначить условия');
    },
  });
  const saveError = saveMutation.isError
    ? (saveMutation.error?.message || 'Не удалось назначить условия')
    : null;

  // В режиме просмотра полей для ввода нет — фокус на ФИО, чтобы Tab шёл по карточке.
  useEffect(() => {
    if (!canEdit) nameRef.current?.focus();
  }, [canEdit]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit || saveMutation.isPending) return;
    const kinds = deductions.changedKindIds();
    // Правили только виды удержаний: условия не трогаем — оклад не обязателен, новая версия не создаётся.
    if (kinds && !form.isChanged()) {
      saveMutation.mutate({ terms: null, kinds });
      return;
    }
    const { payload, firstInvalid } = form.buildPayload();
    if (!payload) {
      if (firstInvalid) document.getElementById(payrollFieldId(idPrefix, firstInvalid))?.focus();
      return;
    }
    saveMutation.mutate({ terms: payload, kinds });
  };

  return (
    <form
      className={className ? `${styles.details} ${className}` : styles.details}
      onSubmit={handleSubmit}
      noValidate
      aria-labelledby={titleId}
    >
      <header className={styles.header}>
        <div className={styles.nameRow}>
          <h2 ref={nameRef} id={titleId} className={styles.name} tabIndex={-1}>{row.full_name ?? 'Сотрудник'}</h2>
          <MonthsPicker
            value={months}
            options={monthOptions}
            onChange={setMonths}
            allowAll={false}
            ariaLabel="Месяцы «Оплачено»"
            className={styles.monthsTrigger}
          />
        </div>
        {meta && <p className={styles.meta}>{meta}</p>}
      </header>

      <div className={styles.body}>
        {editable && !canEdit && (
          <p className={styles.readOnlyNote}>Только просмотр: нет права менять условия этого сотрудника.</p>
        )}
        <PayrollTermsFields
          form={form}
          idPrefix={idPrefix}
          readOnly={!canEdit}
          category={payrollRowCategory(row)}
          autoFocus={canEdit}
          paid={<PayrollPaidTable paid={paid} idPrefix={idPrefix} />}
          stacked
          detailsOnly={!editable}
          total
          deductionKinds={(
            <DeductionKindsField id={`${idPrefix}-deduction-kinds`} deductions={deductions} readOnly={!canEdit} />
          )}
        />

        <div className={styles.reference}>
          <SalaryHistorySection employeeId={row.employee_id} />
          <EmployeeVacationSection employeeId={row.employee_id} />
        </div>
      </div>

      {/* В «Подробно» вносить нечего — кнопок нет: к списку — переключателем экранов. */}
      {editable && (
        <footer className={styles.footer}>
          {saveError && <p className={styles.saveError} role="alert">{saveError}</p>}
          <div className={styles.actions}>
            {/* Пока идёт сохранение, карточку не закрыть: иначе её можно открыть заново со старыми суммами. */}
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onClose}
              disabled={saveMutation.isPending}
            >
              {canEdit ? 'Отмена' : 'Закрыть'}
            </button>
            {canEdit && (
              <button type="submit" className={styles.primaryButton} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? 'Сохранение…' : 'Сохранить'}
              </button>
            )}
          </div>
        </footer>
      )}
    </form>
  );
};
