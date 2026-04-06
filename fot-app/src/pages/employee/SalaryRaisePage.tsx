import { type FC, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  salaryRaiseService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  STATUS_COLORS,
  type ISalaryRaiseRequest,
} from '../../services/salaryRaiseService';
import styles from './SalaryRaisePage.module.css';

const formatSalary = (value: number | null | undefined): string => {
  if (value == null) return '—';
  return new Intl.NumberFormat('ru-RU').format(value) + ' ₽';
};

const formatDate = (date: string): string =>
  new Date(date).toLocaleDateString('ru-RU');

export const SalaryRaisePage: FC = () => {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<ISalaryRaiseRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await salaryRaiseService.getMy();
      setRequests(res.data);
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Заявки на повышение оклада</h1>
        <button
          className={styles.createBtn}
          onClick={() => navigate('/employee/salary-raise/new')}
        >
          Создать заявку
        </button>
      </header>

      {loading ? (
        <div className={styles.loading}>Загрузка...</div>
      ) : requests.length === 0 ? (
        <div className={styles.empty}>
          <p>У вас пока нет заявок на повышение оклада</p>
        </div>
      ) : (
        <div className={styles.list}>
          {requests.map((r) => {
            const currentSalary = r.employee_snapshot?.current_salary ?? r.employee_snapshot?.salary_actual;
            const raisePercent = r.raise_percentage != null
              ? r.raise_percentage.toFixed(1)
              : null;

            return (
              <article
                key={r.id}
                className={styles.card}
                onClick={() => navigate(`/employee/salary-raise/${r.id}`)}
              >
                <div className={styles.cardTop}>
                  <span
                    className={styles.statusBadge}
                    style={{
                      backgroundColor: STATUS_COLORS[r.status] + '1a',
                      color: STATUS_COLORS[r.status],
                    }}
                  >
                    {STATUS_LABELS[r.status]}
                  </span>
                  <span className={styles.requestType}>
                    {REQUEST_TYPE_LABELS[r.request_type]}
                  </span>
                </div>

                <div className={styles.salaryRow}>
                  <span className={styles.salaryLabel}>Оклад:</span>
                  <span className={styles.salaryValue}>
                    {formatSalary(currentSalary)}
                  </span>
                  <span className={styles.arrow}>→</span>
                  <span className={styles.salaryValue}>
                    {formatSalary(r.requested_salary)}
                  </span>
                  {raisePercent && (
                    <span className={styles.raisePercent}>+{raisePercent}%</span>
                  )}
                </div>

                <div className={styles.cardMeta}>
                  <span>Желаемая дата: {formatDate(r.desired_effective_date)}</span>
                  <span>Создана: {formatDate(r.created_at)}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
