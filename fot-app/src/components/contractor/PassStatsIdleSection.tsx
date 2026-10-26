import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RegistryTable } from '../ui/registry/RegistryTable';
import { applyTableView, type IRegistryColumn, type ITableView } from '../../utils/tableView';
import {
  contractorAdminService,
  IDLE_PASS_DAYS,
  type IContractorIdlePass,
} from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

interface IPassStatsIdleSectionProps {
  orgId: string;
}

/** YYYY-MM-DD → ДД.ММ.ГГГГ. */
const formatIsoDate = (iso: string): string => iso.split('-').reverse().join('.');

const COLUMNS: ReadonlyArray<IRegistryColumn<IContractorIdlePass>> = [
  {
    key: 'pass_number', label: '№ пропуска', type: 'text', width: 110, nowrap: true,
    text: row => row.pass_number,
    sortValue: row => Number(row.pass_number),
  },
  {
    key: 'holder_name', label: 'ФИО', type: 'text',
    text: row => row.holder_name,
    sortValue: row => row.holder_name,
  },
  {
    key: 'last_event_date', label: 'Последний проход', type: 'text', width: 150, nowrap: true,
    text: row => (row.last_event_date ? formatIsoDate(row.last_event_date) : 'не было'),
    sortValue: row => row.last_event_date,
  },
  {
    key: 'last_access_point', label: 'Точка последнего прохода', type: 'text', width: 200,
    text: row => row.last_access_point ?? '—',
    sortValue: row => row.last_access_point,
  },
  {
    key: 'days_idle', label: 'Дней без проходов', type: 'int', width: 150, nowrap: true, numeric: true,
    text: row => String(row.days_idle),
    sortValue: row => row.days_idle,
  },
];

const INITIAL_VIEW: ITableView = { sort: 'days_idle', dir: 'desc', filters: {} };

/**
 * «Не ходят больше 5 дней» выбранного подрядчика: активные пропуска без проходов по СКУД,
 * сначала те, кто не ходит дольше всех. Состояние «на сейчас» — период модалки не влияет.
 * Смена подрядчика — новый key у компонента: сортировка и фильтры прежнего не переносятся.
 */
export const PassStatsIdleSection: FC<IPassStatsIdleSectionProps> = ({ orgId }) => {
  const [view, setView] = useState<ITableView>(INITIAL_VIEW);

  const idleQuery = useQuery<IContractorIdlePass[]>({
    queryKey: ['contractor-pass-idle', orgId],
    queryFn: () => contractorAdminService.getPassStatsIdle(orgId),
    staleTime: 30_000,
  });

  const rows = useMemo(() => idleQuery.data ?? [], [idleQuery.data]);
  const visibleRows = useMemo(() => applyTableView(rows, COLUMNS, view), [rows, view]);

  return (
    <>
      <div className={styles.statsSubtitle}>
        Не ходят больше {IDLE_PASS_DAYS} дней{idleQuery.isSuccess ? ` (${rows.length})` : ''}
      </div>
      {idleQuery.isError ? (
        <div className={styles.empty}>Не удалось загрузить список</div>
      ) : (
        <RegistryTable
          columns={COLUMNS}
          rows={rows}
          visibleRows={visibleRows}
          view={view}
          onViewChange={setView}
          loading={idleQuery.isLoading}
          label={`Не ходят больше ${IDLE_PASS_DAYS} дней`}
          rowKey={row => row.pass_id}
          rowLabel={row => row.holder_name}
          raisedFilters
        />
      )}
    </>
  );
};

export default PassStatsIdleSection;
