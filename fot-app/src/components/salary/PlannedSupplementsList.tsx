import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { employeePlannedSupplementsQueryOptions } from '../../hooks/useEmployeePlannedSupplements';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import { supplementPeriod } from '../../utils/payrollRegistries';
import styles from './PlannedSupplementsList.module.css';

interface IPlannedSupplementsListProps {
  employeeId: number;
}

/**
 * «Плановые доплаты» в окне сотрудника и в «Подробно», только чтение: действующие доплаты (миграция 369 — их может
 * быть несколько на одни даты), последняя по дате — первой: сумма ₽/мес, период, комментарий. Вносят и правят в
 * «Справочнике» → «Доплата» → «Плановые доплаты».
 */
export const PlannedSupplementsList: FC<IPlannedSupplementsListProps> = ({ employeeId }) => {
  const query = useQuery(employeePlannedSupplementsQueryOptions(employeeId));

  if (query.isError && !query.data) {
    return (
      <p className={styles.error}>
        Не удалось загрузить плановые доплаты
        <button type="button" className={styles.retry} onClick={() => { void query.refetch(); }}>
          Повторить
        </button>
      </p>
    );
  }
  if (!query.data) return null;
  if (query.data.length === 0) return <p className={styles.empty}>Нет плановых доплат</p>;

  return (
    <ul className={styles.list}>
      {query.data.map(row => (
        <li key={row.id} className={styles.row}>
          <span className={styles.amount}>{formatPayrollMoney(row.amount) ?? '—'}/мес</span>
          <span className={styles.period}>
            {supplementPeriod({ kind: 'planned', month: null, date_from: row.date_from, date_to: row.date_to })}
          </span>
          {row.comment && <span className={styles.comment}>{row.comment}</span>}
        </li>
      ))}
    </ul>
  );
};
