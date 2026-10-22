import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  PAYROLL_TERMS_PREFIX,
  payrollRegistryService,
  type ICompensationStop,
} from '../../../services/payrollRegistryService';
import { formatDate } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import {
  buildCompensationStopExport,
  COMPENSATION_STOP_COLUMNS,
  registryRemoval,
  stopInMonths,
} from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from './PayrollRegistryModal';
import { RegistryPeriodForm } from './RegistryPeriodForm';

interface ICompensationStopRegistryProps {
  /** Право правки «Справочника» (/salary/terms или /salary/payments). */
  canEdit: boolean;
  onClose: () => void;
}

type EditorState = { mode: 'add' } | { mode: 'edit'; stop: ICompensationStop } | null;

const sendExport = payrollRegistryService.exportTable('compensation-stops');
const rowKey = (stop: ICompensationStop): number => stop.id;
const rowName = (stop: ICompensationStop): string => stop.full_name;
const canEditRow = (stop: ICompensationStop): boolean => stop.can_edit;

/**
 * «Справочник» → «Без проезда»: кому не выплачивать проезд, период «с — по» (все периоды — история;
 * показываются задевающие выбранные месяцы). 🗑 «Убрать» — с 1-го числа текущего месяца: период закрывается
 * датой «по», прошлые месяцы остаются; не начавшийся или прошлый период — ошибочная строка, удаляется.
 */
export const CompensationStopRegistry: FC<ICompensationStopRegistryProps> = ({ canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filterOpen, setFilterOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyKey, setBusyKey] = useState<number | null>(null);
  const months = useRegistryMonths();

  const query = useQuery({
    queryKey: PAYROLL_REGISTRY_KEYS.stops,
    queryFn: ({ signal }) => payrollRegistryService.listStops(signal),
    staleTime: 0,
  });
  const rows = useMemo(() => query.data?.filter(stop => stopInMonths(stop, months.value)), [query.data, months.value]);

  // «Без проезда» решает проезд в карточке и листке — префикс 'payroll-terms' перечитывает и их, и эту таблицу.
  const refresh = () => queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });

  const handleDelete = async (stop: ICompensationStop) => {
    if (busyKey !== null) return;
    // Убран с 1-го числа: прошлые месяцы остаются историей; не начавшийся или прошлый период — ошибочный.
    const removal = registryRemoval(stop, moscowTodayIso());
    const question = removal.action === 'close'
      ? `Убрать ${stop.full_name} из «Без проезда» с ${formatDate(removal.cutoff)}? По ${formatDate(removal.dateTo)} строка останется в истории.`
      : `Удалить ошибочную строку: ${stop.full_name}, с ${formatDate(stop.date_from)}?`;
    if (!window.confirm(question)) return;
    setBusyKey(stop.id);
    try {
      if (removal.action === 'close') {
        await payrollRegistryService.updateStop(stop.id, { date_from: stop.date_from, date_to: removal.dateTo });
      } else {
        await payrollRegistryService.removeStop(stop.id);
      }
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось убрать');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  };

  return (
    <PayrollRegistryModal title="Без проезда" onClose={onClose} closeOnEscape={!filterOpen && !editor}>
      <RegistryPanel
        label="Без проезда"
        columns={COMPENSATION_STOP_COLUMNS}
        rows={rows}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        buildExport={buildCompensationStopExport}
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
          title="Без проезда"
          fromLabel="Без проезда с"
          row={editor.mode === 'edit' ? editor.stop : undefined}
          onAdd={payrollRegistryService.addStop}
          onUpdate={payrollRegistryService.updateStop}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
