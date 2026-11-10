import { useState, type FC } from 'react';
import { ListChecks } from 'lucide-react';

import { useAuth } from '../../../contexts/AuthContext';
import { useStaffDeductionKinds } from '../../../hooks/useStaffDeductionKinds';
import {
  STAFF_DEDUCTIONS_KEY,
  staffDeductionService,
  type IStaffDeduction,
} from '../../../services/staffDeductionService';
import { staffDeductionInMonths } from '../../../utils/staffDeductionTable';
import { DeductionKindsModal } from './DeductionKindsModal';
import { DeductionRegistryTabs, type IDeductionRegistryApi } from './DeductionRegistryTabs';

const { planned } = staffDeductionService;

/** Кадры: поиск и запись — через API кадров (право /staff-control/deductions), строки правит право вкладки. */
const STAFF_DEDUCTIONS_API: IDeductionRegistryApi<IStaffDeduction> = {
  staffKey: STAFF_DEDUCTIONS_KEY,
  plannedKey: [...STAFF_DEDUCTIONS_KEY, 'planned'],
  // Сервер кадров отдаёт все удержания охвата — месяцы отбираются здесь.
  listStaff: async (months, signal) => (await staffDeductionService.list(signal))
    .filter(row => staffDeductionInMonths(row, months.value)),
  canEditStaff: () => true,
  removeStaff: staffDeductionService.remove,
  staffEditor: {
    searchEmployees: staffDeductionService.searchEmployees,
    add: staffDeductionService.add,
    update: staffDeductionService.update,
  },
  planned,
  plannedEditor: {
    searchEmployees: staffDeductionService.searchEmployees,
    add: planned.add,
    update: planned.update,
  },
  exportMonth: staffDeductionService.exportTable,
  exportPlanned: staffDeductionService.exportPlannedTable,
};

/**
 * «Управление кадрами» → «Удержания» (миграции 318, 321, 357): вкладки «Удержания за месяц» (помесячные и плановые
 * выбранных месяцев) и «Плановые удержания» (периоды). Те же записи — в «Зарплате» («Справочник» → «Удержания»).
 * С правом «Редактирование» — «Добавить сотрудника», ✎ и 🗑; «Виды удержаний» — справочник с подвидами, общий с
 * «Зарплатой»; «Экспорт» — ровно таблица экрана.
 */
export const DeductionsTab: FC = () => {
  const { isAdmin, canEditPage, profile } = useAuth();
  const canEdit = isAdmin || canEditPage('/staff-control/deductions');
  // Справочник видов общий с «Зарплатой»: правит только роль, персональная галочка (миграция 351) — нет.
  const canEditKinds = isAdmin || profile?.staff_tab_role_edit?.deductions === true;
  const [kindsOpen, setKindsOpen] = useState(false);
  const kinds = useStaffDeductionKinds();

  return (
    <>
      <DeductionRegistryTabs
        api={STAFF_DEDUCTIONS_API}
        canEdit={canEdit}
        kinds={kinds.data ?? []}
        toolbarAction={{ label: 'Виды удержаний', icon: ListChecks, onClick: () => setKindsOpen(true) }}
      />

      {kindsOpen && <DeductionKindsModal canEdit={canEditKinds} onClose={() => setKindsOpen(false)} />}
    </>
  );
};
