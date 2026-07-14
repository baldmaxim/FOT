import { useState, type FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, X } from 'lucide-react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { DashboardPeriod, IDashboardStats } from '../../types';

// Рейтинг опозданий — модалка «Обзора». Вынесена из DashboardPage, чтобы страница
// осталась в пределах лимита размера файла.

interface ILateRatingModalProps {
  topLate: IDashboardStats['topLate'];
  period: DashboardPeriod;
  /** State для возврата на «Обзор» из карточки сотрудника. */
  backState: { label: string; from: string };
  onClose: () => void;
}

const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: 'сегодня',
  week: 'неделю',
  month: 'месяц',
};

export const LateRatingModal: FC<ILateRatingModalProps> = ({ topLate, period, backState, onClose }) => {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const navigate = useNavigate();
  const overlayDismiss = useOverlayDismiss(onClose);

  return (
    <div className="dash-modal-overlay" {...overlayDismiss}>
      <div className={`dash-modal ${period !== 'today' ? 'dash-modal--period' : ''}`}>
        <div className="dash-modal-header">
          <span>Опоздания за {PERIOD_LABELS[period]}</span>
          <button className="dash-modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="dash-modal-body">
          {topLate.length === 0 ? (
            <div className="dash-modal-empty">Опозданий нет</div>
          ) : (
            topLate.map((item, i) => {
              const isExpanded = expandedId === item.employee_id;
              return (
                <div key={item.employee_id} className="dash-late-group">
                  <div
                    className="dash-late-row"
                    onClick={() => setExpandedId(isExpanded ? null : item.employee_id)}
                  >
                    <span className="dash-late-rank">{i + 1}</span>
                    <div className="dash-late-info">
                      <div className="dash-late-name">{item.full_name}</div>
                      <div className="dash-late-avg">~{item.avgArrival}</div>
                    </div>
                    <span className="dash-late-count">{item.lateCount}</span>
                    <ChevronDown size={14} className={`dash-late-chevron ${isExpanded ? 'dash-late-chevron--open' : ''}`} />
                  </div>
                  {isExpanded && (
                    <div className="dash-late-details">
                      {(item.lateDetails || []).map(d => (
                        <div key={d.date} className="dash-late-detail-row">
                          <span className="dash-late-detail-date">
                            {new Date(d.date + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' })}
                          </span>
                          <span className="dash-late-detail-time">{d.arrival}</span>
                        </div>
                      ))}
                      <div
                        className="dash-late-detail-link"
                        onClick={() => {
                          onClose();
                          navigate(`/employees/${item.employee_id}`, { state: backState });
                        }}
                      >
                        Открыть карточку →
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
