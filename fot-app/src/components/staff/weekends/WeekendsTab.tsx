import { useCallback, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  STAFF_WEEKENDS_KEY,
  staffWeekendService,
  type IStaffWeekendRow,
} from '../../../services/staffWeekendService';
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  buildStaffWeekendExport,
  STAFF_WEEKEND_COLUMNS,
  staffWeekendMonthOptions,
} from '../../../utils/staffWeekendTable';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';

const rowKey = (row: IStaffWeekendRow): number => row.employee_id;
const rowName = (row: IStaffWeekendRow): string => row.full_name;

/**
 * «Управление кадрами» → «Выходные» (миграция 346): сотрудники ЛИНИЯ и ЛИНИЯ-Общестрой, которые работали в выходной
 * по СКУД, а корректировки на этот день нет. Плановые субботы графика сюда не входят. Только просмотр.
 */
export const WeekendsTab: FC = () => {
  const months = useRegistryMonths();
  const [currentMonth] = useState(() => moscowTodayIso().slice(0, 7));
  const pickerMonths = useMemo(
    () => ({ value: months.value, onChange: months.onChange, options: staffWeekendMonthOptions(currentMonth) }),
    [months.value, months.onChange, currentMonth],
  );

  const weekendsQuery = useQuery({
    queryKey: [...STAFF_WEEKENDS_KEY, months.param],
    queryFn: ({ signal }) => staffWeekendService.list(months.param, signal),
    staleTime: 0,
  });

  const buildExport = useCallback(
    (rows: ReadonlyArray<IStaffWeekendRow>) => buildStaffWeekendExport(rows, months.value),
    [months.value],
  );

  return (
    <RegistryPanel
      label="Выходные"
      columns={STAFF_WEEKEND_COLUMNS}
      rows={weekendsQuery.data}
      isLoading={weekendsQuery.isLoading}
      isError={weekendsQuery.isError}
      onRetry={() => { void weekendsQuery.refetch(); }}
      rowKey={rowKey}
      rowLabel={rowName}
      searchText={rowName}
      fioSearch
      buildExport={buildExport}
      sendExport={staffWeekendService.exportTable}
      months={pickerMonths}
    />
  );
};
