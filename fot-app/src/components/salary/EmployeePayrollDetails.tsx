import { useEffect, useId, useMemo, useRef, useState, type FC, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  payrollService,
  type IAssignTermsPayload,
  type IPayrollDeductionEntryPayload,
  type IPayrollTermsRow,
} from '../../services/payrollService';
import { usePayrollDeductionEntries } from '../../hooks/usePayrollDeductionEntries';
import { usePayrollPaid } from '../../hooks/usePayrollPaid';
import { usePayrollTermsForm } from '../../hooks/usePayrollTermsForm';
import { moscowCurrentMonth, shiftMonth } from '../../utils/moscowDate';
import { payrollMonthOptions } from '../../utils/payrollAccruals';
import { deductionFieldId } from '../../utils/payrollDeductionEntries';
import { payrollFieldId } from '../../utils/payrollTermsForm';
import { MonthsPicker } from '../ui/MonthsPicker';
import { PayrollDeductionEntries } from './PayrollDeductionEntries';
import { PayrollPaidTable } from './PayrollPaidTable';
import { PayrollTermsFields } from './PayrollTermsFields';
import { EmployeeVacationSection } from './EmployeeVacationSection';
import { SalaryHistorySection } from './SalaryHistorySection';
import styles from './EmployeePayrollDetails.module.css';

interface IEmployeePayrollDetailsProps {
  row: IPayrollTermsRow;
  defaultDate: string;
  /** Месяц новой строки удержания (YYYY-MM); не передан — прошлый месяц. */
  deductionMonth?: string;
  /** Класс корня: в окне «Расчётов» — без своей рамки. */
  className?: string;
  /** Вкладка «Подробно» открыта. Скрытая карточка остаётся смонтированной — введённое не теряется. */
  active: boolean;
  /** «Отмена» / «Закрыть»: карточка закрывается, вкладка — к списку. */
  onClose: () => void;
  /**
   * Условия сохранены. onScreen — карточка ещё на экране: тогда к списку; вкладку успели сменить
   * или открыли другого сотрудника — только закрыть устаревшую карточку этого.
   */
  onSaved: (employeeId: number, onScreen: boolean) => void;
}

interface ISaveVariables {
  /** null — условия не правили: новую версию условий не создаём. */
  terms: IAssignTermsPayload | null;
  /** Удержания по месяцам целиком; null — не меняли. */
  entries: IPayrollDeductionEntryPayload[] | null;
}

/**
 * Карточка сотрудника раздела «Зарплата» — вкладка «Подробно» и окно на «Расчётах»: условия оплаты (основная оплата
 * с «Оплачено», компенсация, плановая доплата), удержания по месяцам и под ними свёрнутая справка — история изменений
 * и отпуска. Справка грузится отдельно, её ошибки форму не блокируют. «Сохранить» пишет условия и удержания — что
 * из них правили.
 * «Оплачено» — только чтение: суммы приходят из 1С. Категория — только чтение: её ставит сервер по отделу.
 * Месяцы у ФИО (один или несколько) задают таблицы «Оплачено»; условия от них не зависят.
 */
export const EmployeePayrollDetails: FC<IEmployeePayrollDetailsProps> = ({
  row,
  defaultDate,
  deductionMonth,
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
  const canEdit = canEditPage('/salary/terms') && row.can_edit !== false;
  const form = usePayrollTermsForm({ row, defaultDate, plannedSupplement: true });
  // «Сегодня» — на момент открытия карточки: defaultDate фиксируется при входе в раздел и через
  // границу месяца без перезагрузки устарел бы. По умолчанию — прошлый, уже закрытый месяц.
  const [currentMonth] = useState(moscowCurrentMonth);
  const [months, setMonths] = useState<string[]>(() => [shiftMonth(currentMonth, -1)]);
  // Выбор месяцев ждёт окно по возрастанию; payrollMonthOptions отдаёт от текущего назад.
  const monthOptions = useMemo(() => [...payrollMonthOptions(currentMonth)].reverse(), [currentMonth]);
  const paid = usePayrollPaid(row.employee_id, months);
  const deductions = usePayrollDeductionEntries(row.employee_id);
  const meta = [row.department_name, row.position_name].filter(Boolean).join(' · ');

  // Ответ сервера приходит позже клика: к этому времени вкладку могли сменить, а карточку — закрыть.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
    return () => { activeRef.current = false; };
  }, [active]);

  const saveMutation = useMutation({
    // Сначала удержания: запрос заменяет их целиком — если условия не сохранятся, повтор ничего не задвоит.
    mutationFn: async ({ terms, entries }: ISaveVariables) => {
      if (entries) await payrollService.saveDeductionEntries(row.employee_id, entries);
      if (terms) await payrollService.assign(row.employee_id, terms);
    },
    onSuccess: (_data, { terms }) => {
      // Префикс сбрасывает списки «Условий оплаты» и «Расчётов», историю изменений условий, «Оплачено» и удержания.
      queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      success(terms ? 'Условия оплаты назначены: 1' : 'Удержания сохранены');
      onSaved(row.employee_id, activeRef.current);
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
    const entries = deductions.isChanged() ? deductions.buildPayload() : null;
    // Правили только удержания: условия не трогаем — оклад не обязателен, новая версия не создаётся.
    const terms = entries && !form.isChanged() ? null : form.buildPayload();
    // Фокус — на первую ошибку на экране: условия выше удержаний.
    if (terms && !terms.payload) {
      if (terms.firstInvalid) document.getElementById(payrollFieldId(idPrefix, terms.firstInvalid))?.focus();
      return;
    }
    if (entries && !entries.payload) {
      const first = entries.firstInvalid;
      if (first) document.getElementById(deductionFieldId(idPrefix, first.key, first.field))?.focus();
      return;
    }
    saveMutation.mutate({ terms: terms?.payload ?? null, entries: entries?.payload ?? null });
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
        {!canEdit && (
          <p className={styles.readOnlyNote}>Только просмотр: нет права менять условия этого сотрудника.</p>
        )}
        <PayrollTermsFields
          form={form}
          idPrefix={idPrefix}
          readOnly={!canEdit}
          category={row.department_category ?? row.staff_category}
          autoFocus={canEdit}
          paid={<PayrollPaidTable paid={paid} idPrefix={idPrefix} />}
          stacked
          deductions={(
            <PayrollDeductionEntries
              entries={deductions}
              idPrefix={idPrefix}
              readOnly={!canEdit}
              defaultMonth={deductionMonth ?? shiftMonth(currentMonth, -1)}
            />
          )}
        />

        <div className={styles.reference}>
          <SalaryHistorySection employeeId={row.employee_id} />
          <EmployeeVacationSection employeeId={row.employee_id} />
        </div>
      </div>

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
    </form>
  );
};
