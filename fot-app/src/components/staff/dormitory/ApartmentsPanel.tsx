import { useCallback, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useSessionState } from '../../../hooks/useSessionState';
import {
  DORMITORY_APARTMENTS_KEY,
  dormitoryService,
  type IApartmentResident,
  type ICompanyApartment,
} from '../../../services/dormitoryService';
import { getMonthLabel } from '../../../utils/calendarUtils';
import {
  APARTMENT_ARCHIVE_COLUMNS,
  APARTMENT_COLUMNS,
  apartmentTitle,
  buildApartmentArchiveExport,
  buildApartmentsExport,
  closedInMonth,
  dismissedTone,
  housingBackPath,
  isDismissedStay,
  touchesMonth,
} from '../../../utils/housingTables';
import { parseOneOf } from '../../../utils/sessionState';
import type { ITableView } from '../../../utils/tableView';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { ApartmentFormModal } from './ApartmentFormModal';
import { ApartmentResidentsModal } from './ApartmentResidentsModal';
import styles from './DormitoryTab.module.css';
import { useEmployeeCardCell } from './useEmployeeCardCell';

interface IApartmentsPanelProps {
  canEdit: boolean;
  /** Подсказки общежитий — для «Переселить» из квартиры в общежитие. */
  addresses: readonly string[];
  /** Выбранный месяц (YYYY-MM): жильцы, поиск и «Архив» — за него. */
  month: string;
  /** Возврат из карточки сотрудника в окно квартиры (?apartment=): открыть его, если квартира есть в списке. */
  initialOpenedId: number | null;
  onChanged: () => void;
}

type Editor = { mode: 'add' } | { mode: 'edit'; apartment: ICompanyApartment } | null;
type ApartmentsMode = 'list' | 'archive';
const parseMode = parseOneOf<ApartmentsMode>(['list', 'archive']);

const apartmentKey = (apartment: ICompanyApartment): number => apartment.id;
const residentKey = (resident: IApartmentResident): number => resident.id;
const residentName = (resident: IApartmentResident): string => resident.full_name;
const BY_ADDRESS: ITableView = { sort: 'address', dir: 'asc', filters: {} };
const BY_CHECK_OUT: ITableView = { sort: 'check_out', dir: 'desc', filters: {} };

/**
 * Вкладка «Квартира» (миграция 371) — как «Учёт квартир» 1С: строка — служебная квартира (общий № на всех её жильцов),
 * столбцы №, Квартиры, Комнат, Мест, Цена, Оплачено по. Клик по строке — жильцы и история квартиры. Поиск — по адресу
 * и ФИО жильцов. С правом правки — «Добавить квартиру», ✎, 🗑 (только квартира без жильцов и истории). «Архив»
 * (24.11.2026) — выехавшие в выбранном месяце из всех квартир, только просмотр.
 */
export const ApartmentsPanel: FC<IApartmentsPanelProps> = ({ canEdit, addresses, month, initialOpenedId, onChanged }) => {
  const toast = useToast();
  const [editor, setEditor] = useState<Editor>(null);
  const [openedId, setOpenedId] = useState<number | null>(initialOpenedId);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [mode, setMode] = useSessionState<ApartmentsMode>('housing.apartments.mode', 'list', { parse: parseMode });
  const archive = mode === 'archive';
  const [year, monthNumber] = month.split('-').map(Number);
  const monthLabel = getMonthLabel(year, monthNumber);
  const archiveCardCell = useEmployeeCardCell<IApartmentResident>(housingBackPath('apartment', month));

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

  /** «Архив»: жильцы служебных квартир, выехавшие в выбранном месяце. */
  const archiveRows = useMemo(
    () => (data ? data.residents.filter(resident => resident.apartment_id && closedInMonth(resident, month, data.today)) : undefined),
    [data, month],
  );

  /** Поиск: адрес, пометка и ФИО живших в месяце — «Гладкая» найдёт Ляпидевского 12-58. */
  const searchText = useCallback((apartment: ICompanyApartment): string => {
    const names = (residentsByApartment.get(apartment.id) ?? [])
      .filter(resident => touchesMonth(resident, month))
      .map(resident => resident.full_name);
    return [apartmentTitle(apartment), ...names].join(' ');
  }, [month, residentsByApartment]);

  // Квартиры с этим id нет (удалили, нет доступа) — окно не открывается.
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

  const aside = () => (
    <div className={styles.aside}>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={archive}
        onClick={() => setMode(archive ? 'list' : 'archive')}
      >
        Архив
      </button>
    </div>
  );

  return (
    <>
      {archive ? (
        <RegistryPanel
          key="archive"
          label={`Квартиры — архив, ${monthLabel}`}
          columns={APARTMENT_ARCHIVE_COLUMNS}
          rows={archiveRows}
          isLoading={query.isLoading}
          isError={query.isError}
          onRetry={() => { void query.refetch(); }}
          rowKey={residentKey}
          rowLabel={residentName}
          searchText={residentName}
          fioSearch
          initialView={BY_CHECK_OUT}
          searchAside={aside}
          buildExport={buildApartmentArchiveExport(monthLabel)}
          sendExport={dormitoryService.exportTable}
          isDismissed={isDismissedStay}
          cellRenderers={archiveCardCell}
          rowTone={resident => dismissedTone(resident, data?.today ?? '')}
          columnWidthsKey="housing.apartments-archive"
          viewKey="housing.apartments.archive"
          emptyFilterFirst
        />
      ) : (
        <RegistryPanel
          key="list"
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
          searchAside={aside}
          buildExport={buildApartmentsExport}
          sendExport={dormitoryService.exportTable}
          onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
          addLabel="Добавить квартиру"
          onEdit={canEdit ? apartment => setEditor({ mode: 'edit', apartment }) : undefined}
          onDelete={canEdit ? apartment => { void remove(apartment); } : undefined}
          busyKey={busyId}
          onRowClick={apartment => setOpenedId(apartment.id)}
          columnWidthsKey="housing.apartments"
          viewKey="housing.apartments"
          emptyFilterFirst
        />
      )}

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
          cardBackPath={housingBackPath('apartment', month, opened.id)}
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
