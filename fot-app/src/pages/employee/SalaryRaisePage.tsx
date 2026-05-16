import { type FC } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  STATUS_COLORS,
  STATUS_LABELS,
  type ISalaryRaiseRequest,
} from '../../services/salaryRaiseService';
import { useMySalaryRaiseRequests } from '../../hooks/useSalaryRaiseData';
import styles from './SalaryRaisePage.module.css';

const formatSalary = (value: number | null | undefined): string => {
  if (value == null) return '—';
  return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
};

const formatDate = (value: string): string => new Date(value).toLocaleDateString('ru-RU');

const EMPTY_REQUESTS: ISalaryRaiseRequest[] = [];

export const SalaryRaisePage: FC = () => {
  const navigate = useNavigate();
  const { data, isLoading } = useMySalaryRaiseRequests();
  const requests = data ?? EMPTY_REQUESTS;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.subtitle}>Заявки на повышение для ваших прямых подчинённых.</p>
        </div>
        <button className="btn-primary" onClick={() => navigate('/employee/salary-raise/new')}>
          Новая заявка
        </button>
      </header>

      {isLoading ? (
        <div className={styles.loading}>Загрузка...</div>
      ) : requests.length === 0 ? (
        <div className={styles.empty}>
          <p>У вас пока нет заявок на повышение оклада.</p>
        </div>
      ) : (
        <div className={styles.list}>
          {requests.map((request) => (
            <article
              key={request.id}
              className={styles.card}
              style={{ borderLeftColor: STATUS_COLORS[request.status] }}
              onClick={() => navigate(`/employee/salary-raise/${request.id}`)}
            >
              <div className={styles.cardHeader}>
                <div className={styles.cardHeaderLeft}>
                  <span className={styles.requestType}>{request.employee_snapshot.full_name}</span>
                  <span className={styles.cardDate}>Создана {formatDate(request.created_at)}</span>
                </div>
                <span
                  className={styles.statusBadge}
                  style={{
                    color: STATUS_COLORS[request.status],
                    backgroundColor: `${STATUS_COLORS[request.status]}1A`,
                  }}
                >
                  {STATUS_LABELS[request.status]}
                </span>
              </div>

              <div className={styles.cardBody}>
                <div className={styles.salaryRow}>
                  <span className={styles.salaryLabel}>Оклад:</span>
                  <span className={styles.salaryValue}>{formatSalary(request.current_salary_entered)}</span>
                  <span className={styles.arrow}>→</span>
                  <span className={styles.salaryValue}>{formatSalary(request.requested_salary)}</span>
                  <span className={styles.raisePercent}>+{request.raise_percentage.toFixed(1)}%</span>
                </div>

                <div className={styles.compactGrid}>
                  <div className={styles.compactItem}>
                    <span className={styles.compactLabel}>Объект:</span>
                    <span className={styles.compactValue}>{request.work_object_name || '—'}</span>
                  </div>

                  <div className={styles.compactItem}>
                    <span className={styles.compactLabel}>Руководитель:</span>
                    <span className={styles.compactValue}>
                      {request.manager_snapshot?.full_name || request.employee_snapshot.supervisor_name || '—'}
                    </span>
                  </div>

                  <div className={styles.compactItem}>
                    <span className={styles.compactLabel}>Должность:</span>
                    <span className={styles.compactValue}>{request.employee_snapshot.position_name || '—'}</span>
                  </div>

                  <div className={styles.compactItem}>
                    <span className={styles.compactLabel}>Достижения:</span>
                    <span className={styles.compactValue}>{request.achievements.length}</span>
                  </div>
                </div>

                <div className={styles.cardMeta}>
                  <span>Подразделение: {request.employee_snapshot.department_name || '—'}</span>
                  <span>Создана: {formatDate(request.created_at)}</span>
                  <span>Обновлена: {formatDate(request.updated_at)}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
};
