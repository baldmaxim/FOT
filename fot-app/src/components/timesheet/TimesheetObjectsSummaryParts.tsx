import type { FC } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import type { ITimesheetObjectsSummaryBrigade } from '../../types/timesheet';
import {
  brigadeHourRate,
  brigadeHourRateTitle,
  exclusionText,
  formatCountedHours,
  objectHourRate,
  objectHourRateTitle,
  rateCoverageNote,
  type IObjectsSummaryView,
} from '../../utils/brigadeObjectsSummary';
import { formatSalaryAmount } from '../../utils/timesheetSalary';
import styles from './TimesheetObjectsSummary.module.css';

/** Бригада на объекте: итоги пары, причина, если не вошла в стоимость часа, и люди. */
const BrigadeBlock: FC<{ brigade: ITimesheetObjectsSummaryBrigade }> = ({ brigade }) => {
  const rate = brigadeHourRate(brigade);
  const reason = exclusionText(brigade);
  return (
    <li className={styles.brigade}>
      <div className={styles.brigadeHead}>
        <span className={styles.brigadeName}>{brigade.name}</span>
        <span className={styles.meta}>{brigade.people} чел.</span>
        <span className={styles.meta}>учтено {formatCountedHours(brigade.counted_minutes)} ч</span>
        {brigade.output_amount !== null && (
          <span className={styles.meta}>выработка {formatSalaryAmount(brigade.output_amount)}</span>
        )}
        {reason && <span className={styles.reason}>{reason}</span>}
        {rate !== null && (
          <span className={styles.brigadeRate} title={brigadeHourRateTitle(brigade)}>
            {formatSalaryAmount(rate)} ₽/ч
          </span>
        )}
      </div>
      {brigade.members === null ? (
        <p className={styles.note}>Состав скрыт: нет доступа к табелю бригады</p>
      ) : brigade.members.length > 0 && (
        <table className={styles.members}>
          <thead>
            <tr>
              <th scope="col">ФИО</th>
              <th scope="col">Часы</th>
              <th scope="col">Учтено, ч</th>
            </tr>
          </thead>
          <tbody>
            {brigade.members.map(member => (
              <tr key={member.employee_id}>
                <td className={styles.memberName}>{member.full_name}</td>
                <td>{member.hours}</td>
                <td>{formatCountedHours(member.counted_minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
};

interface IObjectRowProps {
  view: IObjectsSummaryView;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}

/** Строка объекта: люди, учтённые часы, выработка и стоимость часа; под стрелкой — бригады и их люди. */
export const ObjectRow: FC<IObjectRowProps> = ({ view, index, expanded, onToggle }) => {
  const { object, brigades } = view;
  const rate = objectHourRate(object);
  const coverage = rateCoverageNote(object);
  return (
    <li className={styles.item}>
      <div className={styles.row}>
        <span className={styles.index}>{index}.</span>
        <span className={styles.name}>{object.object_name}</span>
        <span className={`${styles.cell} ${styles.people}`}>
          <span className={styles.cellLabel}>Людей</span>
          <span className={styles.value}>{object.people}</span>
        </span>
        <span className={`${styles.cell} ${styles.counted}`}>
          <span className={styles.cellLabel}>Учтено, ч</span>
          <span className={styles.value}>{formatCountedHours(object.counted_minutes)}</span>
        </span>
        <span className={`${styles.cell} ${styles.output}`}>
          <span className={styles.cellLabel}>Выработка, ₽</span>
          <span className={styles.value}>{formatSalaryAmount(object.output_total)}</span>
        </span>
        <span className={`${styles.cell} ${styles.rate}`}>
          <span className={styles.cellLabel}>Час, ₽/ч</span>
          <span className={styles.rateValue} title={objectHourRateTitle(object)}>
            <span className={styles.value}>{formatSalaryAmount(rate)}</span>
            {coverage && <span className={styles.coverage}>{coverage}</span>}
          </span>
        </span>
        <button
          type="button"
          className={styles.toggle}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Скрыть бригады: ${object.object_name}` : `Бригады и люди: ${object.object_name}`}
        >
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>
      {expanded && (
        <ul className={styles.brigades} aria-label={`Бригады на объекте ${object.object_name}`}>
          {brigades.map(brigade => <BrigadeBlock key={brigade.department_id} brigade={brigade} />)}
        </ul>
      )}
    </li>
  );
};
