import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { objectKpiApi, type IObjectKpiReportRow } from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { useAuth } from '../../contexts/AuthContext';
import {
  formatDate,
  formatMoneyShort,
  formatMonthLabel,
  formatPercent,
} from '../../utils/formatMoney';
import { ObjectKpiCardModal } from '../../components/admin/ObjectKpiCardModal';
import { ObjectKpiAssignmentModal } from '../../components/admin/ObjectKpiAssignmentModal';
import styles from './ObjectKpiPage.module.css';

/**
 * Вкладка «KPI объектов» на странице «Аналитика».
 *
 * Показывает расчёт приказа: остаток договора → план месяца → факт подписанных КС-2 →
 * процент выполнения. Все суммы — с НДС, в рублях (п. 2.1).
 *
 * Численность грузится ВТОРЫМ запросом: основной отчёт — чистый SQL и отвечает быстро,
 * а человеко-дни тянут события СКУД по всем сотрудникам объектов.
 */

const shiftMonth = (month: string, delta: number): string => {
  const [year, value] = month.split('-').map(Number);
  const total = year * 12 + (value - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

const currentMonth = (): string => new Date().toISOString().slice(0, 7);

export const ObjectKpiPage: FC = () => {
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/discipline/objects');

  const [from, setFrom] = useState(() => shiftMonth(currentMonth(), -5));
  const [to, setTo] = useState(currentMonth);
  const [openObjectId, setOpenObjectId] = useState<string | null>(null);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);

  const period = useMemo(() => ({ from, to }), [from, to]);
  const invalidPeriod = from > to;

  const reportQuery = useQuery({
    queryKey: objectKpiKeys.report(from, to),
    queryFn: () => objectKpiApi.getReport(period),
    enabled: !invalidPeriod,
  });

  const headcountQuery = useQuery({
    queryKey: objectKpiKeys.headcount(from, to),
    queryFn: () => objectKpiApi.getHeadcount(period),
    enabled: !invalidPeriod && reportQuery.isSuccess,
  });

  const fixationQuery = useQuery({
    queryKey: objectKpiKeys.fixationInfo(to),
    queryFn: () => objectKpiApi.getFixationInfo(to),
  });

  // Мемо, а не `?? []` по месту: новый литерал массива каждый рендер менял бы
  // зависимости useMemo ниже.
  const rows = useMemo(() => reportQuery.data?.data ?? [], [reportQuery.data]);
  const summary = reportQuery.data?.summary;

  const headcountByKey = useMemo(() => {
    const map = new Map<string, { avg: number | null; weekend: number }>();
    for (const row of headcountQuery.data ?? []) {
      map.set(`${row.skud_object_id}|${row.period_month}`, {
        avg: row.avg_headcount,
        weekend: row.weekend_person_days,
      });
    }
    return map;
  }, [headcountQuery.data]);

  // «Требуют внимания»: незакрытые просроченные месяцы, неполные данные и дрейф
  // исходных данных после фиксации.
  const attention = useMemo(() => ({
    incomplete: rows.filter(row => row.report_status === 'data_incomplete'),
    overdue: rows.filter(row => row.is_overdue && row.report_status === 'open'),
    drift: rows.filter(row => row.plan_drift),
    overContract: rows.filter(row => row.over_contract),
  }), [rows]);

  const renderStatus = (row: IObjectKpiReportRow) => {
    if (row.report_status === 'data_incomplete') {
      const reason = row.data_quality === 'no_active_contract' ? 'нет договора'
        : row.data_quality === 'no_base_amount' ? 'нет стоимости'
        : 'нет плановой ЗОС';
      return <span className={`${styles.badge} ${styles.badgeWarn}`}>{reason}</span>;
    }
    if (row.report_status === 'corrected') {
      return <span className={`${styles.badge} ${styles.badgeInfo}`}>пересмотрен</span>;
    }
    if (row.report_status === 'fixed') {
      return <span className={`${styles.badge} ${styles.badgeOk}`}>зафиксирован</span>;
    }
    return <span className={styles.badge}>открыт</span>;
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.period}>
          <label className={styles.field}>
            <span>Период с</span>
            <input type="month" value={from} onChange={e => setFrom(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>по</span>
            <input type="month" value={to} onChange={e => setTo(e.target.value)} />
          </label>
        </div>

        <div className={styles.toolbarRight}>
          {fixationQuery.data?.fixation_date && (
            <span className={styles.hint}>
              План {formatMonthLabel(`${to}-01`)} фиксируется {formatDate(fixationQuery.data.fixation_date)}
              {!fixationQuery.data.freezer_enabled && ' (автофиксация выключена)'}
            </span>
          )}
          {canEdit && (
            <button type="button" className={styles.secondaryBtn} onClick={() => setAssignmentsOpen(true)}>
              Назначения
            </button>
          )}
        </div>
      </div>

      {invalidPeriod && <div className={styles.error}>Начало периода позже конца</div>}
      {reportQuery.isError && <div className={styles.error}>Не удалось загрузить отчёт</div>}

      {summary && (
        <div className={styles.summary}>
          <div className={styles.summaryTile}>
            <span className={styles.summaryLabel}>План за период</span>
            <strong>{formatMoneyShort(summary.total_plan)}</strong>
          </div>
          <div className={styles.summaryTile}>
            <span className={styles.summaryLabel}>Факт КС-2</span>
            <strong>{formatMoneyShort(summary.total_fact)}</strong>
          </div>
          <div className={styles.summaryTile}>
            <span className={styles.summaryLabel}>Выполнение</span>
            {/* Σфакт / Σплан, а не среднее процентов по месяцам (п. 3.5). */}
            <strong>{formatPercent(summary.completion_pct)}</strong>
          </div>
        </div>
      )}

      {(attention.incomplete.length > 0 || attention.overdue.length > 0
        || attention.drift.length > 0 || attention.overContract.length > 0) && (
        <div className={styles.attention}>
          <strong>Требуют внимания</strong>
          <ul>
            {attention.incomplete.length > 0 && (
              <li>Неполные данные: {attention.incomplete.length} строк — план не считается</li>
            )}
            {attention.overdue.length > 0 && (
              <li>Контрольная дата прошла, месяц не закрыт: {attention.overdue.length}</li>
            )}
            {attention.drift.length > 0 && (
              <li>После фиксации изменились исходные данные: {attention.drift.length}</li>
            )}
            {attention.overContract.length > 0 && (
              <li>КС-2 превышают стоимость договора: {attention.overContract.length}</li>
            )}
          </ul>
        </div>
      )}

      <p className={styles.note}>Все суммы — в рублях, с НДС.</p>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Объект</th>
              <th>Месяц</th>
              <th>Руководитель</th>
              <th>ЗОС план / факт</th>
              <th>Контрольная дата</th>
              <th>Договор с ДС</th>
              <th>КС-2 накопительно</th>
              <th>Остаток</th>
              <th>Мес.</th>
              <th>План месяца</th>
              <th>Факт месяца</th>
              <th>%</th>
              <th>Числ.</th>
              <th>Вых.</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {reportQuery.isLoading && (
              <tr><td colSpan={15} className={styles.empty}>Загрузка…</td></tr>
            )}
            {!reportQuery.isLoading && rows.length === 0 && (
              <tr><td colSpan={15} className={styles.empty}>Нет данных за период</td></tr>
            )}
            {rows.map(row => {
              const headcount = headcountByKey.get(`${row.skud_object_id}|${row.period_month}`);
              return (
                <tr
                  key={`${row.skud_object_id}-${row.period_month}`}
                  className={styles.row}
                  onClick={() => setOpenObjectId(row.skud_object_id)}
                >
                  <td className={styles.objectCell}>
                    {row.object_name}
                    {!row.object_is_active && <span className={styles.archived}>архив</span>}
                  </td>
                  <td>{formatMonthLabel(row.period_month)}</td>
                  <td>{row.primary_manager_name ?? '—'}</td>
                  <td>{formatDate(row.planned_zos_date_used)} / {formatDate(row.actual_zos_date)}</td>
                  <td className={row.is_overdue ? styles.overdue : undefined}>
                    {formatDate(row.control_date)}
                  </td>
                  <td>{formatMoneyShort(row.contract_total)}</td>
                  <td>{formatMoneyShort(row.ks2_cumulative_after)}</td>
                  <td>{formatMoneyShort(row.remainder)}</td>
                  <td>{row.months_remaining ?? '—'}</td>
                  <td>
                    {formatMoneyShort(row.plan_amount)}
                    {row.plan_overridden && <span className={styles.mark} title="План задан вручную">✎</span>}
                    {row.plan_drift && <span className={styles.mark} title="Исходные данные изменились после фиксации">!</span>}
                  </td>
                  <td>{formatMoneyShort(row.fact_amount)}</td>
                  <td>{formatPercent(row.completion_pct)}</td>
                  <td>{headcountQuery.isLoading ? '…' : (headcount?.avg ?? '—')}</td>
                  <td>{headcountQuery.isLoading ? '…' : (headcount?.weekend ?? '—')}</td>
                  <td>{renderStatus(row)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openObjectId && (
        <ObjectKpiCardModal
          objectId={openObjectId}
          period={period}
          canEdit={canEdit}
          onClose={() => setOpenObjectId(null)}
        />
      )}

      {assignmentsOpen && (
        <ObjectKpiAssignmentModal onClose={() => setAssignmentsOpen(false)} />
      )}
    </div>
  );
};
