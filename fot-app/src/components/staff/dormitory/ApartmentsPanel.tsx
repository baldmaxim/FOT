import { useCallback, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import {
  DORMITORY_APARTMENTS_KEY,
  dormitoryService,
  type IApartmentResident,
  type ICompanyApartment,
} from '../../../services/dormitoryService';
import { APARTMENT_COLUMNS, apartmentTitle, buildApartmentsExport, touchesMonth } from '../../../utils/housingTables';
import type { ITableView } from '../../../utils/tableView';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { ApartmentFormModal } from './ApartmentFormModal';
import { ApartmentResidentsModal } from './ApartmentResidentsModal';

interface IApartmentsPanelProps {
  canEdit: boolean;
  /** Подсказки общежитий — для «Переселить» из квартиры в общежитие. */
  addresses: readonly string[];
  /** Выбранный месяц (YYYY-MM): жильцы и поиск — за него. */
  month: string;
  /** Возврат из карточки сотрудника — сюда (вкладка и месяц). */
  cardBackPath: string;
  onChanged: () => void;
}

type Editor = { mode: 'add' } | { mode: 'edit'; apartment: ICompanyApartment } | null;

const apartmentKey = (apartment: ICompanyApartment): number => apartment.id;
const BY_ADDRESS: ITableView = { sort: 'address', dir: 'asc', filters: {} };

/**
 * Вкладка «Квартира» (миграция 371) — как «Учёт квартир» 1С: строка — служебная квартира (общий № на всех её жильцов),
 * столбцы №, Квартиры, Комнат, Мест, Цена, Оплачено по. Клик по строке — жильцы и история квартиры. Поиск — по адресу
 * и ФИО жильцов. С правом правки — «Добавить квартиру», ✎, 🗑 (только квартира без жильцов и истории).
 */
export const ApartmentsPanel: FC<IApartmentsPanelProps> = ({ canEdit, addresses, month, cardBackPath, onChanged }) => {
  const toast = useToast();
  const [editor, setEditor] = useState<Editor>(null);
  const [openedId, setOpenedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const query = useQuery({
    queryKey: DORMITORY_APARTMENTS_KEY,
    queryFn: ({ signal }) => dormitoryService.listApartments(signal),
    staleTime: 0,
  });
  const data = query.data;

  const residentsByApartment = useMemo(() => {
    const map = new Map<number, IApartmentResident[]>();
    for (const resident of data?.residents ?? []) {
      if (resident.apartment_id === null || resident.apartment_id === undefined) continue;
      const list = map.get(resident.apartment_id) ?? [];
      list.push(resident);
      map.set(resident.apartment_id, list);
    }
    return map;
  }, [data]);

  /** Поиск: адрес, пометка и ФИО живших в месяце — «Гладкая» найдёт Ляпидевского 12-58. */
  const searchText = useCallback((apartment: ICompanyApartment): string => {
    const names = (residentsByApartment.get(apartment.id) ?? [])
      .filter(resident => touchesMonth(resident, month))
      .map(resident => resident.full_name);
    return [apartmentTitle(apartment), ...names].join(' ');
  }, [month, residentsByApartment]);

  const opened = openedId === null ? null : data?.apartments.find(apartment => apartment.id === openedId) ?? null;

  const remove = async (apartment: ICompanyApartment) => {
    if (busyId !== null) return;
    if (!window.confirm(`Удалить квартиру «${apartmentTitle(apartment)}»?`)) return;
    setBusyId(apartment.id);
    try {
      await dormitoryService.removeApartment(apartment.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <RegistryPanel
        label="Квартиры"
        columns={APARTMENT_COLUMNS}
        rows={data?.apartments}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={apartmentKey}
        rowLabel={apartmentTitle}
        searchText={searchText}
        searchPlaceholder="Поиск по адресу или ФИО..."
        initialView={BY_ADDRESS}
        buildExport={buildApartmentsExport}
        sendExport={dormitoryService.exportTable}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        addLabel="Добавить квартиру"
        onEdit={canEdit ? apartment => setEditor({ mode: 'edit', apartment }) : undefined}
        onDelete={canEdit ? apartment => { void remove(apartment); } : undefined}
        busyKey={busyId}
        onRowClick={apartment => setOpenedId(apartment.id)}
        columnWidthsKey="housing.apartments"
      />

      {editor && (
        <ApartmentFormModal
          apartment={editor.mode === 'edit' ? editor.apartment : undefined}
          onClose={() => setEditor(null)}
          onSaved={onChanged}
        />
      )}

      {opened && data && (
        <ApartmentResidentsModal
          apartment={opened}
          residents={residentsByApartment.get(opened.id) ?? []}
          today={data.today}
          month={month}
          cardBackPath={cardBackPath}
          apartments={data.apartments}
          addresses={addresses}
          canEdit={canEdit}
          onClose={() => setOpenedId(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
};
