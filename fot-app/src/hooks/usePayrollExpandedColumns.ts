import { useCallback, useState } from 'react';

import {
  loadExpandedPayrollColumns,
  saveExpandedPayrollColumns,
  toggleExpandedColumn,
  type PayrollExpandableColumn,
} from '../utils/payrollSubColumns';

/** Раскрытые «+» столбцы «Расчётов»: состояние и запоминание в браузере (как usePayrollHiddenColumns). */
export const usePayrollExpandedColumns = () => {
  const [expanded, setExpanded] = useState<Set<PayrollExpandableColumn>>(loadExpandedPayrollColumns);

  // Стабильна между раскрытиями: таблица в memo.
  const toggleExpanded = useCallback((column: PayrollExpandableColumn) => {
    const next = toggleExpandedColumn(expanded, column);
    setExpanded(next);
    saveExpandedPayrollColumns(next);
  }, [expanded]);

  return { expanded, toggleExpanded };
};
