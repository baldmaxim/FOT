import { useState } from 'react';

import {
  loadHiddenPayrollColumns,
  saveHiddenPayrollColumns,
  type PayrollTableColumn,
  type PayrollTableColumns,
} from '../utils/payrollColumns';

/**
 * Скрытые столбцы таблицы «Условия оплаты» («Расчётов» — под своим ключом): состояние и запоминание в браузере.
 * Учитываются только столбцы columns — чужие ключи из хранилища отбрасываются.
 * onHide вызывается при скрытии — страница снимает фильтр и сортировку этого столбца,
 * иначе список фильтровался бы по невидимому условию.
 */
export const usePayrollHiddenColumns = (
  storageKey: string,
  columns: PayrollTableColumns,
  onHide?: (column: PayrollTableColumn) => void,
) => {
  const [hidden, setHidden] = useState<Set<PayrollTableColumn>>(() => loadHiddenPayrollColumns(storageKey, columns));

  const setColumnVisible = (column: PayrollTableColumn, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(column);
    else next.add(column);
    setHidden(next);
    saveHiddenPayrollColumns(storageKey, next);
    if (!visible) onHide?.(column);
  };

  const showAll = () => {
    const next = new Set<PayrollTableColumn>();
    setHidden(next);
    saveHiddenPayrollColumns(storageKey, next);
  };

  return { hidden, setColumnVisible, showAll };
};
