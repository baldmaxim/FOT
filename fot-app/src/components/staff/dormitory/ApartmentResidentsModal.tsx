import { useId, useMemo, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useSessionState } from '../../../hooks/useSessionState';
import {
  dormitoryService,
  type IApartmentResident,
  type ICompanyApartment,
} from '../../../services/dormitoryService';
import { formatDate } from '../../../utils/formatMoney';
import {
  APARTMENT_HISTORY_COLUMNS,
  APARTMENT_RESIDENT_COLUMNS,
  apartmentTitle,
  buildApartmentHistoryExport,
  buildApartmentResidentsExport,
  dismissedTone,
  isDismissedStay,
  touchesMonth,
} from '../../../utils/housingTables';
import { parseOneOf } from '../../../utils/sessionState';
import type { ITableView } from '../../../utils/tableView';
import { PayrollRegistryModal } from '../../salary/registry/PayrollRegistryModal';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { RegistryTabs, type IRegistryTab } from '../../ui/registry/RegistryTabs';
import tabStyles from '../../ui/registry/RegistryTabs.module.css';
import { DormitoryStayModal } from './DormitoryStayModal';
import styles from './DormitoryTab.module.css';
import { StayMoveModal } from './StayMoveModal';
import { useEmployeeCardCell } from './useEmployeeCardCell';

type ResidentsTab = 'current' | 'history';
const parseResidentsTab = parseOneOf<ResidentsTab>(['current', 'history']);

type Editor =
  | { mode: 'add' }
  | { mode: 'edit'; stay: IApartmentResident }
  | { mode: 'move'; stay: IApartmentResident }
  | null;

interface IApartmentResidentsModalProps {
  apartment: ICompanyApartment;
  /** Все записи квартиры в охвате (сейчас, будущие и история). */
  residents: readonly IApartmentResident[];
  today: string;
  /** Выбранный месяц (YYYY-MM): «Проживающие» — жившие в нём хоть день. */
  month: string;
  /** Возврат из карточки сотрудника — на вкладку «Квартира», этот месяц и в это окно. */
  cardBackPath: string;
  /** Для «Переселить»: другие квартиры и подсказки общежитий. */
  apartments: readonly ICompanyApartment[];
  addresses: readonly string[];
  canEdit: boolean;
  onClose: () => void;
  /** После любой записи — перечитать вкладки. */
  onChanged: () => void;
}

const residentKey = (resident: IApartmentResident): number => resident.id;
const residentName = (resident: IApartmentResident): string => resident.full_name;
const BY_CHECK_IN: ITableView = { sort: 'check_in', dir: 'asc', filters: {} };
const BY_CHECK_OUT: ITableView = { sort: 'check_out', dir: 'desc', filters: {} };

/**
 * Клик по квартире на вкладке «Квартира» (миграция 371): «Проживающие» за выбранный месяц — как вкладка 1С (сотрудник
 * — ссылка на карточку, въезд, телефоны, «Платно» галочкой, отпуск, должность, объект; сведения — только у живущих
 * сегодня) и «История» — кто жил и когда. С правом правки: «Заселить», ✎ (даты,
 * выезд, «Переселить…»), 🗑 — ошибочная запись. Уволенные подсвечены.
 */
