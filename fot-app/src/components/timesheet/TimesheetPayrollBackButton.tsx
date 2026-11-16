import type { FC } from 'react';
import { ArrowLeft } from 'lucide-react';

import styles from './TimesheetPayrollBackButton.module.css';

interface ITimesheetPayrollBackButtonProps {
  onClick: () => void;
}

/** «← Зарплата» в шапке табеля, открытого из окна «Расчётов»: назад в это окно. */
export const TimesheetPayrollBackButton: FC<ITimesheetPayrollBackButtonProps> = ({ onClick }) => (
  <button type="button" className={styles.button} onClick={onClick} aria-label="Назад: Зарплата">
    <ArrowLeft size={16} aria-hidden="true" />
    <span>Зарплата</span>
  </button>
);
