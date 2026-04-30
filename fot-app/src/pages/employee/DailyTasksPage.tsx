import { type FC } from 'react';
import { useMyDailyTasks } from '../../hooks/usePortalData';
import type { IDailyTask } from '../../services/dailyTaskService';
import './DailyTasksPage.css';

const EMPTY: IDailyTask[] = [];

const formatTaskDate = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    weekday: 'long',
  });
};

export const DailyTasksPage: FC = () => {
  const { data, isLoading } = useMyDailyTasks();
  const tasks = data ?? EMPTY;

  return (
    <div className="dt-page">
      <div className="dt-header">
        <h1 className="dt-title">Мои задачи</h1>
      </div>

      {isLoading ? (
        <div className="dt-loading">Загрузка...</div>
      ) : tasks.length === 0 ? (
        <div className="dt-empty">Нет записей. Заполняйте поле «Задачи на сегодня» на главной — записи будут попадать сюда.</div>
      ) : (
        <div className="dt-list">
          {tasks.map(task => (
            <div key={task.id} className="dt-card">
              <div className="dt-card-date">{formatTaskDate(task.task_date)}</div>
              <div className="dt-card-content">{task.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
