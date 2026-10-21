import { useMemo, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../../services/payrollService';
import { STAFF_DEDUCTIONS_KEY } from '../../services/staffDeductionService';
import { formatMonthLabel } from '../../utils/formatMoney';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import { staffDeductionKindLabel } from '../../utils/staffDeductionTable';
import styles from './StaffDeductionsList.module.css';

interface IStaffDeductionsListProps {
  employeeId: number;
}

/**
 * «Удержание» окна сотрудника на «Расчётах»: удержания сотрудника (вид — подвид, месяц, сумма), новые сверху, только
 * чтение. Те же записи вносят в «Справочнике» → «Удержания» и во вкладке кадров «Удержания» (миграция 321).
 */
export const StaffDeductionsList: FC<IStaffDeductionsListProps> = ({ employeeId }) => {
  // Префикс кадровой вкладки: правка там или в «Справочнике» перечитывает и этот список.
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
        Не удалось загрузить удержания
        <button type="button" className={styles.retry} onClick={() => { void query.refetch(); }}>Повторить</button>
      </p>
    );
  }
  if (!query.data) return null;
  if (rows.length === 0) return <p className={styles.empty}>Нет удержаний</p>;

  return (
    <ul className={styles.list}>
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
