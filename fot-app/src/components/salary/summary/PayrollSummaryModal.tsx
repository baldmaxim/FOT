import { useId, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { PAYROLL_SUMMARY_KEYS, payrollSummaryService } from '../../../services/payrollSummaryService';
import { payrollRegistryService } from '../../../services/payrollRegistryService';
import { registryMonthsParam } from '../../../utils/payrollRegistries';
import {
  buildSummarySnapshot,
  filterSummaryByCategory,
  groupSummaryByObject,
  SUMMARY_CATEGORIES,
  summaryCategoryTable,
  summaryItems,
  summaryObjectColumns,
  summaryObjectTotals,
  summaryPayoutText,
  summaryPeriodLabel,
  type ISummaryObjectRow,
  type SummaryCategory,
} from '../../../utils/payrollSummary';
import type { ITableView } from '../../../utils/tableView';
import { ModalShell } from '../../ui/ModalShell';
import { RegistryPanel, type RegistryVisibleOf } from '../../ui/registry/RegistryPanel';
import { PayrollSummaryObjectModal } from './PayrollSummaryObjectModal';
import modal from '../PayrollModal.module.css';
import styles from './PayrollSummary.module.css';

interface IPayrollSummaryModalProps {
  /** Выбранные месяцы (YYYY-MM); пусто — весь период. */
  months: string[];
  onClose: () => void;
}

const sendExport = payrollRegistryService.exportTable('summary');
const OBJECTS_VIEW: ITableView = { sort: 'object_name', dir: 'asc', filters: {} };
const objectKey = (row: ISummaryObjectRow): string => row.object_key;
const objectName = (row: ISummaryObjectRow): string => row.object_name;

/**
 * Окно «Свод»: суммы «Оплачено» (ЗУП) за выбранные месяцы по объектам — строки объекты, столбцы статьи,
 * «Начислено», «Удержано» и строка «Итого». Сверху — Все / ИТР / Офис / Рабочие; справа от поиска — «К выплате»
 * всех четырёх по текущим поиску и фильтрам. Клик по объекту — окно с его сотрудниками.
 */
export const PayrollSummaryModal: FC<IPayrollSummaryModalProps> = ({ months, onClose }) => {
  const titleId = useId();
  const monthsParam = registryMonthsParam(months);
  const [category, setCategory] = useState<SummaryCategory>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [opened, setOpened] = useState<ISummaryObjectRow | null>(null);

  const query = useQuery({
    queryKey: PAYROLL_SUMMARY_KEYS.data(monthsParam),
    queryFn: ({ signal }) => payrollSummaryService.get(monthsParam, signal),
    staleTime: 0,
  });

  const periodLabel = summaryPeriodLabel(months);
  const categoryLabel = SUMMARY_CATEGORIES.find(option => option.key === category)?.label ?? '';
  const categoryRows = useMemo(
    () => (query.data ? filterSummaryByCategory(query.data.rows, category) : undefined),
    [query.data, category],
  );
  const items = useMemo(() => summaryItems(categoryRows ?? []), [categoryRows]);
  const objects = useMemo(() => (categoryRows ? groupSummaryByObject(categoryRows) : undefined), [categoryRows]);
  const columns = useMemo(() => summaryObjectColumns(items), [items]);
  const totals = useMemo(() => summaryObjectTotals(items), [items]);
  const buildExport = useMemo(
    () => buildSummarySnapshot({ title: 'Свод', subject: categoryLabel, periodLabel, categoryLabel, columns }),
    [categoryLabel, periodLabel, columns],
  );
  const categoryTables = useMemo(
    () => SUMMARY_CATEGORIES.map(option => ({ ...option, ...summaryCategoryTable(query.data?.rows ?? [], option.key) })),
    [query.data],
  );
  // Итог вкладки — «К выплате» её строки «Итого» после переключения (поиск и фильтры столбцов те же).
  const renderCategoryTotals = (visibleOf: RegistryVisibleOf<ISummaryObjectRow>) => query.data && (
    <div className={styles.totals}>
      <span className={styles.totalsLabel}>Итого к выплате:</span>
      {categoryTables.map(table => (
        <span key={table.key} className={table.key === category ? `${styles.total} ${styles.totalActive}` : styles.total}>
          {table.label} <span className={styles.totalValue}>{summaryPayoutText(visibleOf(table.objects, table.columns))}</span>
        </span>
      ))}
    </div>
  );
  const openedRows = useMemo(
    () => (opened && categoryRows ? categoryRows.filter(row => row.object_key === opened.object_key) : []),
    [opened, categoryRows],
  );

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={modal.overlay}
      containerClassName={styles.container}
      closeOnEscape={!filterOpen && opened === null}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={`${modal.header} ${styles.header}`}>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>Свод · {periodLabel}</h2>
            </div>
            <div className={styles.categories} role="radiogroup" aria-label="Категория">
              {SUMMARY_CATEGORIES.map(option => (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={category === option.key}
                  className={category === option.key ? `${styles.category} ${styles.categoryActive}` : styles.category}
                  onClick={() => setCategory(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          {/* data-registry-fill: таблица прокручивается внутри окна, шапка закреплена (RegistryTable.module.css). */}
          <div className={`${modal.body} ${styles.body}`} data-registry-fill>
            <RegistryPanel
              label="Свод по объектам"
              columns={columns}
              rows={objects}
              isLoading={query.isLoading}
              isError={query.isError}
              onRetry={() => { void query.refetch(); }}
              rowKey={objectKey}
              rowLabel={objectName}
              searchText={objectName}
              searchPlaceholder="Поиск по объекту..."
              initialView={OBJECTS_VIEW}
              buildExport={buildExport}
              sendExport={sendExport}
              totals={totals}
              onRowClick={setOpened}
              raisedFilters
              onFilterOpenChange={setFilterOpen}
              searchAside={renderCategoryTotals}
            />
          </div>

          {opened && (
            <PayrollSummaryObjectModal
              objectName={opened.object_name}
              rows={openedRows}
              items={items}
              withCategory={category === 'all'}
              periodLabel={periodLabel}
              categoryLabel={categoryLabel}
              onClose={() => setOpened(null)}
            />
          )}
        </>
      )}
    </ModalShell>
  );
};
