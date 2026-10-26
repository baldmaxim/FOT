import { useCallback, useEffect, useId, useMemo, useRef, useState, type FC, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';

import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  payrollService,
  type IAssignTermsPayload,
  type IPayrollTermsRow,
} from '../../services/payrollService';
import { usePayrollCardExport } from '../../hooks/usePayrollCardExport';
import { paidHistoryQueryOptions, usePayrollPaid } from '../../hooks/usePayrollPaid';
import { usePayrollTermsForm } from '../../hooks/usePayrollTermsForm';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { payrollMonthOptions } from '../../utils/payrollAccruals';
import { defaultPaidMonth, paidAmountMonths, paidMonthOptions } from '../../utils/payrollPaid';
import { travelAllowance } from '../../utils/payrollRates';
import { payrollFieldId, payrollRowCategory, toInputValue } from '../../utils/payrollTermsForm';
import { MonthsPicker } from '../ui/MonthsPicker';
import { PayrollPaidTable } from './PayrollPaidTable';
import { PayrollTermsFields } from './PayrollTermsFields';
import { EmployeeVacationSection } from './EmployeeVacationSection';
import { PaidHistoryPanel } from './PaidHistoryPanel';
import { SalaryHistorySection } from './SalaryHistorySection';
import { StaffDeductionsList } from './StaffDeductionsList';
import modal from './PayrollModal.module.css';
import styles from './EmployeePayrollDetails.module.css';

type CardTab = 'terms' | 'history';

const CARD_TABS: ReadonlyArray<{ key: CardTab; label: string }> = [
  { key: 'terms', label: 'Условия' },
  { key: 'history', label: 'История выплат' },
];

