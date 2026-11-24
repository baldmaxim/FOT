import { useState, type FC } from 'react';

import type { ITimesheetObjectsSummary } from '../../types/timesheet';
import type { IObjectsSummaryView } from '../../utils/brigadeObjectsSummary';
import { ObjectRow } from './TimesheetObjectsSummaryParts';
import styles from './TimesheetObjectsSummary.module.css';

interface ITimesheetObjectsSummaryProps {
  data: ITimesheetObjectsSummary | undefined;
  /** Объекты после поиска. */
  views: readonly IObjectsSummaryView[];
  loading: boolean;
  error: boolean;
}

/**
 * «Бригады → Объекты»: объекты месяца по всем бригадам — люди, учтённые часы, выработка и стоимость часа; под стрелкой —
 * бригады объекта и их люди. Только просмотр: выработку вносят в режиме «Бригады».
 */
export const TimesheetObjectsSummary: FC<ITimesheetObjectsSummaryProps> = ({ data, views, loading, error }) => {
  // Найденный внутри объект (человек, бригада) показан раскрытым; стрелка переключает от этого состояния.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setToggled(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  if (error) return <div className="ts-loading">Не удалось загрузить объекты</div>;
  if (loading || !data) return <div className="ts-loading">Загрузка…</div>;

  const failed = data.failed_brigades.length > 0 && (
    <p className={styles.failed}>Не удалось посчитать: {data.failed_brigades.map(item => item.name).join(', ')}</p>
  );
  if (views.length === 0) {
    return (
      <>
        {failed}
        <div className="ts-loading">{data.objects.length === 0 ? 'Нет объектов за месяц' : 'Ничего не найдено'}</div>
      </>
    );
  }

  return (
    <div className={styles.scroll}>
      {failed}
      <div className={styles.columns} aria-hidden="true">
        <span>№</span>
        <span>Объект</span>
        <span className={styles.numeric}>Людей</span>
        <span className={styles.numeric}>Учтено, ч</span>
        <span className={styles.numeric}>Выработка, ₽</span>
        <span className={styles.numeric}>Час, ₽/ч</span>
        <span />
      </div>
      <ul className={styles.list}>
        {views.map((view, index) => (
          <ObjectRow
            key={view.object.object_key}
            view={view}
            index={index + 1}
            expanded={view.matchedInside !== toggled.has(view.object.object_key)}
            onToggle={() => toggle(view.object.object_key)}
          />
        ))}
      </ul>
    </div>
  );
};
