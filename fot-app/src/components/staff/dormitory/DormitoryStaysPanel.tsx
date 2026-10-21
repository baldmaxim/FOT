import type { FC } from 'react';

import { dormitoryService, type IDormitoryStay } from '../../../services/dormitoryService';
import { buildHousingStaysExport, HOUSING_STAY_COLUMNS } from '../../../utils/dormitoryTable';
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
}

const stayKey = (stay: IDormitoryStay): number => stay.id;
const stayName = (stay: IDormitoryStay): string => stay.full_name;

/**
 * Таблица проживаний с панелью — вкладка «Проживание» «Управления кадрами» (общежития и квартиры): поиск по ФИО,
 * «Экспорт» ровно видимых строк, при праве правки — «Добавить сотрудника».
 */
export const DormitoryStaysPanel: FC<IDormitoryStaysPanelProps> = ({
  rows, isLoading, isError, onRetry, onAdd, onEdit, onDelete, busyId = null,
}) => (
  <RegistryPanel
    label="Проживание"
    columns={HOUSING_STAY_COLUMNS}
    rows={rows}
    isLoading={isLoading}
    isError={isError}
    onRetry={onRetry}
    rowKey={stayKey}
    rowLabel={stayName}
    searchText={stayName}
    buildExport={buildHousingStaysExport}
    sendExport={dormitoryService.exportTable}
    onAdd={onAdd}
    onEdit={onEdit}
    onDelete={onDelete}
    busyKey={busyId}
  />
);
