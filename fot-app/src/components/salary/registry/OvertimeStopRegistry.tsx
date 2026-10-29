import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type IOvertimeStop,
} from '../../../services/payrollRegistryService';
import { formatDate } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  buildOvertimeStopExport,
  OVERTIME_STOP_COLUMNS,
  registryRemoval,
  stopInMonths,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { RegistryPeriodForm } from './RegistryPeriodForm';

interface IOvertimeStopRegistryProps {
  /** Право правки «Справочника» (/salary/terms или /salary/payments). */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; stop: IOvertimeStop } | null;

/** Вкладка «Табель → Зарплата» (useTimesheetSalary): «Переработка» и «Сумма» отдела. */
const TIMESHEET_SALARY_PREFIX = ['timesheet-salary'] as const;

const sendExport = payrollRegistryService.exportTable('overtime-stops');
const rowKey = (stop: IOvertimeStop): number => stop.id;
const rowName = (stop: IOvertimeStop): string => stop.full_name;
const canEditRow = (stop: IOvertimeStop): boolean => stop.can_edit;

/**
 * «Справочник» → «Без переработки»: кому не оплачивать переработку (выходы сверх нормы и часы по корректировкам),
 * период «с — по» (все периоды — история; показываются задевающие выбранные месяцы). 🗑 «Убрать» — с 1-го числа
 * текущего месяца: период закрывается датой «по», прошлые месяцы остаются; не начавшийся или прошлый период —
 * ошибочная строка, удаляется.
 */
export const OvertimeStopRegistry: FC<IOvertimeStopRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<number | null>(null);
  const months = useRegistryMonths();

  const query = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.overtimeStops,
    queryFn: ({ signal }) => payrollRegistryService.listOvertimeStops(signal),
    staleTime: 0,
  });
  const rows = useMemo(() => query.data?.filter(stop => stopInMonths(stop, months.value)), [query.data, months.value]);

  // Период меняет «Переработку» и «Сумму»: префикс 'payroll-terms' — «Расчёты», листок и эта таблица; плюс вкладка табеля.
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX }),
    queryClient.invalidateQueries({ queryKey: TIMESHEET_SALARY_PREFIX }),
  ]);

  const handleDelete = async (stop: IOvertimeStop) => {
    if (busyKey !== null) return;
    // Убран с 1-го числа: прошлые месяцы остаются историей; не начавшийся или прошлый период — ошибочный.
    const removal = registryRemoval(stop, moscowTodayIso());
    const question = removal.action === 'close'
      ? `Убрать ${stop.full_name} из «Без переработки» с ${formatDate(removal.cutoff)}? По ${formatDate(removal.dateTo)} строка останется в истории.`
      : `Удалить ошибочную строку: ${stop.full_name}, с ${formatDate(stop.date_from)}?`;
    if (!window.confirm(question)) return;
    setBusyKey(stop.id);
    try {
      if (removal.action === 'close') {
        await payrollRegistryService.updateOvertimeStop(stop.id, { date_from: stop.date_from, date_to: removal.dateTo });
      } else {
        await payrollRegistryService.removeOvertimeStop(stop.id);
      }
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Без переработки" onClose={onClose} closeOnEscape={!filterOpen && !editor}>
      <RegistryPanel
        label="Без переработки"
        columns={OVERTIME_STOP_COLUMNS}
        rows={rows}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        buildExport={buildOvertimeStopExport}
        sendExport={sendExport}
        months={months}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? stop => setEditor({ mode: 'edit', stop }) : undefined}
        onDelete={canEdit ? stop => { void handleDelete(stop); } : undefined}
        deleteLabel="Убрать"
        canEditRow={canEditRow}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {editor && (
        <RegistryPeriodForm
          title="Без переработки"
          fromLabel="Без переработки с"
          row={editor.mode === 'edit' ? editor.stop : undefined}
          onAdd={payrollRegistryService.addOvertimeStop}
          onUpdate={payrollRegistryService.updateOvertimeStop}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
