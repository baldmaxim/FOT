import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hiringRequestService, type IHiringAnalyticsRow } from '../../../services/hiringRequestService';
import { Avatar } from './hiringUi';
import styles from './hiring.module.css';

export const HiringAnalytics: FC = () => {
  const [period, setPeriod] = useState<'week' | 'month'>('month');
  const { data, isLoading } = useQuery({
    queryKey: ['hiring-analytics', period],
    queryFn: () => hiringRequestService.analytics(period),
  });
  const rows = data ?? [];

  const totals = useMemo(() => rows.reduce((a, r) => ({
    total: a.total + r.total,
    closed: a.closed + r.closed,
    interviews: a.interviews + r.interviews,
    overdue: a.overdue + r.overdue,
  }), { total: 0, closed: 0, interviews: 0, overdue: 0 }), [rows]);

  const leaderId = rows.length ? rows.reduce((m, r) => (r.closed > m.closed ? r : m), rows[0]).employee_id : null;

  const inTimePct = (r: IHiringAnalyticsRow) => r.closed_with_deadline > 0 ? Math.round((r.closed_in_time / r.closed_with_deadline) * 100) : null;
  const tgClass = (pct: number | null) => pct == null ? '' : pct >= 85 ? styles.g : pct >= 70 ? styles.y : styles.r;

  return (
    <div className={styles.wrap}>
      <div className={styles.anHead}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Аналитика подбора — по ответственным рекрутерам</div>
        <div className={styles.seg}>
          <button className={period === 'week' ? styles.on : ''} onClick={() => setPeriod('week')}>Неделя</button>
          <button className={period === 'month' ? styles.on : ''} onClick={() => setPeriod('month')}>Месяц</button>
        </div>
      </div>

      <div className={styles.strip}>
        <span className={styles.it}><b>{totals.total}</b> заявок</span><span className={styles.sep}>·</span>
        <span className={styles.it}><b>{totals.closed}</b> завершено</span><span className={styles.sep}>·</span>
        <span className={styles.it}><b>{totals.interviews}</b> собеседований</span>
        {totals.overdue > 0 && <><span className={styles.sep}>·</span><span className={styles.it} style={{ color: 'var(--error)' }}><b>{totals.overdue}</b> просрочено</span></>}
      </div>

      <div className={styles.anTable}>
        <table>
          <thead>
            <tr>
              <th>Рекрутер</th>
              <th className={styles.num}>В работе</th>
              <th className={styles.num}>Закрыто</th>
              <th className={styles.num}>% в срок</th>
              <th className={styles.num}>Ср. время</th>
              <th className={styles.num}>Собес.</th>
              <th className={styles.num}>Чел/заявку</th>
              <th className={styles.num}>Просроч.</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>Загрузка…</td></tr>}
            {!isLoading && rows.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>Нет данных за период.</td></tr>}
            {rows.map(r => {
              const pct = inTimePct(r);
              return (
                <tr key={r.employee_id} className={r.employee_id === leaderId ? styles.leader : ''}>
                  <td><div className={styles.rec}>{r.employee_id === leaderId ? '🏆 ' : ''}<Avatar name={r.full_name} id={r.employee_id} /> {r.full_name}</div></td>
                  <td className={styles.num}>{r.total}</td>
                  <td className={styles.num}>{r.closed}</td>
                  <td className={styles.num}>{pct == null ? '—' : <span className={`${styles.tg} ${tgClass(pct)}`}>{pct}%</span>}</td>
                  <td className={styles.num}>{r.avg_close_days == null ? '—' : `${r.avg_close_days} дн`}</td>
                  <td className={styles.num}>{r.interviews}</td>
                  <td className={styles.num}>{r.avg_headcount ?? '—'}</td>
                  <td className={styles.num}>{r.overdue > 0 ? <span className={`${styles.tg} ${styles.r}`}>{r.overdue}</span> : '0'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.legend}>«Завершено» = заявка переведена в «Закрыта» за период. Метрики атрибутируются главному ответственному (primary).</div>
    </div>
  );
};
