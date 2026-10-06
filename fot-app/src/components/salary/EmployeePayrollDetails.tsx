import { useEffect, useId, useMemo, useRef, useState, type FC, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  defaultCalcTypeFor,
  payrollService,
  type IAssignTermsPayload,
  type IPayrollPaidChange,
  type IPayrollTermsRow,
} from '../../services/payrollService';
import { usePayrollPaid } from '../../hooks/usePayrollPaid';
import { usePayrollTermsForm } from '../../hooks/usePayrollTermsForm';
import { moscowCurrentMonth, shiftMonth } from '../../utils/moscowDate';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import { paidCellId } from '../../utils/payrollPaid';
import { payrollFieldId } from '../../utils/payrollTermsForm';
import { PayrollPaidTable } from './PayrollPaidTable';
import { PayrollTermsFields } from './PayrollTermsFields';
import { EmployeeVacationSection } from './EmployeeVacationSection';
import { SalaryHistorySection } from './SalaryHistorySection';
import styles from './EmployeePayrollDetails.module.css';

interface IEmployeePayrollDetailsProps {
  row: IPayrollTermsRow;
  defaultDate: string;
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

/** Месяцев в выборе у ФИО: текущий и 11 предыдущих. */
const MONTH_OPTION_COUNT = 12;

interface ISaveVariables {
  /** null — условия не правили: новую версию условий не создаём. */
  terms: IAssignTermsPayload | null;
  paid: IPayrollPaidChange[];
}

/**
 * Вкладка «Подробно» раздела «Зарплата»: условия оплаты одного сотрудника (основная оплата с «Оплачено»,
 * компенсация, плановая доплата, удержание) и под ними свёрнутая справка — история изменений и отпуска. Справка грузится
 * отдельно, её ошибки форму не блокируют. «Сохранить» пишет и условия, и «Оплачено» — что из них правили.
 * Месяц у ФИО задаёт месяц «Оплачено»; условия от него не зависят.
 */
export const EmployeePayrollDetails: FC<IEmployeePayrollDetailsProps> = ({
  row,
  defaultDate,
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
  const form = usePayrollTermsForm({
    row,
    defaultDate,
    resolveDefaultCalcType: defaultCalcTypeFor,
    plannedSupplement: true,
  });
  // «Сегодня» — на момент открытия карточки: defaultDate фиксируется при входе в раздел и через
  // границу месяца без перезагрузки устарел бы. По умолчанию — прошлый, уже закрытый месяц.
  const [currentMonth] = useState(moscowCurrentMonth);
  const [month, setMonth] = useState(() => shiftMonth(currentMonth, -1));
  const monthOptions = useMemo(
    () => Array.from({ length: MONTH_OPTION_COUNT }, (_, index) => shiftMonth(currentMonth, -index)),
    [currentMonth],
  );
  const paidMonths = useMemo(() => [month], [month]);
  const paid = usePayrollPaid(row.employee_id, paidMonths);
  const meta = [row.department_name, row.position_name].filter(Boolean).join(' · ');

  // Ответ сервера приходит позже клика: к этому времени вкладку могли сменить, а карточку — закрыть.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
    return () => { activeRef.current = false; };
  }, [active]);

  const saveMutation = useMutation({
    // Сначала суммы: оба запроса идемпотентны — если условия не сохранятся, повтор ничего не задвоит.
    mutationFn: async ({ terms, paid: cells }: ISaveVariables) => {
      if (cells.length > 0) await payrollService.savePaid(row.employee_id, cells);
      if (terms) await payrollService.assign(row.employee_id, terms);
    },
    onSuccess: (_data, { terms }) => {
      // Префикс сбрасывает список, историю изменений условий и «Оплачено».
      queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      success(terms ? 'Условия оплаты назначены: 1' : 'Оплачено сохранено');
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

  // Ячейки есть в DOM только у раскрытой таблицы: раскрываем синхронно, потом фокус.
  const focusPaidCell = (key: string) => {
    flushSync(() => paid.expand());
    document.getElementById(paidCellId(idPrefix, key))?.focus();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit || saveMutation.isPending) return;
    const paidResult = paid.buildChanges();
    // Правили только «Оплачено»: условия не трогаем — оклад не обязателен, новая версия не создаётся.
    if ((paidResult.changes.length > 0 || paidResult.firstInvalid) && !form.isChanged()) {
      if (paidResult.firstInvalid) focusPaidCell(paidResult.firstInvalid);
      else saveMutation.mutate({ terms: null, paid: paidResult.changes });
      return;
    }
    const { payload, firstInvalid } = form.buildPayload();
    if (!payload) {
      if (firstInvalid) document.getElementById(payrollFieldId(idPrefix, firstInvalid))?.focus();
      return;
    }
    if (paidResult.firstInvalid) {
      focusPaidCell(paidResult.firstInvalid);
      return;
    }
    saveMutation.mutate({ terms: payload, paid: paidResult.changes });
  };

  return (
    <form className={styles.details} onSubmit={handleSubmit} noValidate aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h2 ref={nameRef} id={titleId} className={styles.name} tabIndex={-1}>{row.full_name ?? 'Сотрудник'}</h2>
          {meta && <p className={styles.meta}>{meta}</p>}
        </div>
        <select
          className={styles.monthSelect}
          aria-label="Месяц"
          value={month}
          onChange={event => setMonth(event.target.value)}
        >
          {monthOptions.map(option => (
            <option key={option} value={option}>{formatAccrualMonthLabel(option, true)}</option>
          ))}
        </select>
      </header>

      <div className={styles.body}>
        {!canEdit && (
          <p className={styles.readOnlyNote}>Только просмотр: нет права менять условия этого сотрудника.</p>
        )}
        <PayrollTermsFields
          form={form}
          idPrefix={idPrefix}
          readOnly={!canEdit}
          autoFocus={canEdit}
          paid={<PayrollPaidTable paid={paid} idPrefix={idPrefix} readOnly={!canEdit} />}
          stacked
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
