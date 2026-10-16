import { useId, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { dormitoryService, PAYROLL_DORMITORY_STAYS_KEY } from '../../services/dormitoryService';
import { DormitoryStaysPanel } from '../staff/dormitory/DormitoryStaysPanel';
import { ModalShell } from '../ui/ModalShell';
import modal from './PayrollModal.module.css';
import styles from './PayrollDormitoryModal.module.css';

interface IPayrollDormitoryModalProps {
  onClose: () => void;
}

/**
 * «Справочник» → «Ставки» → «Проживание общежития»: кто живёт в общежитии — та же таблица, что во
 * вкладке «Управления кадрами», только для чтения (ведут её кадры). Окно поверх «Справочника» —
 * через портал: внутри окна с transform и overflow: hidden fixed-слой обрезался бы.
 */
export const PayrollDormitoryModal: FC<IPayrollDormitoryModalProps> = ({ onClose }) => {
  const titleId = useId();
  // Escape закрывает только верхний слой: открыт фильтр столбца — закрывается он.
  const [filterOpen, setFilterOpen] = useState(false);

  const staysQuery = useQuery({
    queryKey: PAYROLL_DORMITORY_STAYS_KEY,
    queryFn: ({ signal }) => dormitoryService.listForPayroll(signal),
    staleTime: 0,
  });

  return createPortal(
    <ModalShell
      onClose={onClose}
      overlayClassName={`${modal.overlay} ${styles.overlay}`}
      containerClassName={styles.container}
      closeOnEscape={!filterOpen}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={modal.header}>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>Проживание общежития</h2>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={modal.body}>
            <DormitoryStaysPanel
              rows={staysQuery.data}
              isLoading={staysQuery.isLoading}
              isError={staysQuery.isError}
              onRetry={() => { void staysQuery.refetch(); }}
              raisedFilters
              onFilterOpenChange={setFilterOpen}
            />
          </div>
        </>
      )}
    </ModalShell>,
    document.body,
  );
};