interface IEmployeePayrollDetailsProps {
  row: IPayrollTermsRow;
  defaultDate: string;
  /**
   * Окно сотрудника на «Расчётах» (true): условия, компенсация, плановая доплата и удержание вносятся и сохраняются;
   * «Оплачено» и выбора месяцев нет.
   * Вкладка «Подробно» (false) — только просмотр: Категория, оклад · премия · итого, «Оплачено», история, отпуска;
   * кнопок нет.
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

/**
 * Карточка сотрудника раздела «Зарплата» — окно на «Расчётах» (editable) и вкладка «Подробно» (только просмотр).
 * В окне: условия оплаты (вид оплаты, оклад, премия), компенсация, плановая доплата; «Сохранить» пишет условия.
 * «Удержание» — только показ удержаний сотрудника (вносят в «Справочнике» и у кадров, миграция 321).
 * В «Подробно»: Категория, действующие оклад · премия · итого и «Оплачено», без полей и кнопок.
 * Ниже — свёрнутая справка: история изменений и отпуска (в «Подробно» — только строка-сводка); грузится отдельно,
 * её ошибки форму не блокируют.
 * Под шапкой вкладки: «Условия» (всё перечисленное) и «История выплат» (PaidHistoryPanel) — внутри карточки,
 * без своего окна. «Экспорт» в шапке — xlsx с условиями и историей выплат (usePayrollCardExport).
 * «Оплачено» (только «Подробно») — только чтение: суммы приходят из 1С. Категория — по отделу, в окне её можно
 * сменить (сохраняется с условиями). Месяцы у ФИО (один или несколько) задают таблицу «Оплачено».
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
  // границу месяца без перезагрузки устарел бы.
  const [currentMonth] = useState(moscowCurrentMonth);
  // Месяцы, за которые из 1С пришли суммы, — тем же запросом, что вкладка «История выплат» и «Экспорт».
  // Остальные в выборе «Оплачено» неактивны. Пока грузится (или ошибка) — доступно всё окно, как раньше.
  const historyQuery = useQuery({ ...paidHistoryQueryOptions(row.employee_id, currentMonth), enabled: !editable });
  const paidMonths = useMemo(
    () => (historyQuery.data ? new Set(paidAmountMonths(historyQuery.data)) : null),
    [historyQuery.data],
  );
  // Выбор месяцев ждёт окно по возрастанию; payrollMonthOptions отдаёт от текущего назад.
  const monthOptions = useMemo(
    () => paidMonthOptions([...payrollMonthOptions(currentMonth)].reverse(), paidMonths),
    [currentMonth, paidMonths],
  );
  // По умолчанию — последний закрытый месяц с суммами; пока пользователь не выбирал, подстраивается под данные.
  const defaultMonth = defaultPaidMonth(monthOptions, paidMonths, currentMonth);
  const [pickedMonths, setPickedMonths] = useState<string[] | null>(null);
  const months = useMemo(() => pickedMonths ?? [defaultMonth], [pickedMonths, defaultMonth]);
  const paid = usePayrollPaid(row.employee_id, months, !editable);
  const meta = [row.department_name, row.position_name].filter(Boolean).join(' · ');
  const tabsId = useId();
  const [tab, setTab] = useState<CardTab>('terms');
  // История монтируется при первом открытии вкладки и дальше остаётся: выбранный месяц и прокрутка целы.
  const [historyMounted, setHistoryMounted] = useState(false);
  const tabRefs = useRef<Partial<Record<CardTab, HTMLButtonElement | null>>>({});
  const { exporting, exportCard } = usePayrollCardExport(row, defaultDate, currentMonth);
  const tabId = (key: CardTab) => `${tabsId}-tab-${key}`;
  const panelId = (key: CardTab) => `${tabsId}-panel-${key}`;

  const selectTab = useCallback((key: CardTab) => {
    setTab(key);
    if (key === 'history') setHistoryMounted(true);
  }, []);

  // Вкладки — один стоп Tab: между ними стрелки, Home и End (выбор сразу, как по клику).
  const handleTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = CARD_TABS.findIndex(item => item.key === tab);
    const last = CARD_TABS.length - 1;
    const moves: Partial<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const key = CARD_TABS[next].key;
    selectTab(key);
    tabRefs.current[key]?.focus();
  };

  // Ответ сервера приходит позже клика: к этому времени вкладку могли сменить, а карточку — закрыть.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
    return () => { activeRef.current = false; };
  }, [active]);

  const saveMutation = useMutation({
    mutationFn: (terms: IAssignTermsPayload) => payrollService.assign(row.employee_id, terms),
    onSuccess: () => {
      // Префикс сбрасывает список, «Расчёты», историю изменений условий и «Оплачено».
      queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      success('Условия оплаты назначены: 1');
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
    const { payload, firstInvalid } = form.buildPayload();
    if (!payload) {
      if (firstInvalid) document.getElementById(payrollFieldId(idPrefix, firstInvalid))?.focus();
      return;
    }
    saveMutation.mutate(payload);
  };

  // Enter в поле не отправляет форму: окно сохраняется и закрывается только кнопками.
  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
  };

  return (
    <form
      className={className ? `${styles.details} ${className}` : styles.details}
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      noValidate
      aria-labelledby={titleId}
    >
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <div className={styles.nameRow}>
            <h2 ref={nameRef} id={titleId} className={styles.name} tabIndex={-1}>{row.full_name ?? 'Сотрудник'}</h2>
            {/* Месяцы задают «Оплачено» на «Условиях»; истории они не касаются. */}
            {!editable && (
              <MonthsPicker
                value={months}
                options={monthOptions}
                onChange={setPickedMonths}
                allowAll={false}
                resetValue={[defaultMonth]}
                ariaLabel="Месяцы «Оплачено»"
                className={tab === 'terms' ? styles.monthsTrigger : `${styles.monthsTrigger} ${styles.monthsHidden}`}
              />
            )}
          </div>
          {meta && <p className={styles.meta}>{meta}</p>}
        </div>
        <button
          type="button"
          className={styles.exportButton}
          onClick={() => { void exportCard(); }}
          disabled={exporting}
          aria-busy={exporting}
          aria-label={exporting ? 'Готовим…' : 'Экспорт'}
        >
          <Download size={18} aria-hidden="true" />
          <span className={styles.exportLabel}>{exporting ? 'Готовим…' : 'Экспорт'}</span>
        </button>
        {/* Крестик — как «Отмена»: пока идёт сохранение, не закрыть. */}
        {editable && onClose && (
          <button
            type="button"
            className={modal.closeButton}
            onClick={onClose}
            disabled={saveMutation.isPending}
            aria-label="Закрыть"
          >
            <X size={20} aria-hidden="true" />
          </button>
        )}
      </header>

      {/* Кнопки вкладок — type="button": карточка целиком форма, клик не должен её отправлять. */}
      <div className={styles.tabs} role="tablist" aria-label="Разделы карточки" onKeyDown={handleTabsKeyDown}>
        {CARD_TABS.map(item => {
          const selected = item.key === tab;
          return (
            <button
              key={item.key}
              ref={element => { tabRefs.current[item.key] = element; }}
              type="button"
              role="tab"
              id={tabId(item.key)}
              aria-selected={selected}
              aria-controls={panelId(item.key)}
              tabIndex={selected ? 0 : -1}
              className={selected ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => selectTab(item.key)}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Скрытые «Условия» остаются смонтированными: введённое и раскрытые блоки не теряются. */}
      <div
        className={styles.body}
        role="tabpanel"
        id={panelId('terms')}
        aria-labelledby={tabId('terms')}
        hidden={tab !== 'terms'}
      >
        {editable && !canEdit && (
          <p className={styles.readOnlyNote}>Только просмотр: нет права менять условия этого сотрудника.</p>
        )}
        <PayrollTermsFields
          form={form}
          idPrefix={idPrefix}
          readOnly={!canEdit}
          category={payrollRowCategory(row)}
          travel={toInputValue(travelAllowance(payrollRowCategory(row), row))}
          autoFocus={canEdit}
          paid={editable ? undefined : <PayrollPaidTable paid={paid} />}
          stacked
          detailsOnly={!editable}
          termsFrom={row.terms_id ? row.effective_from : null}
          total
          staffDeductions={editable ? <StaffDeductionsList employeeId={row.employee_id} /> : undefined}
        />

        <div className={styles.reference}>
          <SalaryHistorySection employeeId={row.employee_id} />
          <EmployeeVacationSection employeeId={row.employee_id} summaryOnly={!editable} />
        </div>
      </div>

      {/* Кнопки в панели истории — type="button": Enter и отправка формы её не касаются. */}
      <div
        className={styles.historyPanel}
        role="tabpanel"
        id={panelId('history')}
        aria-labelledby={tabId('history')}
        hidden={tab !== 'history'}
      >
        {historyMounted && (
          <PaidHistoryPanel employeeId={row.employee_id} positionName={row.position_name} toMonth={currentMonth} />
        )}
      </div>

      {/* В «Подробно» вносить нечего — кнопок нет: к списку — переключателем экранов. На истории — тоже нет. */}
      {editable && tab === 'terms' && (
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
