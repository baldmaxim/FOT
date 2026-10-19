import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type IDeductionRegistryRow,
} from '../../../services/payrollRegistryService';
import { buildDeductionExport, DEDUCTION_COLUMNS } from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from './PayrollRegistryModal';

interface IDeductionRegistryProps {
  onClose: () => void;
}

const sendExport = payrollRegistryService.exportTable('deductions');
const rowKey = (row: IDeductionRegistryRow): number => row.employee_id;
const rowName = (row: IDeductionRegistryRow): string => row.full_name;

/**
 * «Справочник» → «Удержания»: у кого есть вид удержания или сумма удержания в условиях на сегодня.
 * Только просмотр — удержания вносят в окне сотрудника на «Расчётах».
 */
export const DeductionRegistry: FC<IDeductionRegistryProps> = ({ onClose }) => {
  const [filterOpen, setFilterOpen] = useState(false);

  const query = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.deductions,
    queryFn: ({ signal }) => payrollRegistryService.listDeductions(signal),
    staleTime: 0,
  });

  return (
    <PayrollRegistryModal title="Удержания" onClose={onClose} closeOnEscape={!filterOpen}>
      <RegistryPanel
        label="Удержания"
        columns={DEDUCTION_COLUMNS}
        rows={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        buildExport={buildDeductionExport}
        sendExport={sendExport}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />
    </PayrollRegistryModal>
  );
};
