import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { objectKpiApi } from '../../api/objectKpi';
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
 * Экран строится вокруг одного месяца: виджеты показывают план, факт КС-2 и процент за
 * выбранный месяц (по всем объектам или по одному), а таблица появляется только после
 * выбора объекта — иначе это простыня «все объекты × все месяцы», по которой ничего не видно.
 *
 * Все суммы — с НДС, в рублях (п. 2.1).
 */

/** Потолок окна отчёта на бэкенде — 24 месяца; шире zod вернёт 400. */
const MAX_MONTHS = 24;

const shiftMonth = (month: string, delta: number): string => {
  const [year, value] = month.split('-').map(Number);
  const total = year * 12 + (value - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

const currentMonth = (): string => new Date().toISOString().slice(0, 7);

export const ObjectKpiPage: FC = () => {
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/discipline/objects');

  const [month, setMonth] = useState(currentMonth);
  const [objectFilter, setObjectFilter] = useState('');
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [openObjectId, setOpenObjectId] = useState<string | null>(null);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);

  // Развёрнутая история относится к конкретной паре «объект + месяц»: при смене любого
  // из них она схлопывается, иначе на экране остались бы месяцы чужого запроса.
  // Сброс в обработчиках, а не в эффекте: эффект давал бы лишний каскадный рендер.
  const changeMonth = (value: string) => {
    setMonth(value);
    setShowAllMonths(false);
  };

  const changeObject = (value: string) => {
    setObjectFilter(value);
    setShowAllMonths(false);
  };

  const objectsQuery = useQuery({
    queryKey: objectKpiKeys.objects(),
    queryFn: () => objectKpiApi.listObjects(),
  });

  const objects = useMemo(() => objectsQuery.data?.data ?? [], [objectsQuery.data]);
  const canRevisePlan = objectsQuery.data?.scope.can_revise_plan === true;
  const selectedObject = objects.find(item => item.id === objectFilter) ?? null;

  const monthPeriod = useMemo(() => ({ from: month, to: month }), [month]);

  // Виджеты всегда за выбранный месяц — и когда таблица развёрнута на всю историю тоже.
  const reportQuery = useQuery({
    queryKey: objectKpiKeys.report(month, month, objectFilter || 'all'),
    queryFn: () => objectKpiApi.getReport(monthPeriod, objectFilter || null),
  });

  // Начало истории — первый расчётный месяц договора, но не глубже потолка окна.
  const historyFrom = useMemo(() => {
    const floor = shiftMonth(month, -(MAX_MONTHS - 1));
    const start = selectedObject?.plan_start_month?.slice(0, 7)
      ?? selectedObject?.contract_date?.slice(0, 7);
    if (!start) return floor;
    return start > floor ? start : floor;
  }, [month, selectedObject]);

  const historyPeriod = useMemo(() => ({ from: historyFrom, to: month }), [historyFrom, month]);

  const historyQuery = useQuery({
    queryKey: objectKpiKeys.report(historyFrom, month, objectFilter || 'all'),
    queryFn: () => objectKpiApi.getReport(historyPeriod, objectFilter || null),
    enabled: showAllMonths && Boolean(objectFilter),
  });

  const summary = reportQuery.data?.summary;

  const activeQuery = showAllMonths && objectFilter ? historyQuery : reportQuery;
  // Строки без договора не показываем: единственное действие по ним — «Создать договор»,
  // а эта кнопка теперь живёт над таблицей.
  const rows = useMemo(
    () => (activeQuery.data?.data ?? [])
      .filter(row => row.contract_id !== null)
      .slice()
      .sort((a, b) => b.period_month.localeCompare(a.period_month)),
    [activeQuery.data],
  );

  // Шапка ЗОС берётся из строки ВЫБРАННОГО месяца, а не из первой строки таблицы:
  // в развёрнутом виде первой может оказаться любая.
  const monthRow = reportQuery.data?.data.find(row => row.skud_object_id === objectFilter) ?? null;

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
          <span>Месяц</span>
          <input type="month" value={month} onChange={e => changeMonth(e.target.value)} />
        </label>

        <label className={styles.field}>
          <span>Объект</span>
          <span className={styles.selectRow}>
            <select value={objectFilter} onChange={e => changeObject(e.target.value)}>
              <option value="">Все объекты</option>
              {objects.map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
            {objectFilter && (
              <button
                type="button"
                className={styles.clearBtn}
                aria-label="Сбросить объект"
                title="Все объекты"
                onClick={() => changeObject('')}
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

      {reportQuery.isError && <div className={styles.error}>Не удалось загрузить отчёт</div>}

      {selectedObject && (
        <>
          <div className={styles.contractBar}>
            <span className={styles.contractItem}>
              <span className={styles.summaryLabel}>ЗОС план / факт</span>
              <strong>
                {formatDate(monthRow?.planned_zos_date_used ?? selectedObject.planned_zos_date)}
                {' / '}
                {formatDate(monthRow?.actual_zos_date ?? selectedObject.actual_zos_date)}
              </strong>
            </span>
            <span className={styles.contractItem}>
              <span className={styles.summaryLabel}>Контрольная дата</span>
              <strong className={monthRow?.is_overdue ? styles.overdue : undefined}>
                {formatDate(monthRow?.control_date ?? null)}
              </strong>
            </span>
            {canEdit && (
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => setOpenObjectId(selectedObject.id)}
              >
                {selectedObject.contract_id ? 'Договор' : 'Создать договор'}
              </button>
            )}
          </div>

          <p className={styles.note}>Все суммы — в рублях, с НДС.</p>

          {!selectedObject.contract_id ? (
            <div className={styles.emptyBlock}>По объекту нет договора</div>
          ) : (
            <>
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
                    {activeQuery.isLoading && (
                      <tr><td colSpan={11} className={styles.empty}>Загрузка…</td></tr>
                    )}
                    {!activeQuery.isLoading && rows.length === 0 && (
                      <tr>
                        <td colSpan={11} className={styles.empty}>
                          Месяц вне расчётного периода договора
                        </td>
                      </tr>
                    )}
                    {rows.map(row => (
                      <tr
                        key={`${row.skud_object_id}-${row.period_month}`}
                        className={styles.row}
                        onClick={() => setOpenObjectId(row.skud_object_id)}
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

              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => setShowAllMonths(value => !value)}
              >
                {showAllMonths ? 'Только выбранный месяц' : 'Показать все месяцы'}
              </button>
            </>
          )}
        </>
      )}

      {openObjectId && (
        <ObjectKpiCardModal
          objectId={openObjectId}
          period={showAllMonths ? historyPeriod : monthPeriod}
          canEdit={canEdit}
          canRevisePlan={canRevisePlan}
          onClose={() => setOpenObjectId(null)}
        />
      )}

      {assignmentsOpen && (
        <ObjectKpiAssignmentModal onClose={() => setAssignmentsOpen(false)} />
      )}
    </div>
  );
};
