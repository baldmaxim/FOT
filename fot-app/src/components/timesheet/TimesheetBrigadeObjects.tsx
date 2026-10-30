import type { FC } from 'react';

import { useTimesheetSalary } from '../../hooks/useTimesheetSalary';
import { formatHoursLabel } from '../../utils/hoursDisplay';
import { displayedHours, isOutputClearOnly } from '../../utils/timesheetSalary';
import { TimesheetSalaryOutputInput } from './TimesheetSalaryOutputInput';
import styles from './TimesheetBrigadesTab.module.css';

interface ITimesheetBrigadeObjectsProps {
  departmentId: string;
  month: string;
  canEdit: boolean;
}

const BRIGADE_FILLED = 'Внесена выработка бригаде — сотрите её, чтобы вносить по объектам';

/**
 * Раскрытая бригада во «Бригадах»: её объекты за месяц (та же разбивка, что у «Зарплаты по объектам») и «Выработка, ₽»
 * у каждого. При сумме бригаде поля закрыты — «или — или».
 */
export const TimesheetBrigadeObjects: FC<ITimesheetBrigadeObjectsProps> = ({ departmentId, month, canEdit }) => {
  const salary = useTimesheetSalary({ departmentId, month, enabled: true });
  const data = salary.data?.kind === 'brigade' ? salary.data : undefined;

  if (salary.error) return <div className={styles.objectsNote}>Не удалось загрузить объекты бригады</div>;
  if (salary.loading || !data) return <div className={styles.objectsNote}>Загрузка…</div>;
  const objects = data.objects ?? [];
  if (objects.length === 0) return <div className={styles.objectsNote}>Нет часов бригады на объектах за месяц</div>;
  const byBrigade = data.output_mode === 'brigade';

  return (
    <ul className={styles.objects} aria-label="Объекты бригады">
      {objects.map(object => {
        const hours = object.members.reduce((sum, member) => sum + displayedHours(member.days), 0);
        return (
          <li key={object.object_key} className={styles.objectRow}>
            <span className={styles.objectName}>{object.object_name}</span>
            <span className={styles.objectHours}>{hours > 0 ? formatHoursLabel(hours) : '—'}</span>
            <span className={styles.objectField} title={byBrigade ? BRIGADE_FILLED : undefined}>
              <span className={styles.fieldLabel}>Выработка, ₽</span>
              <TimesheetSalaryOutputInput
                value={object.output_amount}
                canEdit={canEdit && !byBrigade}
                saving={salary.savingObjectKey === object.object_key}
                label={`Выработка, ${object.object_name}`}
                clearOnly={isOutputClearOnly(object)}
                onSave={amount => salary.setObjectOutput(object.object_key, amount)}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
};
