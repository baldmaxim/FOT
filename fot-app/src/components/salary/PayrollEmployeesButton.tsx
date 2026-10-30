import type { FC } from 'react';
import { Users } from 'lucide-react';

import styles from './PayrollDictionary.module.css';

interface IPayrollEmployeesButtonProps {
  onClick: () => void;
  /** Что за таблица — для экранного диктора: «Сотрудники с удержаниями». */
  ariaLabel: string;
  /** Подпись на кнопке; по умолчанию «Сотрудники». */
  label?: string;
}

/**
 * Кнопка таблицы сотрудников в «Справочнике» — у заголовка «Удержания» («Сотрудники»). С подписью, а не голой
 * иконкой: видно без наведения, что здесь открывается список.
 */
export const PayrollEmployeesButton: FC<IPayrollEmployeesButtonProps> = ({ onClick, ariaLabel, label = 'Сотрудники' }) => (
  <button type="button" className={styles.employeesButton} onClick={onClick} aria-label={ariaLabel}>
    <Users size={16} aria-hidden="true" />
    <span>{label}</span>
  </button>
);
