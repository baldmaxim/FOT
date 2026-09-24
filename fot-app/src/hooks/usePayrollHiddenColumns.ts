import { useState } from 'react';

import {
  loadHiddenPayrollColumns,
  saveHiddenPayrollColumns,
  type PayrollTableColumn,
} from '../utils/payrollColumns';

/**
 * Скрытые столбцы таблицы «Условия оплаты»: состояние и запоминание в браузере.
 * onHide вызывается при скрытии — страница снимает фильтр и сортировку этого столбца,
 * иначе список фильтровался бы по невидимому условию.
 */
export const usePayrollHiddenColumns = (onHide?: (column: PayrollTableColumn) => void) => {
  const [hidden, setHidden] = useState<Set<PayrollTableColumn>>(loadHiddenPayrollColumns);

  const setColumnVisible = (column: PayrollTableColumn, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(column);
    else next.add(column);
    setHidden(next);
    saveHiddenPayrollColumns(next);
    if (!visible) onHide?.(column);
  };

  const showAll = () => {
    const next = new Set<PayrollTableColumn>();
    setHidden(next);
    saveHiddenPayrollColumns(next);
  };

  return { hidden, setColumnVisible, showAll };
};
