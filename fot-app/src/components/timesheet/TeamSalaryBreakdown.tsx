import type { FC } from 'react';

import { PayslipCalcSection } from '../salary/PayslipCalcSection';
import type { TeamSalaryCalc } from '../../services/teamSalaryService';
import { teamSalaryMonthName } from '../../utils/teamSalary';
import styles from './TimesheetTeamSalary.module.css';

interface ITeamSalaryBreakdownProps {
  month: string;
  employeeName: string;
  calc: TeamSalaryCalc;
}

/** Суммы 1С в табеле не показываются: столбец «1С» блока не нужен. */
const NO_1C_AMOUNTS: ReadonlyMap<string, number> = new Map();

/**
 * Расшифровка суммы столбца «Зарплата» — тот же блок «Расчёт ФОТ», что в карточке «Зарплаты»: строки с формулами
 * (оклад × часы / норма, проезд, переработка, выработка × КТУ по объектам, отпускные и больничные), удержания по
 * видам, «Начислено / Удержано / Итого». Без столбца 1С и графиков месяца.
 */
export const TeamSalaryBreakdown: FC<ITeamSalaryBreakdownProps> = ({ month, employeeName, calc }) => (
  <div className={styles.breakdown}>
    <p className={styles.breakdownTitle}>
      <span className={styles.breakdownName}>{employeeName}</span>
      <span className={styles.breakdownMonth}>{teamSalaryMonthName(month)}</span>
    </p>
    <PayslipCalcSection
      month={month}
      loading={false}
      calc={calc}
      schedules={undefined}
      amounts={NO_1C_AMOUNTS}
      accrued1c={null}
      deducted1c={null}
      payout1c={null}
    />
  </div>
);
