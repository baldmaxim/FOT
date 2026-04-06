import { type FC } from 'react';
import { TrendingUp, TrendingDown, Minus, Briefcase } from 'lucide-react';
import type { EmployeeHistoryEvent } from '../../types';

interface IEmployeeHistorySectionProps {
  history: EmployeeHistoryEvent[];
}

const formatDate = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

const formatSalary = (salary: number | null | undefined) => {
  if (!salary) return '—';
  return salary.toLocaleString('ru-RU') + ' ₽';
};

const formatDelta = (delta: number) => {
  const sign = delta > 0 ? '+' : '';
  return sign + delta.toLocaleString('ru-RU') + ' ₽';
};

const getAssignmentTitle = (data: Record<string, unknown>): string => {
  if (data.type === 'hire' || data.type === 'Прием') return 'Принят на работу';
  if (data.type === 'transfer' || data.type === 'Перевод') return 'Перевод';
  if (data.type === 'dismiss' || data.type === 'Увольнение') return 'Увольнение';
  return 'Назначение';
};

export const EmployeeHistorySection: FC<IEmployeeHistorySectionProps> = ({ history }) => {
  if (history.length === 0) {
    return <div className="ec-history-empty">Нет записей в истории</div>;
  }

  // Выделяем salary events отсортированные по дате для вычисления дельты
  const salaryEvents = history
    .filter(e => e.event_type === 'salary')
    .sort((a, b) => a.event_date.localeCompare(b.event_date));

  const salaryDeltas = new Map<string, number>();
  for (let i = 1; i < salaryEvents.length; i++) {
    const prev = (salaryEvents[i - 1].event_data as Record<string, unknown>).salary as number;
    const curr = (salaryEvents[i].event_data as Record<string, unknown>).salary as number;
    if (prev && curr) {
      salaryDeltas.set(salaryEvents[i].event_id, curr - prev);
    }
  }

  return (
    <div className="ec-history-timeline">
      {history.map(event => {
        const data = event.event_data as Record<string, unknown>;

        if (event.event_type === 'salary') {
          const salary = data.salary as number | null;
          const delta = salaryDeltas.get(event.event_id);
          const isFirst = salaryEvents[0]?.event_id === event.event_id;
          const reason = String(data.reason || '');
          const isHire = reason.toLowerCase().includes('приеме') || reason.toLowerCase().includes('приём');

          return (
            <div key={event.event_id} className="ec-history-item ec-history-salary">
              <div className="ec-history-date-col">
                <span className="ec-history-date-text">{formatDate(event.event_date)}</span>
              </div>
              <div className="ec-history-line">
                <div className={`ec-history-dot ${delta && delta > 0 ? 'green' : delta && delta < 0 ? 'red' : 'gray'}`} />
              </div>
              <div className="ec-history-card">
                <div className="ec-history-card-top">
                  <span className="ec-history-salary-amount">{formatSalary(salary)}</span>
                  {delta != null && delta !== 0 && (
                    <span className={`ec-history-delta ${delta > 0 ? 'up' : 'down'}`}>
                      {delta > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {formatDelta(delta)}
                    </span>
                  )}
                  {isFirst && !delta && (
                    <span className="ec-history-delta neutral">
                      <Minus size={12} /> старт
                    </span>
                  )}
                </div>
                <div className="ec-history-card-label">
                  {isHire ? 'Оклад при приёме' : isFirst ? 'Начальный оклад' : 'Изменение оклада'}
                </div>
              </div>
            </div>
          );
        }

        // Assignment event
        return (
          <div key={event.event_id} className="ec-history-item ec-history-assignment">
            <div className="ec-history-date-col">
              <span className="ec-history-date-text">{formatDate(event.event_date)}</span>
              {event.event_end_date && (
                <span className="ec-history-date-end">— {formatDate(event.event_end_date)}</span>
              )}
            </div>
            <div className="ec-history-line">
              <div className="ec-history-dot blue" />
            </div>
            <div className="ec-history-card">
              <div className="ec-history-card-top">
                <Briefcase size={14} className="ec-history-assign-icon" />
                <span className="ec-history-assign-title">{getAssignmentTitle(data)}</span>
              </div>
              {(data.position || data.department) && (
                <div className="ec-history-card-details">
                  {data.position && <span>{String(data.position)}</span>}
                  {data.department && <span className="ec-history-dept">{String(data.department)}</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
