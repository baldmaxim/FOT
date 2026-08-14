import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { objectKpiApi, type IObjectKpiReportRow } from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { formatDate, formatMoney, formatMonthLabel, formatPercent } from '../../utils/formatMoney';
import styles from './EmployeeObjectsPage.module.css';

/**
 * ЛК руководителя строительства: расчёт KPI по своим объектам.
 *
 * Только чтение и только свои закрепления — чужие проценты и ввод данных живут
 * на вкладке «KPI объектов» в админке. Период учитывается: месяцы, за которые
 * человек отвечал, остаются видны и после закрытия закрепления.
 */

const shiftMonth = (month: string, delta: number): string => {
  const [year, value] = month.split('-').map(Number);
  const total = year * 12 + (value - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

const currentMonth = (): string => new Date().toISOString().slice(0, 7);

export const EmployeeObjectsPage: FC = () => {
  const [from, setFrom] = useState(() => shiftMonth(currentMonth(), -5));
  const [to, setTo] = useState(currentMonth);

  const period = useMemo(() => ({ from, to }), [from, to]);
  const query = useQuery({
    queryKey: objectKpiKeys.myObjects(from, to),
    queryFn: () => objectKpiApi.getMyObjects(period),
    enabled: from <= to,
  });

  const rows = useMemo(() => query.data?.data ?? [], [query.data]);
  const summary = query.data?.summary;

  // Группируем по объекту: карточка на объект, внутри — месяцы.
  const byObject = useMemo(() => {
    const map = new Map<string, { name: string; rows: IObjectKpiReportRow[] }>();
    for (const row of rows) {
      const entry = map.get(row.skud_object_id) ?? { name: row.object_name, rows: [] };
      entry.rows.push(row);
      map.set(row.skud_object_id, entry);
    }
    return [...map.entries()];
  }, [rows]);

  return (
    <div className={styles.page}>
      <div className={styles.filters}>
        <label className={styles.field}>
          <span>Период с</span>
          <input type="month" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>по</span>
          <input type="month" value={to} onChange={e => setTo(e.target.value)} />
        </label>
      </div>

      {summary && (
        <div className={styles.summary}>
          <div>
            <span>План за период</span>
            <strong>{formatMoney(summary.total_plan)}</strong>
          </div>
          <div>
            <span>Факт КС-2</span>
            <strong>{formatMoney(summary.total_fact)}</strong>
          </div>
          <div>
            <span>Выполнение</span>
            <strong>{formatPercent(summary.completion_pct)}</strong>
          </div>
        </div>
      )}

      <p className={styles.note}>Суммы указаны в рублях, с НДС.</p>

      {query.isLoading && <p className={styles.empty}>Загрузка…</p>}
      {query.isError && <p className={styles.empty}>Не удалось загрузить данные</p>}
      {!query.isLoading && byObject.length === 0 && (
        <p className={styles.empty}>За выбранный период за вами не закреплено объектов</p>
      )}

      {byObject.map(([objectId, group]) => (
        <section key={objectId} className={styles.card}>
          <header className={styles.cardHeader}>
            <h2>{group.name}</h2>
            <span className={styles.cardMeta}>
              Плановая ЗОС: {formatDate(group.rows[0]?.planned_zos_date)} ·
              контрольная дата: {formatDate(group.rows[0]?.control_date)}
            </span>
          </header>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Месяц</th><th>Остаток</th><th>Мес.</th><th>План</th><th>Факт</th><th>%</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map(row => (
                  <tr key={row.period_month}>
                    <td>{formatMonthLabel(row.period_month)}</td>
                    <td>{formatMoney(row.remainder)}</td>
                    <td>{row.months_remaining ?? '—'}</td>
                    <td>{formatMoney(row.plan_amount)}</td>
                    <td>{formatMoney(row.fact_amount)}</td>
                    {/* Прочерк вместо «0 %»: полностью закрытый объект не провалил KPI. */}
                    <td>{formatPercent(row.completion_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
};
