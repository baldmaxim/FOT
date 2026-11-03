import type { FC } from 'react';

import { useBrigadeObjectOutputs } from '../../hooks/useBrigadeObjectOutputs';
import { formatHoursLabel } from '../../utils/hoursDisplay';
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
 * у каждого. При сумме бригаде поля закрыты — «или — или». Данные — без людей и их сумм: вкладка открыта и тем, кому
 * расчёт этой бригады не положен.
 */
export const TimesheetBrigadeObjects: FC<ITimesheetBrigadeObjectsProps> = ({ departmentId, month, canEdit }) => {
  const outputs = useBrigadeObjectOutputs({ departmentId, month });

  if (outputs.error) return <div className={styles.objectsNote}>Не удалось загрузить объекты бригады</div>;
  if (outputs.loading || !outputs.data) return <div className={styles.objectsNote}>Загрузка…</div>;
  const { objects, output_mode: outputMode } = outputs.data;
  if (objects.length === 0) return <div className={styles.objectsNote}>Нет часов бригады на объектах за месяц</div>;
  const byBrigade = outputMode === 'brigade';

  return (
    <ul className={styles.objects} aria-label="Объекты бригады">
      {objects.map(object => (
        <li key={object.object_key} className={styles.objectRow}>
          <span className={styles.objectName}>{object.object_name}</span>
          <span className={styles.objectHours}>{object.hours > 0 ? formatHoursLabel(object.hours) : '—'}</span>
          <span className={styles.objectField} title={byBrigade ? BRIGADE_FILLED : undefined}>
            <span className={styles.fieldLabel}>Выработка, ₽</span>
            <TimesheetSalaryOutputInput
              value={object.output_amount}
              canEdit={canEdit && !byBrigade}
              saving={outputs.savingObjectKey === object.object_key}
              label={`Выработка, ${object.object_name}`}
              clearOnly={object.clear_only}
              onSave={amount => outputs.setObjectOutput(object.object_key, amount)}
            />
          </span>
        </li>
      ))}
    </ul>
  );
};
