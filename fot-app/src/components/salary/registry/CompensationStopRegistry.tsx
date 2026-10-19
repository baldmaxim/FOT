import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useRegistryMonths } from '../../../hooks/useRegistryMonths';
import {
  PAYROLL_REGISTRY_KEYS,
  payrollRegistryService,
  type ICompensationStop,
} from '../../../services/payrollRegistryService';
import { formatDate } from '../../../utils/formatMoney';
import { buildCompensationStopExport, COMPENSATION_STOP_COLUMNS, stopInMonths } from '../../../utils/payrollRegistries';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { CompensationStopForm } from './CompensationStopForm';
import { PayrollRegistryModal } from './PayrollRegistryModal';

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
 * показываются задевающие выбранные месяцы). Возобновили выплату — ✎ и дата «по»; 🗑 — только ошибочная строка.
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

  const refresh = () => queryClient.invalidateQueries({ queryKey: PAYROLL_REGISTRY_KEYS.stops });

  const handleDelete = async (stop: ICompensationStop) => {
    if (busyKey !== null) return;
    if (!window.confirm(`Удалить ошибочную строку: ${stop.full_name}, с ${formatDate(stop.date_from)}?`)) return;
    setBusyKey(stop.id);
    try {
      await payrollRegistryService.removeStop(stop.id);
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
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
        canEditRow={canEditRow}
        busyKey={busyKey}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />

      {editor && (
        <CompensationStopForm
          stop={editor.mode === 'edit' ? editor.stop : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
    </PayrollRegistryModal>
  );
};
