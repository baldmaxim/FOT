import { useMemo, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../../services/payrollService';
import { STAFF_DEDUCTIONS_KEY } from '../../services/staffDeductionService';
import { formatMonthLabel } from '../../utils/formatMoney';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import { monthNumeric, plannedDeductionPeriodLabel } from '../../utils/plannedDeductionTable';
import { staffDeductionKindLabel } from '../../utils/staffDeductionTable';
import styles from './StaffDeductionsList.module.css';

interface IStaffDeductionsListProps {
  employeeId: number;
}

/**
 * «Удержание» окна сотрудника на «Расчётах», только чтение: сначала плановые (вид — подвид, период, сумма ₽/мес;
 * миграция 357; другая сумма в последнем месяце — строкой ниже, миграция 362), под ними помесячные (вид — подвид,
 * месяц, сумма), новые сверху. Те же записи вносят в
 * «Справочнике» → «Удержания» и во вкладке кадров «Удержания».
 */
export const StaffDeductionsList: FC<IStaffDeductionsListProps> = ({ employeeId }) => {
  // Префикс кадровой вкладки: правка там или в «Справочнике» перечитывает и этот список.
  const query = useQuery({
    queryKey: [...STAFF_DEDUCTIONS_KEY, 'payroll-employee', employeeId],
    queryFn: ({ signal }) => payrollService.getEmployeeStaffDeductions(employeeId, signal),
    staleTime: 0,
  });
  const plannedQuery = useQuery({
    queryKey: [...STAFF_DEDUCTIONS_KEY, 'payroll-employee-planned', employeeId],
    queryFn: ({ signal }) => payrollService.getEmployeePlannedDeductions(employeeId, signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => b.month.localeCompare(a.month) || b.id - a.id),
    [query.data],
  );
  const planned = plannedQuery.data;

  if ((query.isError && !query.data) || (plannedQuery.isError && !planned)) {
    return (
      <p className={styles.error}>
        Не удалось загрузить удержания
        <button
          type="button"
          className={styles.retry}
          onClick={() => { void query.refetch(); void plannedQuery.refetch(); }}
        >
          Повторить
        </button>
      </p>
    );
  }
  if (!query.data || !planned) return null;
  if (rows.length === 0 && planned.length === 0) return <p className={styles.empty}>Нет удержаний</p>;

  return (
    <ul className={styles.list}>
      {planned.map(row => (
        <li key={`planned-${row.id}`} className={styles.row}>
          <span className={styles.kind}>{staffDeductionKindLabel(row)}</span>
          <span className={styles.month}>{plannedDeductionPeriodLabel(row)}</span>
          <span className={styles.amount}>{formatPayrollMoney(row.amount) ?? '—'}/мес</span>
          {row.last_month_amount !== null && row.month_to !== null && (
            <>
              <span className={`${styles.month} ${styles.lastMonth}`}>в {monthNumeric(row.month_to)}</span>
              <span className={styles.amount}>{formatPayrollMoney(row.last_month_amount) ?? '—'}</span>
            </>
          )}
        </li>
      ))}
      {rows.map(row => (
        <li key={row.id} className={styles.row}>
          <span className={styles.kind}>{staffDeductionKindLabel(row)}</span>
          <span className={styles.month}>{formatMonthLabel(row.month)}</span>
          <span className={styles.amount}>{formatPayrollMoney(row.amount) ?? '—'}</span>
        </li>
      ))}
    </ul>
  );
};
