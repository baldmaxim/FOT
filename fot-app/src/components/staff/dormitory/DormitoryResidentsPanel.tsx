import { useId, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import {
  DORMITORY_RESIDENTS_KEY,
  dormitoryService,
  type IDormitoryResident,
} from '../../../services/dormitoryService';
import { formatDate } from '../../../utils/formatMoney';
import {
  buildDormitoryHistoryExport,
  buildDormitoryResidentsExport,
  dismissedTone,
  DORMITORY_HISTORY_COLUMNS,
  dormitoryResidentColumns,
  isDismissedStay,
  touchesMonth,
} from '../../../utils/housingTables';
import type { ITableView } from '../../../utils/tableView';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { DormitoryStayModal } from './DormitoryStayModal';
import styles from './DormitoryTab.module.css';
import { StayMoveModal } from './StayMoveModal';
import { useEmployeeCardCell } from './useEmployeeCardCell';

interface IDormitoryResidentsPanelProps {
  canEdit: boolean;
  addresses: readonly string[];
  /** Выбранный месяц (YYYY-MM): в таблице — жившие в нём хоть день. */
  month: string;
  /** Возврат из карточки сотрудника — сюда (вкладка и месяц). */
  cardBackPath: string;
  onChanged: () => void;
}

type Editor =
  | { mode: 'add' }
  | { mode: 'edit'; stay: IDormitoryResident }
  | { mode: 'move'; stay: IDormitoryResident }
  | null;

/** «Все общежития» в селекте. */
const ALL = '';
const residentKey = (resident: IDormitoryResident): number => resident.id;
const residentName = (resident: IDormitoryResident): string => resident.full_name;
const BY_CHECK_OUT: ITableView = { sort: 'check_out', dir: 'desc', filters: {} };

const sameAddress = (a: string | null, b: string): boolean => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Вкладка «Общежитие» (миграция 371) — как отчёт 1С «Проживающие в общежитии последний вход (СКД)»: за выбранный месяц
 * — все, кто жил в нём хоть день; селект общежития (с числом живших в месяце; «Все общежития» — плюс столбец
 * «Общежитие»), поиск по ФИО — по всем; №, Подразделение организации, Сотрудник (ссылка на карточку), Дата въезда,
 * Дата выезда, Паспорт (полный — с правом «Реквизитов»), Крайний проход (до конца месяца), Крайний проход на объекте,
 * Начальник участка, Комментарий; ширина столбцов — как в Excel. «История» — все закончившиеся записи (с
 * комментарием), месяц на неё не влияет. С правом правки — «Заселить» (с комментарием), ✎ (даты, выезд, комментарий,
 * «Переселить в другое общежитие…»), 🗑 —
 * ошибочная запись. Уволенные подсвечены, галочка «Уволенные» в фильтре «Сотрудника» их скрывает.
 */
export const DormitoryResidentsPanel: FC<IDormitoryResidentsPanelProps> = ({
  canEdit, addresses, month, cardBackPath, onChanged,
}) => {
  const toast = useToast();
  const selectId = useId();
  const [place, setPlace] = useState(ALL);
  const [showHistory, setShowHistory] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const query = useQuery({
    queryKey: [...DORMITORY_RESIDENTS_KEY, month],
    queryFn: ({ signal }) => dormitoryService.listResidents(month, signal),
    staleTime: 0,
  });
  const cardCell = useEmployeeCardCell<IDormitoryResident>(cardBackPath);
  const today = query.data?.today ?? '';
  const all = useMemo(() => query.data?.residents ?? [], [query.data]);

  /** Жили в выбранном месяце хоть день. */
  const current = useMemo(() => all.filter(resident => touchesMonth(resident, month)), [all, month]);
  const history = useMemo(() => all.filter(resident => resident.check_out !== null && resident.check_out <= today), [all, today]);

  /**
   * Общежития с числом живших в месяце — по написанию первой записи, без учёта регистра. Каждая запись — один раз:
   * закончившаяся в выбранном месяце есть и в нём, и в «Истории».
   */
  const places = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const resident of all) {
      const label = (resident.address ?? '').trim();
      if (!label) continue;
      const key = label.toLowerCase();
      const entry = counts.get(key) ?? { label, count: 0 };
      if (touchesMonth(resident, month)) entry.count += 1;
      counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [all, month]);

  const source = showHistory ? history : current;
  const rows = useMemo(
    () => (query.data ? (place === ALL ? source : source.filter(resident => sameAddress(resident.address, place))) : undefined),
    [query.data, place, source],
  );
  const withPlace = place === ALL;
  const title = place === ALL ? 'Общежития' : place;
  const columns = useMemo(() => (showHistory ? DORMITORY_HISTORY_COLUMNS : dormitoryResidentColumns(withPlace)), [showHistory, withPlace]);

  const remove = async (resident: IDormitoryResident) => {
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

  const aside = () => (
    <div className={styles.aside}>
      <select
        id={selectId}
        className={styles.select}
        value={place}
        onChange={event => setPlace(event.target.value)}
        aria-label="Общежитие"
      >
        <option value={ALL}>{`Все общежития (${current.length})`}</option>
        {places.map(item => (
          <option key={item.label} value={item.label}>{`${item.label} (${item.count})`}</option>
        ))}
      </select>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={showHistory}
        onClick={() => setShowHistory(value => !value)}
      >
        История
      </button>
    </div>
  );

  return (
    <>
      <RegistryPanel
        // Другие столбцы — заново: сортировка и фильтры прежних столбцов к ним не относятся.
        key={showHistory ? 'history' : `current-${withPlace ? 'all' : 'one'}`}
        columnWidthsKey={showHistory ? 'housing.dormitory-history' : 'housing.dormitory'}
        isDismissed={isDismissedStay}
        cellRenderers={cardCell}
        label={showHistory ? `${title} — история` : title}
        columns={columns}
        rows={rows}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={residentKey}
        rowLabel={residentName}
        searchText={residentName}
        fioSearch
        {...(showHistory ? { initialView: BY_CHECK_OUT } : {})}
        searchAside={aside}
        buildExport={showHistory ? buildDormitoryHistoryExport(title) : buildDormitoryResidentsExport(title, withPlace)}
        sendExport={dormitoryService.exportTable}
        onAdd={canEdit && !showHistory ? () => setEditor({ mode: 'add' }) : undefined}
        addLabel="Заселить"
        onEdit={canEdit && !showHistory ? resident => setEditor({ mode: 'edit', stay: resident }) : undefined}
        onDelete={canEdit && !showHistory ? resident => { void remove(resident); } : undefined}
        busyKey={busyId}
        rowTone={resident => dismissedTone(resident, today)}
      />

      {editor?.mode === 'add' && (
        <DormitoryStayModal
          addresses={place === ALL ? addresses : [place, ...addresses.filter(item => !sameAddress(item, place))]}
          fixedKind="dormitory"
          withComment
          onClose={() => setEditor(null)}
          onSaved={onChanged}
        />
      )}
      {editor?.mode === 'edit' && (
        <DormitoryStayModal
          stay={editor.stay}
          addresses={addresses}
          withComment
          onMove={() => setEditor({ mode: 'move', stay: editor.stay })}
          moveLabel="Переселить в другое общежитие…"
          onClose={() => setEditor(prev => (prev?.mode === 'edit' ? null : prev))}
          onSaved={onChanged}
        />
      )}
      {editor?.mode === 'move' && (
        <StayMoveModal
          stay={editor.stay}
          addresses={addresses}
          apartments={[]}
          allowFlat={false}
          today={today}
          onClose={() => setEditor(null)}
          onSaved={onChanged}
        />
      )}
    </>
  );
};
