import { useState, type FC } from 'react';

import { usePayrollDeductionKinds } from '../../../hooks/usePayrollDeductionKinds';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IDeductionRegistryRow,
} from '../../../services/payrollRegistryService';
import { DeductionRegistryTabs, type IDeductionRegistryApi } from '../../staff/deductions/DeductionRegistryTabs';
import { PayrollRegistryModal } from './PayrollRegistryModal';

interface IDeductionRegistryProps {
  /** Право правки условий оплаты (/salary/terms) — как у прочих таблиц сотрудников «Справочника». */
  canEdit: boolean;
  onClose: () => void;
}

const { plannedDeductions } = payrollRegistryService;

/** «Зарплата»: поиск — «штат зарплаты», запись — через API «Зарплаты», правка строки — по её can_edit. */
const PAYROLL_DEDUCTIONS_API: IDeductionRegistryApi<IDeductionRegistryRow> = {
  staffKey: PAYROLL_REGISTRY_KEYS.deductions,
  plannedKey: PAYROLL_REGISTRY_KEYS.plannedDeductions,
  listStaff: (months, signal) => payrollRegistryService.listDeductions(months.param, signal),
  canEditStaff: row => row.can_edit,
  removeStaff: payrollRegistryService.removeDeduction,
  staffEditor: {
    searchEmployees: payrollRegistryService.searchEmployees,
    add: payrollRegistryService.addDeduction,
    update: payrollRegistryService.updateDeduction,
  },
  planned: plannedDeductions,
  plannedEditor: {
    searchEmployees: payrollRegistryService.searchEmployees,
    add: plannedDeductions.add,
    update: plannedDeductions.update,
  },
  exportMonth: payrollRegistryService.exportTable('deductions'),
  exportPlanned: payrollRegistryService.exportTable('planned-deductions'),
};

/**
 * «Справочник» → «Удержания»: вкладки «Удержания за месяц» и «Плановые удержания» — те же записи, что во вкладке кадров
 * «Удержания» (миграции 321, 357). Охват — «штат зарплаты»: прошлые строки уволенных правят кадры. В окне сотрудника —
 * те же удержания и история плановых, только показ.
 */
export const DeductionRegistry: FC<IDeductionRegistryProps> = ({ canEdit, onClose }) => {
  const kinds = usePayrollDeductionKinds();
  const [overlayOpen, setOverlayOpen] = useState(false);

  return (
    <PayrollRegistryModal title="Удержания" onClose={onClose} closeOnEscape={!overlayOpen}>
      <DeductionRegistryTabs
        api={PAYROLL_DEDUCTIONS_API}
        canEdit={canEdit}
        kinds={kinds.data ?? []}
        raised
        onOverlayChange={setOverlayOpen}
      />
    </PayrollRegistryModal>
  );
};
