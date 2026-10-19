import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { dormitoryService, PAYROLL_DORMITORY_STAYS_KEY } from '../../services/dormitoryService';
import { DormitoryStaysPanel } from '../staff/dormitory/DormitoryStaysPanel';
import { PayrollRegistryModal } from './registry/PayrollRegistryModal';

interface IPayrollDormitoryModalProps {
  onClose: () => void;
}

/**
 * «Справочник» → «Общежитие» (кнопка в шапке): кто живёт в общежитии — та же таблица, что во вкладке
 * «Управления кадрами», только для чтения (ведут её кадры).
 */
export const PayrollDormitoryModal: FC<IPayrollDormitoryModalProps> = ({ onClose }) => {
  // Escape закрывает только верхний слой: открыт фильтр столбца — закрывается он.
  const [filterOpen, setFilterOpen] = useState(false);

  const staysQuery = useQuery({
    queryKey: PAYROLL_DORMITORY_STAYS_KEY,
    queryFn: ({ signal }) => dormitoryService.listForPayroll(signal),
    staleTime: 0,
  });

  return (
    <PayrollRegistryModal title="Общежитие" onClose={onClose} closeOnEscape={!filterOpen}>
      <DormitoryStaysPanel
        rows={staysQuery.data}
        isLoading={staysQuery.isLoading}
        isError={staysQuery.isError}
        onRetry={() => { void staysQuery.refetch(); }}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />
    </PayrollRegistryModal>
  );
};