export const ApartmentResidentsModal: FC<IApartmentResidentsModalProps> = ({
  apartment, residents, today, month, cardBackPath, apartments, addresses, canEdit, onClose, onChanged,
}) => {
  const cardCell = useEmployeeCardCell<IApartmentResident>(cardBackPath);
  const toast = useToast();
  const baseId = useId();
  // Вкладка окна — своя у каждой квартиры и переживает уход в карточку: возврат из «Истории» — в «Историю».
  const [tab, setTab] = useSessionState<ResidentsTab>(`housing.apartment.${apartment.id}.tab`, 'current', {
    parse: parseResidentsTab,
  });
  const [editor, setEditor] = useState<Editor>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const title = `Кв. ${apartmentTitle(apartment)}`;

  const current = useMemo(() => residents.filter(resident => touchesMonth(resident, month)), [residents, month]);
  const history = useMemo(
    () => residents.filter(resident => resident.check_out !== null && resident.check_out <= today),
    [residents, today],
  );
  const tabs: ReadonlyArray<IRegistryTab<ResidentsTab>> = [
    { key: 'current', label: `Проживающие (${current.length})` },
    { key: 'history', label: `История (${history.length})` },
  ];
  const tabId = (key: ResidentsTab) => `${baseId}-tab-${key}`;
  const panelId = (key: ResidentsTab) => `${baseId}-panel-${key}`;
  const panelProps = (key: ResidentsTab) => ({
    className: tabStyles.tabPanel,
    role: 'tabpanel',
    id: panelId(key),
    'aria-labelledby': tabId(key),
    hidden: tab !== key,
    'data-registry-fill': true,
  });
  const tone = (resident: IApartmentResident) => dismissedTone(resident, today);

  const togglePaid = async (resident: IApartmentResident) => {
    if (busyId !== null) return;
    setBusyId(resident.id);
    try {
      await dormitoryService.updateMeta(resident.id, { paid: !resident.paid });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить «Платно»');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (resident: IApartmentResident) => {
    if (busyId !== null) return;
    if (!window.confirm(`Удалить запись: ${resident.full_name}, въезд ${formatDate(resident.check_in)}? Выезд ставят в ✎.`)) return;
    setBusyId(resident.id);
    try {
      await dormitoryService.remove(resident.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError && err.message ? err.message : 'Не удалось удалить');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PayrollRegistryModal
      title={title}
      onClose={onClose}
      closeOnEscape={!filterOpen && editor === null}
      backLabel="Назад к квартирам"
    >
      <RegistryTabs tabs={tabs} active={tab} onChange={setTab} tabId={tabId} panelId={panelId} label="Жильцы квартиры" />

      <div {...panelProps('current')}>
        <RegistryPanel
          label="Проживающие"
          columns={APARTMENT_RESIDENT_COLUMNS}
          rows={current}
          isLoading={false}
          isError={false}
          onRetry={onChanged}
          rowKey={residentKey}
          rowLabel={residentName}
          searchText={residentName}
          fioSearch
          initialView={BY_CHECK_IN}
          buildExport={buildApartmentResidentsExport(title)}
          sendExport={dormitoryService.exportTable}
          onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
          addLabel="Заселить"
          onEdit={canEdit ? resident => setEditor({ mode: 'edit', stay: resident }) : undefined}
          onDelete={canEdit ? resident => { void remove(resident); } : undefined}
          busyKey={busyId}
          rowTone={tone}
          raisedFilters
          onFilterOpenChange={setFilterOpen}
          columnWidthsKey="housing.apartment-residents"
          viewKey={`housing.apartment.${apartment.id}.residents`}
          emptyFilterFirst
          isDismissed={isDismissedStay}
          cellRenderers={{
            ...cardCell,
            paid: resident => (
              <label className={styles.paidCheck} title={canEdit ? 'Платно' : undefined}>
                <input
                  type="checkbox"
                  checked={resident.paid ?? false}
                  disabled={!canEdit || busyId !== null}
                  onChange={() => { void togglePaid(resident); }}
                  aria-label={`Платно: ${resident.full_name}`}
                />
              </label>
            ),
          }}
        />
      </div>

      <div {...panelProps('history')}>
        <RegistryPanel
          label="История"
          columns={APARTMENT_HISTORY_COLUMNS}
          rows={history}
          isLoading={false}
          isError={false}
          onRetry={onChanged}
          rowKey={residentKey}
          rowLabel={residentName}
          searchText={residentName}
          fioSearch
          initialView={BY_CHECK_OUT}
          buildExport={buildApartmentHistoryExport(title)}
          sendExport={dormitoryService.exportTable}
          rowTone={tone}
          raisedFilters
          onFilterOpenChange={setFilterOpen}
          columnWidthsKey="housing.apartment-history"
          viewKey={`housing.apartment.${apartment.id}.history`}
          emptyFilterFirst
          isDismissed={isDismissedStay}
          cellRenderers={cardCell}
        />
      </div>

      {editor?.mode === 'add' && (
        <DormitoryStayModal
          addresses={addresses}
          apartment={{ id: apartment.id, title: apartment.address }}
          fixedKind="dormitory"
          raised
          onClose={() => setEditor(null)}
          onSaved={onChanged}
        />
      )}
      {editor?.mode === 'edit' && (
        <DormitoryStayModal
          stay={editor.stay}
          addresses={addresses}
          raised
          onMove={() => setEditor({ mode: 'move', stay: editor.stay })}
          onClose={() => setEditor(current => (current?.mode === 'edit' ? null : current))}
          onSaved={onChanged}
        />
      )}
      {editor?.mode === 'move' && (
        <StayMoveModal
          stay={editor.stay}
          addresses={addresses}
          apartments={apartments}
          today={today}
          raised
          onClose={() => setEditor(null)}
          onSaved={onChanged}
        />
      )}
    </PayrollRegistryModal>
  );
};
