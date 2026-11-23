import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { DORMITORY_DIRECTORY_KEY, dormitoryService, type IDormitory } from '../../../services/dormitoryService';
import { buildDormitoryDirectoryExport, DORMITORY_DIRECTORY_COLUMNS } from '../../../utils/housingTables';
import type { ITableView } from '../../../utils/tableView';
import { PayrollRegistryModal } from '../../salary/registry/PayrollRegistryModal';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import tabStyles from '../../ui/registry/RegistryTabs.module.css';
import { DormitoryFormModal } from './DormitoryFormModal';

interface IDormitoriesModalProps {
  canEdit: boolean;
  onClose: () => void;
  /** После любой записи — перечитать вкладки «Проживания» (название могло смениться у записей). */
  onChanged: () => void;
}

type Editor = { mode: 'add' } | { mode: 'edit'; dormitory: IDormitory } | null;

const dormitoryKey = (dormitory: IDormitory): number => dormitory.id;
const dormitoryName = (dormitory: IDormitory): string => dormitory.address;
const BY_NAME: ITableView = { sort: 'address', dir: 'asc', filters: {} };

/**
 * «Общежитие» → «Справочник» (миграция 377) — справочник общежитий, как «Общежития» 1С: №, Дата, Номер, Общежитие,
 * Стоимость места (только для информации). Поиск по названию, «Экспорт»; с правом правки — «Добавить общежитие», ✎,
 * 🗑 (только общежитие, где никто никогда не жил). При заселении и переселении общежитие выбирают из него.
 */
export const DormitoriesModal: FC<IDormitoriesModalProps> = ({ canEdit, onClose, onChanged }) => {
  const toast = useToast();
  const [editor, setEditor] = useState<Editor>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const query = useQuery({
    queryKey: DORMITORY_DIRECTORY_KEY,
    queryFn: ({ signal }) => dormitoryService.listDormitories(signal),
    staleTime: 0,
  });

  const remove = async (dormitory: IDormitory) => {
    if (busyId !== null) return;
    if (!window.confirm(`Удалить общежитие «${dormitory.address}» из справочника?`)) return;
    setBusyId(dormitory.id);
    try {
      await dormitoryService.removeDormitory(dormitory.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PayrollRegistryModal
      title="Справочник общежитий"
      onClose={onClose}
      closeOnEscape={!filterOpen && editor === null}
      backLabel="Назад к общежитиям"
    >
      <div className={tabStyles.tabPanel} data-registry-fill>
        <RegistryPanel
          label="Справочник общежитий"
          columns={DORMITORY_DIRECTORY_COLUMNS}
          rows={query.data}
          isLoading={query.isLoading}
          isError={query.isError}
          onRetry={() => { void query.refetch(); }}
          rowKey={dormitoryKey}
          rowLabel={dormitoryName}
          searchText={dormitoryName}
          searchPlaceholder="Поиск по общежитию..."
          initialView={BY_NAME}
          buildExport={buildDormitoryDirectoryExport}
          sendExport={dormitoryService.exportTable}
          onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
          addLabel="Добавить общежитие"
          onEdit={canEdit ? dormitory => setEditor({ mode: 'edit', dormitory }) : undefined}
          onDelete={canEdit ? dormitory => { void remove(dormitory); } : undefined}
          busyKey={busyId}
          raisedFilters
          onFilterOpenChange={setFilterOpen}
          columnWidthsKey="housing.dormitories"
        />
      </div>

      {editor && (
        <DormitoryFormModal
          dormitory={editor.mode === 'edit' ? editor.dormitory : undefined}
          onClose={() => setEditor(null)}
          onSaved={onChanged}
        />
      )}
    </PayrollRegistryModal>
  );
};
