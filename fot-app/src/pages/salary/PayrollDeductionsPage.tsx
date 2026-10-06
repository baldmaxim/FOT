import { useMemo, useState, type FC } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';

import { payrollService, type IPayrollTermsRow } from '../../services/payrollService';
import { usePayrollDeductionKinds } from '../../hooks/usePayrollDeductionKinds';
import { moscowCurrentMonth, shiftMonth } from '../../utils/moscowDate';
import { formatAccrualMonthLabel, formatAccrualPeriodLong, payrollMonthOptions } from '../../utils/payrollAccruals';
import { formatDeductionKinds, toggleDeductionKind } from '../../utils/payrollDeductions';
import { DeductionKindsMenu } from '../../components/salary/DeductionKindsMenu';
import { PayrollDeductionsTable } from '../../components/salary/PayrollDeductionsTable';
import common from './CompensationTermsPage.module.css';
import styles from './PayrollDeductionsPage.module.css';

interface IPayrollDeductionsPageProps {
  /** Дата выборки условий — та же, что у «Условий оплаты». */
  date: string;
  /** Клик по строке — карточка «Подробно»; не передан — нет права на «Условия оплаты». */
  onOpenEmployee?: (row: IPayrollTermsRow) => void;
}

/**
 * «Зарплата → Расчёты»: фильтр «Удержания» (виды справочника галочками, там же новый вид) и месяц.
 * Отмечены виды — таблица сотрудников хотя бы с одним из них: ФИО, подразделение, сумма за месяц
 * (придёт из 1С). Ничего не отмечено — таблицы нет. Виды сотруднику отмечаются в «Подробно».
 */
export const PayrollDeductionsPage: FC<IPayrollDeductionsPageProps> = ({ date, onOpenEmployee }) => {
  const kinds = usePayrollDeductionKinds();
  const [selected, setSelected] = useState<number[]>([]);
  const [kindsAnchor, setKindsAnchor] = useState<HTMLElement | null>(null);
  // «Сегодня» — на момент открытия: по умолчанию прошлый, уже закрытый месяц, как в карточке.
  const [currentMonth] = useState(moscowCurrentMonth);
  const [month, setMonth] = useState(() => shiftMonth(currentMonth, -1));
  const monthOptions = useMemo(() => payrollMonthOptions(currentMonth), [currentMonth]);

  const kindsKey = selected.join(',');
  // Префикс 'payroll-terms': сохранение карточки перечитывает и «Расчёты».
  const deductions = useQuery({
    queryKey: ['payroll-terms', 'deductions', 'list', date, kindsKey],
    queryFn: ({ signal }) => payrollService.listDeductions({ date, kindIds: selected }, signal),
    enabled: selected.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const kindList = kinds.data ?? [];
  const kindsLabel = formatDeductionKinds(selected, kindList);

  const toggleKind = (kindId: number, checked: boolean) => {
    setSelected(prev => toggleDeductionKind(prev, kindId, checked, kindList));
  };

  /** Закрытие возвращает фокус на кнопку — клавиатура не теряет место. */
  const closeKinds = () => {
    kindsAnchor?.focus();
    setKindsAnchor(null);
  };

  return (
    <div className={common.page}>
      <div className={common.toolbar}>
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
      </div>

      {selected.length > 0 && (
        <>
          {deductions.data && !deductions.data.meta.contractors_excluded && (
            <div className={common.warning}>
              Не найден узел «Подрядные организации» — в списке могут оказаться сотрудники подрядчиков.
            </div>
          )}
          {deductions.isPending && <div className={common.state}>Загрузка…</div>}
          {deductions.isError && !deductions.data && (
            <div className={common.stateError}>
              Не удалось загрузить удержания
              <button type="button" className={common.retryButton} onClick={() => { void deductions.refetch(); }}>
                Повторить
              </button>
            </div>
          )}
          {deductions.data && (
            <PayrollDeductionsTable
              rows={deductions.data.rows}
              monthLabel={formatAccrualPeriodLong([month])}
              resetKey={kindsKey}
              onOpen={onOpenEmployee}
            />
          )}
        </>
      )}

      {kindsAnchor && kinds.data && (
        <DeductionKindsMenu
          anchor={kindsAnchor}
          kinds={kinds.data}
          selected={selected}
          onToggle={toggleKind}
          onClose={closeKinds}
        />
      )}
    </div>
  );
};
