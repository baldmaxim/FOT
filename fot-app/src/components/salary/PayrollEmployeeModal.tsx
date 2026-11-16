import type { FC } from 'react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import type { IPayrollCardView, PayrollCardTab } from '../../utils/payrollViews';
import { ModalShell } from '../ui/ModalShell';
import { EmployeePayrollDetails } from './EmployeePayrollDetails';
import modal from './PayrollModal.module.css';
import styles from './PayrollEmployeeModal.module.css';

interface IPayrollEmployeeModalProps {
  row: IPayrollTermsRow;
  /** Дата выборки условий — предзаполняет «Действует с». */
  defaultDate: string;
  onClose: () => void;
  /** Сохранено: окно закрывается само, родитель закрывает устаревшую карточку «Подробно» этого сотрудника. */
  onSaved: (employeeId: number) => void;
  /** Вкладка карточки при возврате из табеля. */
  initialView?: IPayrollCardView;
  /** Клик по ФИО: табель сотрудника в этой же вкладке браузера. */
  onLeaveToTimesheet?: (tab: PayrollCardTab) => void;
}

/**
 * Окно «Расчётов»: карточка сотрудника с вводом — оклад, компенсация, доплата, удержания; «Оплачено» — в «Подробно».
 * Закрывается только крестиком и «Отменой»; после сохранения — само. Enter, Escape и клик мимо окна не закрывают.
 */
export const PayrollEmployeeModal: FC<IPayrollEmployeeModalProps> = ({
  row,
  defaultDate,
  onClose,
  onSaved,
  initialView,
  onLeaveToTimesheet,
}) => (
  <ModalShell
    onClose={onClose}
    closeOnEscape={false}
    closeOnOverlayClick={false}
    overlayClassName={modal.overlay}
    containerClassName={styles.container}
    aria-label={row.full_name ?? 'Сотрудник'}
  >
    {({ requestClose }) => (
      <EmployeePayrollDetails
        row={row}
        defaultDate={defaultDate}
        editable
        className={styles.card}
        active
        initialView={initialView}
        onLeaveToTimesheet={onLeaveToTimesheet}
        onClose={requestClose}
        onSaved={employeeId => {
          onSaved(employeeId);
          requestClose();
        }}
      />
    )}
  </ModalShell>
);
