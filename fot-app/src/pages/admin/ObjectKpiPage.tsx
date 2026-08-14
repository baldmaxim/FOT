import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { objectKpiApi, type IPeriod } from '../../api/objectKpi';
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
 * Виджеты показывают весь расчёт до текущего месяца — окно считает сервер, фронт датами
 * не жонглирует. Таблица появляется после выбора объекта и сразу показывает все его месяцы,
 * свежий сверху.
 *
 * Все суммы — с НДС, в рублях (п. 2.1).
 */

const formatPeriod = (period?: IPeriod): string | null => {
  if (!period) return null;
  const from = formatMonthLabel(`${period.from}-01`);
  const to = formatMonthLabel(`${period.to}-01`);
  return from === to ? from : `${from} — ${to}`;
};

export const ObjectKpiPage: FC = () => {
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/discipline/objects');

  const [objectFilter, setObjectFilter] = useState('');
  const [openCard, setOpenCard] = useState<{ objectId: string; mode: 'view' | 'create' } | null>(null);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);

  const objectsQuery = useQuery({
    queryKey: objectKpiKeys.objects(),
    queryFn: () => objectKpiApi.listObjects(),
  });

  const objects = useMemo(() => objectsQuery.data?.data ?? [], [objectsQuery.data]);
  const canRevisePlan = objectsQuery.data?.scope.can_revise_plan === true;
  const selectedObject = objects.find(item => item.id === objectFilter) ?? null;

  // Таблица — только по выбранному объекту: без него сервер отказывает, чтобы не строить
  // решётку «все объекты × 10 лет».
  const tableQuery = useQuery({
    queryKey: objectKpiKeys.reportAuto(objectFilter),
    queryFn: () => objectKpiApi.getReport(null, objectFilter),
    enabled: Boolean(objectFilter),
  });

  // Сводка по всем объектам — отдельным лёгким запросом. При выбранном объекте она уже
  // пришла вместе с таблицей, второй запрос был бы тем же самым по нагрузке на БД.
  const summaryQuery = useQuery({
    queryKey: objectKpiKeys.reportSummary('all'),
    queryFn: () => objectKpiApi.getReportSummary(),
    enabled: !objectFilter,
  });

  const summary = objectFilter ? tableQuery.data?.summary : summaryQuery.data?.summary;
  const period = objectFilter ? tableQuery.data?.period : summaryQuery.data?.period;
  const periodLabel = formatPeriod(period);

  // Строки без договора не показываем: единственное действие по ним — «Создать договор»,
  // а эта кнопка живёт над таблицей.
  const rows = useMemo(
    () => (tableQuery.data?.data ?? [])
      .filter(row => row.contract_id !== null)
      .slice()
      .sort((a, b) => b.period_month.localeCompare(a.period_month)),
    [tableQuery.data],
  );

  // Шапка ЗОС — из самого свежего месяца отчёта. Контрольную дату фронт не вычисляет:
  // формула «плановая ЗОС + 3 месяца» принадлежит приказу и живёт в SQL.
  const latestRow = rows[0] ?? null;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.summaryTile}>
          <span className={styles.summaryLabel}>План за период</span>
          <strong>{formatMoneyShort(summary?.total_plan ?? null)}</strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.summaryLabel}>Факт КС-2</span>
          <strong>{formatMoneyShort(summary?.total_fact ?? null)}</strong>
        </div>
        <div className={styles.summaryTile}>
          <span className={styles.summaryLabel}>Выполнение</span>
          {/* Σфакт / Σплан, а не среднее процентов по месяцам (п. 3.5). */}
          <strong>{formatPercent(summary?.completion_pct ?? null)}</strong>
        </div>

        <label className={styles.field}>
          <span>Объект</span>
          {/* Крестик внутри поля: обёртка держит стрелку и кнопку очистки. */}
          <span className={styles.selectWrap}>
            <select
              className={styles.select}
              value={objectFilter}
              onChange={e => setObjectFilter(e.target.value)}
            >
              <option value="">Все объекты</option>
              {objects.map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
            {objectFilter && (
              <button
                type="button"
                className={styles.clearInside}
                aria-label="Сбросить объект"
                title="Все объекты"
                onClick={() => setObjectFilter('')}
              >
                <X size={16} />
              </button>
            )}
          </span>
        </label>

        {canEdit && (
          <button type="button" className={styles.secondaryBtn} onClick={() => setAssignmentsOpen(true)}>
            Назначения
          </button>
        )}
      </div>

      {/* Период подписан явно: он вычисляется сервером и ограничен 10 годами. */}
      {periodLabel && <p className={styles.note}>Период: {periodLabel}. Все суммы — в рублях, с НДС.</p>}

      {tableQuery.isError && <div className={styles.error}>Не удалось загрузить отчёт</div>}
      {summaryQuery.isError && <div className={styles.error}>Не удалось загрузить сводку</div>}

      {selectedObject && (
        <>
          <div className={styles.contractBar}>
            <span className={styles.contractItem}>
              <span className={styles.summaryLabel}>ЗОС план / факт</span>
              <strong>
                {formatDate(latestRow?.planned_zos_date_used ?? selectedObject.planned_zos_date)}
                {' / '}
                {formatDate(latestRow?.actual_zos_date ?? selectedObject.actual_zos_date)}
              </strong>
            </span>
            <span className={styles.contractItem}>
              <span className={styles.summaryLabel}>Контрольная дата</span>
              <strong className={latestRow?.is_overdue ? styles.overdue : undefined}>
                {formatDate(latestRow?.control_date ?? null)}
              </strong>
            </span>
            {canEdit && (
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => setOpenCard({ objectId: selectedObject.id, mode: 'create' })}
              >
                Создать договор
              </button>
            )}
          </div>

          {!selectedObject.contract_id ? (
            <div className={styles.emptyBlock}>По объекту нет договора</div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Премия</th>
                    <th>Месяц</th>
                    <th>Руководитель</th>
                    <th>Договор с ДС</th>
                    <th>КС-2</th>
                    <th>КС-6</th>
                    <th>Остаток</th>
                    <th>Мес.</th>
                    <th>План месяца</th>
                    <th>Факт месяца</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  {tableQuery.isLoading && (
                    <tr><td colSpan={11} className={styles.empty}>Загрузка…</td></tr>
                  )}
                  {!tableQuery.isLoading && rows.length === 0 && (
                    <tr>
                      <td colSpan={11} className={styles.empty}>
                        Расчётных месяцев по договору нет
                      </td>
                    </tr>
                  )}
                  {rows.map(row => (
                    <tr
                      key={`${row.skud_object_id}-${row.period_month}`}
                      className={styles.row}
                      onClick={() => setOpenCard({ objectId: row.skud_object_id, mode: 'view' })}
                    >
                      {/* Премия — Этап 2 приказа, расчёта пока нет. */}
                      <td>—</td>
                      <td>{formatMonthLabel(row.period_month)}</td>
                      <td>{row.primary_manager_name ?? '—'}</td>
                      <td>{formatMoneyShort(row.contract_total)}</td>
                      <td>{formatMoneyShort(row.ks2_cumulative_after)}</td>
                      <td>{formatMoneyShort(row.ks6_cumulative_after)}</td>
                      <td>{formatMoneyShort(row.remainder)}</td>
                      <td>{row.months_remaining ?? '—'}</td>
                      <td>
                        {formatMoneyShort(row.plan_amount)}
                        {row.plan_overridden && (
                          <span className={styles.mark} title="План задан вручную">✎</span>
                        )}
                        {row.plan_drift && (
                          <span
                            className={styles.mark}
                            title="Исходные данные изменились после фиксации"
                          >!</span>
                        )}
                      </td>
                      <td>{formatMoneyShort(row.fact_amount)}</td>
                      <td>{formatPercent(row.completion_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {openCard && (
        <ObjectKpiCardModal
          objectId={openCard.objectId}
          mode={openCard.mode}
          objectName={objects.find(item => item.id === openCard.objectId)?.name ?? 'Объект'}
          canEdit={canEdit}
          canRevisePlan={canRevisePlan}
          onClose={() => setOpenCard(null)}
        />
      )}

      {assignmentsOpen && (
        <ObjectKpiAssignmentModal onClose={() => setAssignmentsOpen(false)} />
      )}
    </div>
  );
};
