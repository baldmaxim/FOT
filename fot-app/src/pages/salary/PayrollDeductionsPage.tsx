import { useMemo, useState, type FC } from 'react';
import { ChevronDown } from 'lucide-react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { usePayrollDeductionKinds } from '../../hooks/usePayrollDeductionKinds';
import { moscowCurrentMonth, shiftMonth } from '../../utils/moscowDate';
import { formatAccrualMonthLabel, formatAccrualPeriodLong, payrollMonthOptions } from '../../utils/payrollAccruals';
import { PAYROLL_CALC_COLUMNS_KEY } from '../../utils/payrollColumns';
import { formatDeductionKinds, toggleDeductionKind } from '../../utils/payrollDeductions';
import { DeductionKindsMenu } from '../../components/salary/DeductionKindsMenu';
import { PayrollEmployeeModal } from '../../components/salary/PayrollEmployeeModal';
import { CompensationTermsPage, type IPayrollDeductionFilter } from './CompensationTermsPage';
import styles from './PayrollDeductionsPage.module.css';

interface IPayrollDeductionsPageProps {
  /** Дата выборки условий — та же, что у «Условий оплаты». */
  date: string;
  /** «Расчёты» на экране. Скрытые не размонтируются: фильтры и прокрутка сохраняются. */
  active: boolean;
  /** Карточку сотрудника сохранили в окне: его карточка «Подробно» (если открыта) устарела. */
  onSaved: (employeeId: number) => void;
}

/**
 * «Зарплата → Расчёты»: таблица штата как у «Условий оплаты» (без галочек и «Назначить выделенным»),
 * в панели — «Удержания» (виды справочника галочками, там же новый вид) и месяц. Отмечены виды —
 * только сотрудники хотя бы с одним из них и столбец «Удержание» за месяц (суммы придут из 1С).
 * Клик по строке — окно с карточкой сотрудника: только там вносятся компенсации, доплаты и удержания.
 */
export const PayrollDeductionsPage: FC<IPayrollDeductionsPageProps> = ({ date, active, onSaved }) => {
  const kinds = usePayrollDeductionKinds();
  const [selected, setSelected] = useState<number[]>([]);
  const [kindsAnchor, setKindsAnchor] = useState<HTMLElement | null>(null);
  const [employee, setEmployee] = useState<IPayrollTermsRow | null>(null);
  // «Сегодня» — на момент открытия: по умолчанию прошлый, уже закрытый месяц, как в карточке.
  const [currentMonth] = useState(moscowCurrentMonth);
  const [month, setMonth] = useState(() => shiftMonth(currentMonth, -1));
  const monthOptions = useMemo(() => payrollMonthOptions(currentMonth), [currentMonth]);

  const kindList = kinds.data ?? [];
  const kindsLabel = formatDeductionKinds(selected, kindList);

  const deductionFilter = useMemo<IPayrollDeductionFilter | undefined>(() => (
    selected.length > 0 ? { kindIds: selected, monthLabel: formatAccrualPeriodLong([month]) } : undefined
  ), [selected, month]);

  // Уход с «Расчётов» (другая вкладка, «Назад» браузера) закрывает меню и окно: они в портале, скрытие
  // экрана их не прячет. Паттерн «состояние из прошлого рендера» вместо setState-в-effect.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) {
      setKindsAnchor(null);
      setEmployee(null);
    }
  }

  const toggleKind = (kindId: number, checked: boolean) => {
    setSelected(prev => toggleDeductionKind(prev, kindId, checked, kindList));
  };

  /** Закрытие возвращает фокус на кнопку — клавиатура не теряет место. */
  const closeKinds = () => {
    kindsAnchor?.focus();
    setKindsAnchor(null);
  };

  const toolbarExtra = (
    <>
      <div className={styles.kindsField}>
        <button
          type="button"
          className={styles.kindsButton}
          aria-haspopup="dialog"
          aria-expanded={kindsAnchor !== null}
          aria-label={`Удержания: ${kindsLabel || 'не выбраны'}`}
          title={kindsLabel || undefined}
          disabled={!kinds.data}
          onClick={event => setKindsAnchor(event.currentTarget)}
        >
          <span className={kindsLabel ? styles.kindsValue : `${styles.kindsValue} ${styles.kindsPlaceholder}`}>
            {kindsLabel || (kinds.isError ? 'Удержания: ошибка загрузки' : 'Удержания')}
          </span>
          <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.monthField}>
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
      </div>
    </>
  );

  return (
    <>
      <CompensationTermsPage
        date={date}
        active={active}
        onOpenEmployee={setEmployee}
        selectable={false}
        toolbarExtra={toolbarExtra}
        deductionFilter={deductionFilter}
        hiddenColumnsKey={PAYROLL_CALC_COLUMNS_KEY}
      />

      {kindsAnchor && kinds.data && (
        <DeductionKindsMenu
          anchor={kindsAnchor}
          kinds={kinds.data}
          selected={selected}
          onToggle={toggleKind}
          onClose={closeKinds}
        />
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
