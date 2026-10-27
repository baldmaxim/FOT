import { useState } from 'react';

import { saveHiddenStaffColumns, type StaffTableColumn } from '../utils/staffColumns';

/**
 * Скрытые столбцы «Текущих сотрудников»: состояние и запоминание в браузере.
 * initial — выбор, прочитанный страницей до сортировки и фильтров из URL (loadHiddenStaffColumns).
 * onHide вызывается при скрытии — страница снимает фильтр и сортировку этого столбца,
 * иначе список фильтровался бы по невидимому условию.
 */
export const useStaffHiddenColumns = (
  initial: ReadonlySet<StaffTableColumn>,
  onHide?: (column: StaffTableColumn) => void,
) => {
  const [hidden, setHidden] = useState<Set<StaffTableColumn>>(() => new Set(initial));

  const setColumnVisible = (column: StaffTableColumn, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(column);
    else next.add(column);
    setHidden(next);
    saveHiddenStaffColumns(next);
    if (!visible) onHide?.(column);
  };

  const showAll = () => {
    const next = new Set<StaffTableColumn>();
    setHidden(next);
    saveHiddenStaffColumns(next);
  };

  return { hidden, setColumnVisible, showAll };
};
