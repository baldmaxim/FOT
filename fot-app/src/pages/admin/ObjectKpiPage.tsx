import { useMemo, useState, type FC, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';

import {
  objectKpiApi,
  type IObjectKpiObjectStat,
  type IObjectKpiReportRow,
  type IPeriod,
  type IReportPremiumRow,
} from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { triggerBlobDownload } from '../../utils/download';
import {
  formatDate,
  formatMoneyShort,
  formatMonthLabel,
  formatPercent,
} from '../../utils/formatMoney';
import {
  applyTableView,
  buildExportTable,
  buildMonthColumns,
  defaultMonths,
  formatMonthsLabel,
  listWindowMonths,
  OBJECT_STAT_COLUMNS,
  premiumCell,
  type IKpiColumn,
  type IKpiTableView,
  type IPremiumView,
} from '../../utils/objectKpiTable';
import { ObjectKpiCardModal } from '../../components/admin/ObjectKpiCardModal';
import { ObjectKpiAssignmentModal } from '../../components/admin/ObjectKpiAssignmentModal';
import { ObjectKpiMonthsPicker } from '../../components/admin/ObjectKpiMonthsPicker';
import { ObjectKpiTable } from '../../components/admin/ObjectKpiTable';
import styles from './ObjectKpiPage.module.css';

/**
 * Вкладка «KPI объектов» на странице «Аналитика».
 *
 * Плитки и таблицы показывают выбранные месяцы — по умолчанию прошлый. «Весь период» — весь
 * расчёт до текущего месяца: окно считает сервер, фронт датами не жонглирует. Без объекта —
 * таблица «Все объекты» (строка на объект), с объектом — его месяцы; при «весь период» — все,
 * от первого расчётного до месяца контрольной даты, после текущего — прогноз сервера при
 * выполнении плана на 100 %.
 *
 * Сортировка и фильтры столбцов — на клиенте, «Экспорт» выгружает ровно видимые строки.
 * Все суммы — с НДС, в рублях (п. 2.1).
 */

const formatPeriod = (period?: IPeriod): string | null => {
  if (!period) return null;
  const from = formatMonthLabel(`${period.from}-01`);
  const to = formatMonthLabel(`${period.to}-01`);
  return from === to ? from : `${from} — ${to}`;
};

const OBJECTS_DEFAULT_VIEW: IKpiTableView = { sort: 'object', dir: 'asc', filters: {} };
const MONTHS_DEFAULT_VIEW: IKpiTableView = { sort: 'month', dir: 'asc', filters: {} };

export const ObjectKpiPage: FC = () => {
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/discipline/objects');
  const toast = useToast();

  const [objectFilter, setObjectFilter] = useState('');
  /** Выбранные месяцы (YYYY-MM): null — не трогали (прошлый месяц), [] — весь период. */
  const [selectedMonths, setSelectedMonths] = useState<string[] | null>(null);
  // Сортировка и фильтры обеих таблиц живут здесь: переход «объект ↔ все» их не сбрасывает.
  const [objectsView, setObjectsView] = useState<IKpiTableView>(OBJECTS_DEFAULT_VIEW);
  const [monthsView, setMonthsView] = useState<IKpiTableView>(MONTHS_DEFAULT_VIEW);
  const [openCard, setOpenCard] = useState<{ objectId: string; mode: 'view' | 'create' } | null>(null);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const objectsQuery = useQuery({
    queryKey: objectKpiKeys.objects(),
    queryFn: () => objectKpiApi.listObjects(),
  });

  const objects = useMemo(() => objectsQuery.data?.data ?? [], [objectsQuery.data]);
  const canRevisePlan = objectsQuery.data?.scope.can_revise_plan === true;
  // Закрепления ведут админ и руководитель эк. отдела; бэкенд проверяет право сам.
  const canManageAssignments = objectsQuery.data?.scope.can_manage_assignments === true;
  // Ограниченный скоуп (экономист объекта): единственный объект выбран сразу и без выбора
  // «Все объекты» — ему просто нечего сравнивать; при нескольких объектах «Все» остаётся.
  const restrictedScope = objectsQuery.data !== undefined && objectsQuery.data.scope.is_unrestricted === false;
  const lockedObjectId = restrictedScope && objects.length === 1 ? objects[0].id : null;
  const effectiveObjectFilter = lockedObjectId ?? objectFilter;
  const selectedObject = objects.find(item => item.id === effectiveObjectFilter) ?? null;

  // Таблица объекта — весь его расчёт (авто-окно) с прогнозом; выбор месяцев режет строки здесь.
  const tableQuery = useQuery({
    queryKey: objectKpiKeys.reportAuto(effectiveObjectFilter),
    queryFn: () => objectKpiApi.getReport(null, effectiveObjectFilter),
    enabled: Boolean(effectiveObjectFilter),
  });

  // Премия — третьим, ленивым запросом: путь тяжёлый (полный отчёт на каждого
  // руководителя), и таблица не должна его ждать. Окно берём из ответа таблицы,
  // чтобы премия и строки считались за один и тот же период.
  const tablePeriod = tableQuery.data?.period;
  const premiumQuery = useQuery({
    queryKey: objectKpiKeys.reportPremium(
      tablePeriod?.from ?? 'auto',
      tablePeriod?.to ?? 'auto',
      effectiveObjectFilter || 'all',
    ),
    queryFn: () => objectKpiApi.getReportPremium(tablePeriod, effectiveObjectFilter),
    enabled: Boolean(effectiveObjectFilter) && Boolean(tablePeriod),
  });

  const premiumView = useMemo<IPremiumView>(() => {
    // Ключ — «руководитель + месяц»: премия по приказу принадлежит человеку, а не объекту.
    const byKey = new Map<string, IReportPremiumRow>();
    for (const item of premiumQuery.data?.data ?? []) {
      byKey.set(`${item.employee_id}|${item.period_month}`, item);
    }
    return {
      state: premiumQuery.isLoading ? 'loading' : premiumQuery.isError ? 'error' : 'ready',
      byKey,
      hidden: new Set(premiumQuery.data?.hidden_manager_ids ?? []),
    };
  }, [premiumQuery.data, premiumQuery.isLoading, premiumQuery.isError]);

  // Весь период по всем объектам: окно для выбора месяцев, плитки и таблица «Все объекты».
  // При выбранном объекте всё это уже пришло вместе с его таблицей.
  const summaryQuery = useQuery({
    queryKey: objectKpiKeys.reportSummary('all'),
    queryFn: () => objectKpiApi.getReportSummary(),
    enabled: !effectiveObjectFilter,
  });

  // Базовое окно — «весь период». Список месяцев строится ИЗ НЕГО, а не из ответа на
  // запрос по месяцам: тот сузился бы до выбора, и переключаться стало бы некуда.
  const basePeriod = effectiveObjectFilter ? tableQuery.data?.period : summaryQuery.data?.period;
  const monthOptions = useMemo(() => (basePeriod ? listWindowMonths(basePeriod) : []), [basePeriod]);

  // Не трогали — прошлый месяц от текущего месяца сервера (им кончается окно). Месяцы вне
  // окна показывать нечем — отбрасываем (окно меняется вместе с объектом).
  const activeMonths = useMemo(() => {
    if (!basePeriod) return [];
    const wanted = selectedMonths ?? defaultMonths(monthOptions, basePeriod.to);
    return wanted.filter(month => monthOptions.includes(month));
  }, [basePeriod, monthOptions, selectedMonths]);
  const hasMonths = activeMonths.length > 0;

  const monthsSummaryQuery = useQuery({
    queryKey: objectKpiKeys.reportSummary(effectiveObjectFilter || 'all', activeMonths.join(',')),
    queryFn: () => objectKpiApi.getReportSummary(activeMonths, effectiveObjectFilter || null),
    enabled: hasMonths,
  });

  // Пока сводка по месяцам грузится, показываем «…», а не суммы прошлого выбора: иначе
  // переключение выглядит так, будто у разных месяцев одинаковые деньги.
  const summaryLoading = hasMonths
    ? monthsSummaryQuery.isLoading
    : (effectiveObjectFilter ? tableQuery.isLoading : summaryQuery.isLoading);
  const summary = hasMonths
    ? monthsSummaryQuery.data?.summary
    : (effectiveObjectFilter ? tableQuery.data?.summary : summaryQuery.data?.summary);
  const periodLabel = hasMonths ? formatMonthsLabel(activeMonths) : formatPeriod(basePeriod);

  /** Значение плитки: «…» на время загрузки, иначе форматированное число. */
  const tileValue = (value: number | string | null | undefined, formatter: (v: never) => string) =>
    (summaryLoading ? '…' : formatter(value as never));

  // ─── Таблица «Все объекты» ──────────────────────────────────────────────────
  const objectRows = useMemo<IObjectKpiObjectStat[]>(
    () => (hasMonths ? monthsSummaryQuery.data?.objects : summaryQuery.data?.objects) ?? [],
    [hasMonths, monthsSummaryQuery.data, summaryQuery.data],
  );
  const objectsLoading = hasMonths ? monthsSummaryQuery.isLoading : summaryQuery.isLoading;
  const visibleObjectRows = useMemo(
    () => applyTableView(objectRows, OBJECT_STAT_COLUMNS, objectsView),
    [objectRows, objectsView],
  );

  // ─── Таблица объекта по месяцам ─────────────────────────────────────────────
  // Строки без договора не показываем: единственное действие по ним — «Создать договор»,
  // а эта кнопка живёт над таблицей. Прогнозные месяцы идут следом за фактическими.
  const allMonthRows = useMemo(
    () => [...(tableQuery.data?.data ?? []), ...(tableQuery.data?.forecast ?? [])]
      .filter(row => row.contract_id !== null)
      .sort((a, b) => a.period_month.localeCompare(b.period_month)),
    [tableQuery.data],
  );
  // Прогнозных месяцев в выборе не бывает: выбрать можно только месяцы до текущего.
  const monthRows = useMemo(() => {
    if (!hasMonths) return allMonthRows;
    const selected = new Set(activeMonths);
    return allMonthRows.filter(row => selected.has(row.period_month.slice(0, 7)));
  }, [allMonthRows, activeMonths, hasMonths]);
  const monthColumns = useMemo(() => buildMonthColumns(premiumView), [premiumView]);
  const visibleMonthRows = useMemo(
    () => applyTableView(monthRows, monthColumns, monthsView),
    [monthRows, monthColumns, monthsView],
  );

  // Шапка ЗОС — из последнего фактического месяца, прогноз идёт после него. Контрольную дату
  // фронт не вычисляет: формула «плановая ЗОС + 3 месяца» принадлежит приказу и живёт в SQL.
  const latestRow = allMonthRows.filter(row => !row.is_forecast).at(-1) ?? null;
  // Текущий месяц — по серверу (МСК), а не по часам браузера: авто-окно кончается им.
  const currentMonth = tableQuery.data?.period.to ?? null;

  const renderMonthCell = (
    column: IKpiColumn<IObjectKpiReportRow>,
    row: IObjectKpiReportRow,
  ): ReactNode | undefined => {
    if (column.key === 'premium') {
      const cell = premiumCell(row, premiumView);
      return <span className={cell.muted ? styles.muted : undefined} title={cell.title}>{cell.text}</span>;
    }
    if (column.key === 'plan' && row.plan_overridden) {
      return (
        <>
          {column.text(row)}
          <span className={styles.mark} title="План задан вручную">✎</span>
        </>
      );
    }
    return undefined;
  };

  // ─── Экспорт: ровно видимая таблица ─────────────────────────────────────────
  const showMonthTable = Boolean(selectedObject?.contract_id);
  const exportRowsCount = selectedObject
    ? (showMonthTable ? visibleMonthRows.length : 0)
    : visibleObjectRows.length;
  const tableLoading = selectedObject
    ? tableQuery.isLoading || premiumQuery.isLoading
    : objectsLoading;

  const handleExport = async (): Promise<void> => {
    const scopeName = selectedObject?.name ?? 'Все объекты';
    const fileMonths = hasMonths ? activeMonths : (basePeriod ? [basePeriod.from, basePeriod.to] : []);
    const first = fileMonths[0] ?? '';
    const last = fileMonths.at(-1) ?? '';
    const base = {
      title: `KPI объектов — ${scopeName}`,
      subtitle: `Период: ${periodLabel ?? '—'}. Все суммы — в рублях, с НДС.`,
      fileName: `KPI объектов_${scopeName}_${first === last ? first : `${first}_${last}`}.xlsx`,
    };
    const table = selectedObject
      ? buildExportTable({
        ...base,
        columns: monthColumns,
        rows: visibleMonthRows,
        isMuted: row => Boolean(row.is_forecast),
      })
      : buildExportTable({ ...base, columns: OBJECT_STAT_COLUMNS, rows: visibleObjectRows });

    setExporting(true);
    try {
      const { blob, filename } = await objectKpiApi.exportTable(table);
      triggerBlobDownload(blob, filename);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Не удалось выгрузить таблицу');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.summaryTile}>
          <span className={styles.summaryLabel}>План за период</span>
          <strong>{tileValue(summary?.total_plan ?? null, formatMoneyShort)}</strong>
          {/* Выбор месяцев прямо в плитке: он меняет плитки и таблицу разом. */}
          <ObjectKpiMonthsPicker value={activeMonths} options={monthOptions} onChange={setSelectedMonths} />
        </div>
        <div className={`${styles.summaryTile} ${styles.summaryTileCompact}`}>
          <span className={styles.summaryLabel}>Факт КС-2</span>
          <strong>{tileValue(summary?.total_fact ?? null, formatMoneyShort)}</strong>
          {/* Факт месяцев без плана в «Выполнение» не входит, но и потеряться не должен. */}
          {Boolean(summary?.total_fact_unplanned) && (
            <span className={styles.tileHint} title="Месяцы без плана в процент выполнения не входят">
              + {formatMoneyShort(summary?.total_fact_unplanned ?? null)} по месяцам без плана
            </span>
          )}
        </div>
        <div className={`${styles.summaryTile} ${styles.summaryTileCompact}`}>
          <span className={styles.summaryLabel}>Выполнение</span>
          {/* Σфакт / Σплан, а не среднее процентов по месяцам (п. 3.5). */}
          <strong>{tileValue(summary?.completion_pct ?? null, formatPercent)}</strong>
        </div>

        <label className={styles.field}>
          <span>Объект</span>
          {/* Крестик внутри поля: обёртка держит стрелку и кнопку очистки. */}
          <span className={styles.selectWrap}>
            <select
              className={styles.select}
              value={effectiveObjectFilter}
              disabled={lockedObjectId !== null}
              onChange={e => setObjectFilter(e.target.value)}
            >
              {lockedObjectId === null && <option value="">Все объекты</option>}
              {objects.map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
            {effectiveObjectFilter && lockedObjectId === null && (
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

        {canManageAssignments && (
          <button type="button" className={styles.secondaryBtn} onClick={() => setAssignmentsOpen(true)}>
            Назначения
          </button>
        )}
        {/* Выгружается ровно видимая таблица: месяцы, сортировка и фильтры столбцов. */}
        <button
          type="button"
          className={`${styles.secondaryBtn} ${styles.exportBtn}`}
          onClick={() => { void handleExport(); }}
          disabled={exporting || tableLoading || exportRowsCount === 0}
        >
          <Download size={14} aria-hidden="true" />
          <span>{exporting ? 'Готовим…' : 'Экспорт'}</span>
        </button>
      </div>

      {/* Период подписан явно: он вычисляется сервером и ограничен 10 годами. */}
      {periodLabel && <p className={styles.note}>Период: {periodLabel}. Все суммы — в рублях, с НДС.</p>}

      {tableQuery.isError && <div className={styles.error}>Не удалось загрузить отчёт</div>}
      {(summaryQuery.isError || monthsSummaryQuery.isError) && (
        <div className={styles.error}>Не удалось загрузить сводку</div>
      )}

      {!selectedObject && (
        <ObjectKpiTable
          ariaLabel="KPI по всем объектам"
          rows={objectRows}
          visibleRows={visibleObjectRows}
          columns={OBJECT_STAT_COLUMNS}
          view={objectsView}
          onViewChange={setObjectsView}
          rowKey={row => row.skud_object_id}
          rowLabel={row => `Открыть объект: ${row.object_name}`}
          onRowClick={row => setObjectFilter(row.skud_object_id)}
          loading={objectsLoading}
          emptyText="Нет объектов с договором за выбранные месяцы"
        />
      )}

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
                onClick={() => setOpenCard({
                  objectId: selectedObject.id,
                  mode: selectedObject.contract_id ? 'view' : 'create',
                })}
              >
                {selectedObject.contract_id ? 'Данные' : 'Создать договор'}
              </button>
            )}
          </div>

          {!showMonthTable ? (
            <div className={styles.emptyBlock}>По объекту нет договора</div>
          ) : (
            <ObjectKpiTable
              ariaLabel={`KPI объекта ${selectedObject.name} по месяцам`}
              rows={monthRows}
              visibleRows={visibleMonthRows}
              columns={monthColumns}
              view={monthsView}
              onViewChange={setMonthsView}
              rowKey={row => `${row.skud_object_id}-${row.period_month}`}
              rowLabel={row => `${formatMonthLabel(row.period_month)}: данные объекта`}
              onRowClick={row => setOpenCard({ objectId: row.skud_object_id, mode: 'view' })}
              rowTone={row => (row.is_forecast
                ? 'forecast'
                : row.period_month.slice(0, 7) === currentMonth ? 'current' : undefined)}
              renderCell={renderMonthCell}
              loading={tableQuery.isLoading}
              emptyText="Расчётных месяцев по договору нет"
            />
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
