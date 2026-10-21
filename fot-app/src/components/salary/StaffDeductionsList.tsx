import { useId, useMemo, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../../services/payrollService';
import { STAFF_DEDUCTIONS_KEY } from '../../services/staffDeductionService';
import { formatMonthLabel } from '../../utils/formatMoney';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import styles from './StaffDeductionsList.module.css';

interface IStaffDeductionsListProps {
  employeeId: number;
}

/**
 * «Из кадров» в «Удержании» окна сотрудника на «Расчётах»: удержания, внесённые во вкладке «Управление кадрами» →
 * «Удержания» (вид, месяц, сумма), новые сверху, только чтение. Нет таких — блока нет.
 */
export const StaffDeductionsList: FC<IStaffDeductionsListProps> = ({ employeeId }) => {
  const titleId = useId();
  // Префикс кадровой вкладки: правка там перечитывает и этот список.
  const query = useQuery({
    queryKey: [...STAFF_DEDUCTIONS_KEY, 'payroll-employee', employeeId],
    queryFn: ({ signal }) => payrollService.getEmployeeStaffDeductions(employeeId, signal),
    staleTime: 0,
  });
  const rows = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => b.month.localeCompare(a.month) || b.id - a.id),
    [query.data],
  );

  if (query.isError && !query.data) {
    return (
      <p className={styles.error}>
        Не удалось загрузить удержания из кадров
        <button type="button" className={styles.retry} onClick={() => { void query.refetch(); }}>Повторить</button>
      </p>
    );
  }
  if (rows.length === 0) return null;

  return (
    <div className={styles.block}>
      <span id={titleId} className={styles.title}>Из кадров</span>
      <ul className={styles.list} aria-labelledby={titleId}>
        {rows.map(row => (
          <li key={row.id} className={styles.row}>
            <span className={styles.kind}>{row.kind_name}</span>
            <span className={styles.month}>{formatMonthLabel(row.month)}</span>
            <span className={styles.amount}>{formatPayrollMoney(row.amount) ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
