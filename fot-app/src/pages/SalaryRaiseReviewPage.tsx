import { type FC, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  STATUS_COLORS,
  type ISalaryRaiseRequest,
} from '../services/salaryRaiseService';
import { useSalaryRaiseReviewList } from '../hooks/useSalaryRaiseData';
import './SalaryRaiseReviewPage.css';

const formatSalary = (value: number | null | undefined): string => {
  if (value == null) return '—';
  return new Intl.NumberFormat('ru-RU').format(value) + ' \u20BD';
};

const formatDate = (date: string): string =>
  new Date(date).toLocaleDateString('ru-RU');

type FilterTab = 'pending' | 'all';
const EMPTY_REQUESTS: ISalaryRaiseRequest[] = [];

export const SalaryRaiseReviewPage: FC = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canViewAll = hasPermission('data.scope.all');

  const [filter, setFilter] = useState<FilterTab>('pending');
  const { data, isLoading } = useSalaryRaiseReviewList(filter, canViewAll);
  const requests = data ?? EMPTY_REQUESTS;

  return (
    <div className="srr-page">
      <div className="srr-header">
        <h1 className="srr-title">Заявки на повышение оклада</h1>
        <div className="srr-filter">
          <button
            className={`srr-filter-btn ${filter === 'pending' ? 'active' : ''}`}
            onClick={() => setFilter('pending')}
          >
            Ожидающие
          </button>
          {canViewAll && (
            <button
              className={`srr-filter-btn ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              Все
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="srr-loading">Загрузка...</div>
      ) : requests.length === 0 ? (
        <div className="srr-empty">Нет заявок на рассмотрении</div>
      ) : (
        <div className="srr-list">
          {requests.map((r) => {
            const snapshot = r.employee_snapshot;
            const currentSalary = snapshot?.current_salary;
            const employeeName = snapshot?.full_name || `Сотрудник #${r.employee_id}`;
            const raisePercent = r.raise_percentage != null && r.raise_percentage !== 0
              ? r.raise_percentage.toFixed(1)
              : null;

            return (
              <div
                key={r.id}
                className="srr-card"
                onClick={() => navigate(`/salary-raise-review/${r.id}`)}
              >
                <div className="srr-card-top">
                  <span className="srr-card-employee">{employeeName as string}</span>
                  <span
                    className="srr-status"
                    style={{
                      backgroundColor: STATUS_COLORS[r.status] + '1a',
                      color: STATUS_COLORS[r.status],
                    }}
                  >
                    {STATUS_LABELS[r.status]}
                  </span>
                </div>

                <div className="srr-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>

                <div className="srr-salary-row">
                  <span className="srr-salary-label">Оклад:</span>
                  <span className="srr-salary-value">{formatSalary(currentSalary as number)}</span>
                  <span className="srr-arrow">&rarr;</span>
                  <span className="srr-salary-value">{formatSalary(r.requested_salary)}</span>
                  {raisePercent && (
                    <span className="srr-raise-pct">+{raisePercent}%</span>
                  )}
                </div>

                {r.reason_brief && (
                  <div className="srr-card-reason">{r.reason_brief}</div>
                )}

                <div className="srr-card-meta">
                  <span>Желаемая дата: {formatDate(r.desired_effective_date)}</span>
                  <span>Создана: {formatDate(r.created_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
