import { useMemo, useState, type FC, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import {
  DORMITORY_PENALTIES_KEY,
  dormitoryService,
  type IDormitoryPenaltyRow,
} from '../../../services/dormitoryService';
import {
  buildPenaltiesExport,
  isDismissedPenaltyRow,
  PENALTY_COLUMNS,
} from '../../../utils/dormitoryPenalties';
import { formatDate } from '../../../utils/formatMoney';
import type { ITableView } from '../../../utils/tableView';
import type { RegistryVisibleOf } from '../../ui/registry/RegistryPanel';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { DormitoryPenaltyModal } from './DormitoryPenaltyModal';
import { EmployeeCardLink } from './EmployeeCardLink';

interface IDormitoryPenaltiesPanelProps {
  canEdit: boolean;
  /** Возврат из карточки сотрудника — сюда (вкладка «Общежитие», месяц; режим — в sessionStorage). */
  cardBackPath: string;
  /** Блок справа от поиска — кнопки режимов «Общежития». */
  searchAside: (visibleOf: RegistryVisibleOf<IDormitoryPenaltyRow>) => ReactNode;
}

type Editor = { mode: 'add' } | { mode: 'edit'; penalty: IDormitoryPenaltyRow } | null;

const rowKey = (row: IDormitoryPenaltyRow): string => row.key;
const rowName = (row: IDormitoryPenaltyRow): string => row.full_name;
const isListRow = (row: IDormitoryPenaltyRow): boolean => row.source === 'list' && row.id !== null;
const BY_DATE: ITableView = { sort: 'penalty_date', dir: 'desc', filters: {} };

/**
 * «Общежитие» → «История взысканий» (миграция 378): отдельный список (сотрудник, дата, информация) и действующие
 * записи «Чёрного списка» пропусков — только чтение (их ведут в «Системе»). Месяц на список не влияет. С правом правки —
 * «Добавить», ✎ и 🗑 у записей списка. Окно «Заселить» по тем же записям предупреждает о взысканиях.
 */
export const DormitoryPenaltiesPanel: FC<IDormitoryPenaltiesPanelProps> = ({ canEdit, cardBackPath, searchAside }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isAdmin, canViewPage } = useAuth();
  const canOpenCard = isAdmin || canViewPage('/employees');
  const [editor, setEditor] = useState<Editor>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const query = useQuery({
    queryKey: DORMITORY_PENALTIES_KEY,
    queryFn: ({ signal }) => dormitoryService.listPenalties(signal),
    staleTime: 0,
  });
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: DORMITORY_PENALTIES_KEY }); };

  // ФИО — ссылкой на карточку; запись «Чёрного списка» без карточки — текстом.
  const cellRenderers = useMemo(() => (canOpenCard ? {
    full_name: (row: IDormitoryPenaltyRow) => (row.employee_id === null ? undefined : (
      <EmployeeCardLink employeeId={row.employee_id} fullName={row.full_name} backPath={cardBackPath} />
    )),
  } : undefined), [canOpenCard, cardBackPath]);

  const remove = async (row: IDormitoryPenaltyRow) => {
    if (busyKey !== null || row.id === null) return;
    const when = row.penalty_date ? `, ${formatDate(row.penalty_date)}` : '';
    if (!window.confirm(`Удалить взыскание: ${row.full_name}${when}?`)) return;
    setBusyKey(row.key);
    try {
      await dormitoryService.removePenalty(row.id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <RegistryPanel
        key="penalties"
        label="История взысканий"
        columns={PENALTY_COLUMNS}
        rows={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        initialView={BY_DATE}
        searchAside={searchAside}
        columnWidthsKey="housing.dormitory-penalties"
        viewKey="housing.dormitory.penalties"
        emptyFilterFirst
        isDismissed={isDismissedPenaltyRow}
        cellRenderers={cellRenderers}
        rowTone={row => (isDismissedPenaltyRow(row)
          ? { tone: 'dismissed', hint: row.dismissal_date ? `Уволен ${formatDate(row.dismissal_date)}` : 'Уволен' }
          : null)}
        buildExport={buildPenaltiesExport}
        sendExport={dormitoryService.exportTable}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        addLabel="Добавить"
        onEdit={canEdit ? row => setEditor({ mode: 'edit', penalty: row }) : undefined}
        onDelete={canEdit ? row => { void remove(row); } : undefined}
        canEditRow={isListRow}
        canDeleteRow={isListRow}
        busyKey={busyKey}
      />

      {editor && (
        <DormitoryPenaltyModal
          penalty={editor.mode === 'edit' ? editor.penalty : undefined}
          onClose={() => setEditor(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
};
