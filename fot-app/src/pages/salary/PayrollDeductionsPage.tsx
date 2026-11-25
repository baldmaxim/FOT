import { lazy, Suspense, useCallback, useMemo, useRef, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { PAYOUTS_1C_KEYS, payroll1cPayoutsService } from '../../services/payroll1cPayoutsService';
import { payrollService, type IPayrollTermsRow, type PayrollPaidMonths } from '../../services/payrollService';
import { useToast } from '../../contexts/ToastContext';
import { PAYROLL_SUMMARY_KEYS, payrollSummaryService } from '../../services/payrollSummaryService';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { payrollMonthOptions } from '../../utils/payrollAccruals';
import { PAYROLL_CALC_COLUMNS_KEY, PAYROLL_CALC_TABLE_COLUMNS } from '../../utils/payrollColumns';
import {
  calcMonthsSelection,
  effectivePaidMonths,
  formatPaidPeriod,
  type PayrollPaidTotalKind,
} from '../../utils/payrollPaid';
import { MonthsPicker } from '../../components/ui/MonthsPicker';
import { PayrollDictionaryModal } from '../../components/salary/PayrollDictionaryModal';
import { PayrollEmployeeModal } from '../../components/salary/PayrollEmployeeModal';
import { PayrollPaidItemsModal } from '../../components/salary/PayrollPaidItemsModal';
import type { ICalcMonthFilter, PayrollCardTab } from '../../utils/payrollViews';
import { CompensationTermsPage } from './CompensationTermsPage';
import styles from './PayrollDeductionsPage.module.css';

const PayrollSummaryModal = lazy(() => import('../../components/salary/summary/PayrollSummaryModal')
  .then(m => ({ default: m.PayrollSummaryModal })));
const Payroll1cImportModal = lazy(() => import('../../components/salary/Payroll1cImportModal')
  .then(m => ({ default: m.Payroll1cImportModal })));
const Payroll1cJournalModal = lazy(() => import('../../components/salary/Payroll1cJournalModal')
  .then(m => ({ default: m.Payroll1cJournalModal })));
const Payroll1cPayoutsModal = lazy(() => import('../../components/salary/Payroll1cPayoutsModal')
  .then(m => ({ default: m.Payroll1cPayoutsModal })));

interface IPayrollDeductionsPageProps {
  /** Дата выборки условий — та же, что у «Условий оплаты». */
  date: string;
  /** «Расчёты» на экране. Скрытые не размонтируются: фильтры и прокрутка сохраняются. */
  active: boolean;
  /** Только этот сотрудник — его карточка открыта в «Подробно» (см. PaymentsTab). */
  employeeId?: number;
  /** Поиск по ФИО — общий с «Условиями оплаты»; при employeeId — его ФИО. */
  search: string;
  onSearchChange: (value: string) => void;
  /** Отдел или бригада — общие с «Условиями оплаты». */
  departmentId: string;
  onDepartmentChange: (id: string) => void;
  /** «Категория» и «Объект» месяца — только у «Расчётов». */
  monthFilter: ICalcMonthFilter;
  onMonthFilterChange: (next: ICalcMonthFilter) => void;
  /** Карточку сотрудника сохранили в окне: его карточка «Подробно» (если открыта) устарела. */
  onSaved: (employeeId: number) => void;
  /** Возврат из табеля: строка сотрудника, чьё окно открыть снова (приходит после запроса), и вкладка окна. */
  restoreEmployee?: IPayrollTermsRow | null;
  initialCardTab?: PayrollCardTab;
  /** Месяцы «Свода» и таблицы при возврате из табеля. */
  initialMonths?: string[];
  /** Клик по ФИО в окне: табель сотрудника за месяцы таблицы. */
  onLeaveToTimesheet?: (row: IPayrollTermsRow, tab: PayrollCardTab, months: string[]) => void;
}

/** Окно статей «Удержания (1С)»: строка, раздел, кнопка-сумма (вернуть фокус) и месяцы сумм строки. */
interface IPaidItemsWindow {
  row: IPayrollTermsRow;
  kind: PayrollPaidTotalKind;
  trigger: HTMLButtonElement;
  months: PayrollPaidMonths;
}

/** Окно ведомостей 1С сотрудника (клик по «Выплатам на карту (1С)»): строка, кнопка (вернуть фокус) и месяцы. */
interface ICardPayoutsWindow {
  row: IPayrollTermsRow;
  trigger: HTMLButtonElement;
  months: PayrollPaidMonths;
}

/**
 * «Зарплата → Расчёты»: работавшие в выбранных месяцах и уволенные, кому за них есть суммы или дни табеля; вместо условий —
 * суммы за месяцы, выбранные рядом со «Сводом»: «Остаток к выплате» («Сумма» ФОТ минус «Выплаты на карту»), состав
 * зарплаты и удержания 1С, снизу — «Итого» по всей выборке. Клик по сумме «Удержания (1С)» — окно со статьями.
 * Рядом с шестерёнкой — «Свод» с выбором месяцев («Оплачено» по объектам) и «Справочник»: виды удержаний,
 * ставки и таблицы. «Загрузить из 1С» — ведомость выплаты (миграция 328), только тем, кому сервер разрешает
 * загрузку (вся «Зарплата»); «Ведомости 1С» — журнал всех ведомостей (тоже весь штат). Клик по «Выплатам на карту
 * (1С)» — ведомости сотрудника за месяцы таблицы. Клик по строке — окно с карточкой сотрудника: там вносятся компенсации, доплаты и удержания.
 * ФИО в окне — табель сотрудника; на возврате из табеля окно открывается снова, месяцы таблицы — прежние.
 */
export const PayrollDeductionsPage: FC<IPayrollDeductionsPageProps> = ({
  date, active, employeeId, search, onSearchChange, departmentId, onDepartmentChange, monthFilter, onMonthFilterChange, onSaved,
  restoreEmployee = null, initialCardTab, initialMonths, onLeaveToTimesheet,
}) => {
  const [employee, setEmployee] = useState<IPayrollTermsRow | null>(null);
  // Возврат из табеля: окно открывается один раз, когда строка пришла, и только на экране «Расчётов».
  const [restoredEmployee, setRestoredEmployee] = useState<IPayrollTermsRow | null>(null);
  if (restoreEmployee && restoreEmployee !== restoredEmployee) {
    setRestoredEmployee(restoreEmployee);
    if (active) setEmployee(restoreEmployee);
  }
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const dictionaryButtonRef = useRef<HTMLButtonElement>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const journalButtonRef = useRef<HTMLButtonElement>(null);
  const [cardPayouts, setCardPayouts] = useState<ICardPayoutsWindow | null>(null);
  // Кнопка — по той же проверке, что у загрузки на сервере: нет права — нет кнопки.
  const importCapability = useQuery({
    queryKey: PAYOUTS_1C_KEYS.capability,
    queryFn: ({ signal }) => payroll1cPayoutsService.capability(signal),
    enabled: active,
    staleTime: 5 * 60_000,
  });
  const [paidItems, setPaidItems] = useState<IPaidItemsWindow | null>(null);

  // Месяцы «Свода» и таблицы — как в карточке «Подробно»: текущий и 11 предыдущих плюс более старые, но доступны
  // только месяцы с данными (calcMonthsSelection). Пока месяцы грузятся — всё окно. «Весь период» не выбирается.
  const monthsQuery = useQuery({
    queryKey: PAYROLL_SUMMARY_KEYS.months,
    queryFn: ({ signal }) => payrollSummaryService.listMonths(signal),
    enabled: active,
    staleTime: 60_000,
  });
  // Месяцы ведомостей в банк: месяц, по которому из 1С пришла только ведомость, тоже выбирается.
  const payoutMonthsQuery = useQuery({
    queryKey: PAYOUTS_1C_KEYS.months,
    queryFn: ({ signal }) => payroll1cPayoutsService.months(signal),
    enabled: active,
    staleTime: 60_000,
  });
  const [currentMonth] = useState(moscowCurrentMonth);
  // Кроме месяцев «Оплачено» — прошлые месяцы с расчётом ФОТ по закрытому табелю и месяцы ведомостей.
  const { options: monthOptions, selectable, defaultMonth } = useMemo(() => calcMonthsSelection({
    currentMonth,
    windowMonths: payrollMonthOptions(currentMonth),
    paidMonths: monthsQuery.data ?? null,
    payoutMonths: payoutMonthsQuery.data ?? null,
  }), [currentMonth, monthsQuery.data, payoutMonthsQuery.data]);
  // Не выбирали — последний закрытый месяц с «Оплачено» (пока грузится — прошлый). Выбранный до загрузки
  // недопустимый месяц после неё отбрасывается. Суммы таблицы — за те же месяцы.
  const [chosenMonths, setChosenMonths] = useState<string[] | null>(initialMonths ?? null);
  const summaryMonths = useMemo(
    () => effectivePaidMonths(chosenMonths, selectable, defaultMonth),
    [chosenMonths, selectable, defaultMonth],
  );
  // Журнал ведомостей: месяцы окна и все месяцы, за которые есть ведомости.
  const journalMonthOptions = useMemo(
    () => [...new Set([...payrollMonthOptions(currentMonth), ...(payoutMonthsQuery.data ?? [])])].sort(),
    [currentMonth, payoutMonthsQuery.data],
  );

  // Уход с «Расчётов» (другая вкладка, «Назад» браузера) закрывает окна: они поверх страницы, скрытие
  // экрана их не прячет. Паттерн «состояние из прошлого рендера» вместо setState-в-effect.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) {
      setDictionaryOpen(false);
      setSummaryOpen(false);
      setImportOpen(false);
      setJournalOpen(false);
      setEmployee(null);
      setPaidItems(null);
      setCardPayouts(null);
    }
  }

  /** Закрытие возвращает фокус на кнопку — клавиатура не теряет место. */
  const closeDictionary = () => {
    setDictionaryOpen(false);
    dictionaryButtonRef.current?.focus();
  };
  const closeSummary = () => {
    setSummaryOpen(false);
    summaryButtonRef.current?.focus();
  };
  const closeImport = () => {
    setImportOpen(false);
    importButtonRef.current?.focus();
  };
  const closeJournal = () => {
    setJournalOpen(false);
    journalButtonRef.current?.focus();
  };
  const { error: showError } = useToast();
  // Сотрудник из ведомости журнала: его строка «Расчётов» за месяц строки (уволенный тоже — у него есть выплата), журнал
  // закрывается, открывается карточка.
  const openEmployeeFromJournal = useCallback(async (employeeId: number, month: string) => {
    try {
      const { rows } = await payrollService.listTerms({
        date, employeeId, sort: 'name', dir: 'asc', pageSize: 1, paidMonths: [month], deferCalc: true,
      });
      const found = rows.find(item => item.employee_id === employeeId);
      if (!found) {
        showError('Сотрудника нет в «Расчётах» за этот месяц или он не в вашем доступе');
        return;
      }
      setJournalOpen(false);
      setEmployee(found);
    } catch {
      showError('Не удалось открыть карточку сотрудника');
    }
  }, [date, showError]);
  // Строку с кнопкой могла убрать виртуализация или новая выборка — тогда фокус некуда вернуть.
  const closePaidItems = () => {
    if (paidItems?.trigger.isConnected) paidItems.trigger.focus();
    setPaidItems(null);
  };
  const closeCardPayouts = () => {
    if (cardPayouts?.trigger.isConnected) cardPayouts.trigger.focus();
    setCardPayouts(null);
  };

  return (
    <>
      <CompensationTermsPage
        date={date}
        active={active}
        employeeId={employeeId}
        search={search}
        onSearchChange={onSearchChange}
        departmentId={departmentId}
        onDepartmentChange={onDepartmentChange}
        monthFilter={monthFilter}
        onMonthFilterChange={onMonthFilterChange}
        onOpenEmployee={setEmployee}
        hiddenColumnsKey={PAYROLL_CALC_COLUMNS_KEY}
        columns={PAYROLL_CALC_TABLE_COLUMNS}
        paidMonths={summaryMonths}
        // Месяц по умолчанию известен после загрузки месяцев (ошибка — тоже: умолчание остаётся прежним); до этого
        // расчёт не запускается — иначе сервер досчитывал бы брошенный прежний месяц.
        calcReady={!monthsQuery.isPending}
        onOpenPaidItems={(row, kind, trigger, months) => setPaidItems({ row, kind, trigger, months })}
        onOpenCardPayouts={(row, trigger, months) => setCardPayouts({ row, trigger, months })}
        actionsExtra={(
          <>
            <button
              ref={summaryButtonRef}
              type="button"
              className={styles.dictionaryButton}
              aria-haspopup="dialog"
              onClick={() => setSummaryOpen(true)}
            >
              Свод
            </button>
            <MonthsPicker
              value={summaryMonths}
              options={monthOptions}
              onChange={setChosenMonths}
              allowAll={false}
              resetValue={[defaultMonth]}
              ariaLabel="Месяцы «Свода» и таблицы"
              className={styles.monthsButton}
            />
            <button
              ref={dictionaryButtonRef}
              type="button"
              className={styles.dictionaryButton}
              aria-haspopup="dialog"
              onClick={() => setDictionaryOpen(true)}
            >
              Справочник
            </button>
            {importCapability.data?.can_import === true && (
              <button
                ref={importButtonRef}
                type="button"
                className={styles.dictionaryButton}
                aria-haspopup="dialog"
                onClick={() => setImportOpen(true)}
              >
                Загрузить из 1С
              </button>
            )}
            {importCapability.data?.can_view_journal === true && (
              <button
                ref={journalButtonRef}
                type="button"
                className={styles.dictionaryButton}
                aria-haspopup="dialog"
                onClick={() => setJournalOpen(true)}
              >
                Ведомости 1С
              </button>
            )}
          </>
        )}
      />

      {dictionaryOpen && <PayrollDictionaryModal onClose={closeDictionary} />}

      {importOpen && (
        <Suspense fallback={null}>
          <Payroll1cImportModal onClose={closeImport} />
        </Suspense>
      )}

      {journalOpen && (
        <Suspense fallback={null}>
          <Payroll1cJournalModal
            initialMonths={summaryMonths}
            monthOptions={journalMonthOptions}
            onClose={closeJournal}
            onOpenEmployee={(employeeId, month) => { void openEmployeeFromJournal(employeeId, month); }}
          />
        </Suspense>
      )}

      {cardPayouts && (
        <Suspense fallback={null}>
          <Payroll1cPayoutsModal row={cardPayouts.row} months={cardPayouts.months} onClose={closeCardPayouts} />
        </Suspense>
      )}

      {summaryOpen && (
        <Suspense fallback={null}>
          <PayrollSummaryModal months={summaryMonths} onClose={closeSummary} />
        </Suspense>
      )}

      {paidItems?.kind === 'deducted' && (
        <PayrollPaidItemsModal
          kind="deducted"
          row={paidItems.row}
          period={formatPaidPeriod(paidItems.months)}
          amounts={paidItems.row.paid_deductions ?? []}
          onClose={closePaidItems}
        />
      )}

      {employee && (
        <PayrollEmployeeModal
          key={employee.employee_id}
          row={employee}
          defaultDate={date}
          onClose={() => setEmployee(null)}
          onSaved={onSaved}
          initialView={employee === restoredEmployee && initialCardTab ? { months: null, tab: initialCardTab } : undefined}
          onLeaveToTimesheet={onLeaveToTimesheet ? tab => onLeaveToTimesheet(employee, tab, summaryMonths) : undefined}
        />
      )}
    </>
  );
};
