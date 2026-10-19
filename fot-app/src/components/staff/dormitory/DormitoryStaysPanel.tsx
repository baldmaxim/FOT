import type { FC } from 'react';

import { dormitoryService, type IDormitoryStay } from '../../../services/dormitoryService';
import { buildDormitoryExport, DORMITORY_COLUMNS } from '../../../utils/dormitoryTable';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';

interface IDormitoryStaysPanelProps {
  /** undefined — ещё не загружены. */
  rows: IDormitoryStay[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Переданы — «Добавить сотрудника», ✎ и 🗑 (право «Редактирование»). */
  onAdd?: () => void;
  onEdit?: (stay: IDormitoryStay) => void;
  onDelete?: (stay: IDormitoryStay) => void;
  busyId?: number | null;
  /** Таблица в модальном окне: фильтр столбца — над окном. */
  raisedFilters?: boolean;
  onFilterOpenChange?: (open: boolean) => void;
}

const stayKey = (stay: IDormitoryStay): number => stay.id;
const stayName = (stay: IDormitoryStay): string => stay.full_name;

/**
 * Таблица «Общежитие» с панелью — вкладка «Управления кадрами» и окно «Справочника» «Зарплаты»:
 * поиск по ФИО, «Экспорт» ровно видимых строк, при праве правки — «Добавить сотрудника».
 */
export const DormitoryStaysPanel: FC<IDormitoryStaysPanelProps> = ({
  rows, isLoading, isError, onRetry, onAdd, onEdit, onDelete, busyId = null, raisedFilters = false, onFilterOpenChange,
}) => (
  <RegistryPanel
    label="Общежитие"
    columns={DORMITORY_COLUMNS}
    rows={rows}
    isLoading={isLoading}
    isError={isError}
    onRetry={onRetry}
    rowKey={stayKey}
    rowLabel={stayName}
    searchText={stayName}
    buildExport={buildDormitoryExport}
    sendExport={dormitoryService.exportTable}
    onAdd={onAdd}
    onEdit={onEdit}
    onDelete={onDelete}
    busyKey={busyId}
    raisedFilters={raisedFilters}
    onFilterOpenChange={onFilterOpenChange}
  />
);
