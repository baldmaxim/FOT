import type { FC } from 'react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { ModalShell } from '../ui/ModalShell';
import { EmployeePayrollDetails } from './EmployeePayrollDetails';
import modal from './PayrollModal.module.css';
import styles from './PayrollEmployeeModal.module.css';

interface IPayrollEmployeeModalProps {
  row: IPayrollTermsRow;
  /** Дата выборки условий — предзаполняет «Действует с». */
  defaultDate: string;
  /** Месяц новой строки удержания — выбранный на «Расчётах». */
  deductionMonth: string;
  onClose: () => void;
  /** Сохранено: окно закрывается само, родитель закрывает устаревшую карточку «Подробно» этого сотрудника. */
  onSaved: (employeeId: number) => void;
}

/**
 * Окно «Расчётов»: карточка сотрудника целиком (как «Подробно») — оклад, компенсация, доплата, удержания.
 * Закрывается «Отменой», Escape и кликом мимо окна; после сохранения — само.
 */
export const PayrollEmployeeModal: FC<IPayrollEmployeeModalProps> = ({
  row,
  defaultDate,
  deductionMonth,
  onClose,
  onSaved,
}) => (
  <ModalShell
    onClose={onClose}
    overlayClassName={modal.overlay}
    containerClassName={styles.container}
    aria-label={row.full_name ?? 'Сотрудник'}
  >
    {({ requestClose }) => (
      <EmployeePayrollDetails
        row={row}
        defaultDate={defaultDate}
        deductionMonth={deductionMonth}
        className={styles.card}
        active
        onClose={requestClose}
        onSaved={employeeId => {
          onSaved(employeeId);
          requestClose();
        }}
      />
    )}
  </ModalShell>
);
