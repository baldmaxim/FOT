import { lazy, Suspense, useRef, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { PAYROLL_SUMMARY_KEYS, payrollSummaryService } from '../../services/payrollSummaryService';
import { PAYROLL_CALC_COLUMNS_KEY, PAYROLL_CALC_TABLE_COLUMNS } from '../../utils/payrollColumns';
import { MonthsPicker } from '../../components/ui/MonthsPicker';
import { PayrollDictionaryModal } from '../../components/salary/PayrollDictionaryModal';
import { PayrollEmployeeModal } from '../../components/salary/PayrollEmployeeModal';
import { PayrollPaidDeductionsModal } from '../../components/salary/PayrollPaidDeductionsModal';
import { CompensationTermsPage } from './CompensationTermsPage';
import styles from './PayrollDeductionsPage.module.css';

const PayrollSummaryModal = lazy(() => import('../../components/salary/summary/PayrollSummaryModal')
  .then(m => ({ default: m.PayrollSummaryModal })));

interface IPayrollDeductionsPageProps {
  /** Дата выборки условий — та же, что у «Условий оплаты». */
  date: string;
  /** «Расчёты» на экране. Скрытые не размонтируются: фильтры и прокрутка сохраняются. */
  active: boolean;
  /** Карточку сотрудника сохранили в окне: его карточка «Подробно» (если открыта) устарела. */
  onSaved: (employeeId: number) => void;
}

/** Окно удержаний: строка, кнопка-сумма (вернуть фокус) и период сумм строки. */
interface IDeductionsWindow {
  row: IPayrollTermsRow;
  trigger: HTMLButtonElement;
  period: string;
}

/**
 * «Зарплата → Расчёты»: текущий штат, как у «Условий оплаты», но вместо условий — «К выплате» и «Удержания»
 * («Оплачено» ЗУП) за месяцы, выбранные рядом со «Сводом»; «К выплате» — начислено + удержано, как в «Своде».
 * Клик по сумме удержаний — окно со статьями.
 * Рядом с шестерёнкой — «Свод» с выбором месяцев («Оплачено» по объектам) и «Справочник»: виды удержаний,
 * ставки и таблицы. Клик по строке — окно с карточкой сотрудника: там вносятся компенсации, доплаты и удержания.
 */
export const PayrollDeductionsPage: FC<IPayrollDeductionsPageProps> = ({ date, active, onSaved }) => {
  const [employee, setEmployee] = useState<IPayrollTermsRow | null>(null);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const dictionaryButtonRef = useRef<HTMLButtonElement>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  const [deductions, setDeductions] = useState<IDeductionsWindow | null>(null);

  // Месяцы «Свода» — те, за которые есть «Оплачено». Пока не загружены, выбора нет и «Свод» неактивен:
  // пустой выбор значит «весь период», и окно не должно успеть запросить его до месяца по умолчанию.
  const monthsQuery = useQuery({
    queryKey: PAYROLL_SUMMARY_KEYS.months,
    queryFn: ({ signal }) => payrollSummaryService.listMonths(signal),
    enabled: active,
    staleTime: 60_000,
  });
  const monthOptions = monthsQuery.data ?? [];
  const [chosenMonths, setChosenMonths] = useState<string[] | null>(null);
  // Не выбирали — последний месяц с данными.
  const summaryMonths = chosenMonths ?? (monthsQuery.data ? monthOptions.slice(-1) : null);
  // Суммы таблицы — за те же месяцы (пусто — весь период). Пока месяцы грузятся, список ждёт;
  // не загрузились — весь период: пикер тогда и так показывает «Весь период».
  const paidMonths = summaryMonths ?? (monthsQuery.isError ? 'all' : null);

  // Уход с «Расчётов» (другая вкладка, «Назад» браузера) закрывает окна: они поверх страницы, скрытие
  // экрана их не прячет. Паттерн «состояние из прошлого рендера» вместо setState-в-effect.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) {
      setDictionaryOpen(false);
      setSummaryOpen(false);
      setEmployee(null);
      setDeductions(null);
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
  // Строку с кнопкой могла убрать виртуализация или новая выборка — тогда фокус некуда вернуть.
  const closeDeductions = () => {
    if (deductions?.trigger.isConnected) deductions.trigger.focus();
    setDeductions(null);
  };

  return (
    <>
      <CompensationTermsPage
        date={date}
        active={active}
        onOpenEmployee={setEmployee}
        hiddenColumnsKey={PAYROLL_CALC_COLUMNS_KEY}
        columns={PAYROLL_CALC_TABLE_COLUMNS}
        paidMonths={paidMonths}
        onOpenDeductions={(row, trigger, period) => setDeductions({ row, trigger, period })}
        actionsExtra={(
          <>
            <button
              ref={summaryButtonRef}
              type="button"
              className={styles.dictionaryButton}
              aria-haspopup="dialog"
              disabled={summaryMonths === null}
              onClick={() => setSummaryOpen(true)}
            >
              Свод
            </button>
            <MonthsPicker
              value={summaryMonths ?? []}
              options={monthOptions}
              onChange={setChosenMonths}
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
          </>
        )}
      />

      {dictionaryOpen && <PayrollDictionaryModal onClose={closeDictionary} />}

      {summaryOpen && summaryMonths !== null && (
        <Suspense fallback={null}>
          <PayrollSummaryModal months={summaryMonths} onClose={closeSummary} />
        </Suspense>
      )}

      {deductions && (
        <PayrollPaidDeductionsModal row={deductions.row} period={deductions.period} onClose={closeDeductions} />
      )}

      {employee && (
        <PayrollEmployeeModal
          key={employee.employee_id}
          row={employee}
          defaultDate={date}
          onClose={() => setEmployee(null)}
          onSaved={onSaved}
        />
      )}
    </>
  );
};
