import { useId, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useSessionState } from '../../../hooks/useSessionState';
import {
  DORMITORY_RESIDENTS_KEY,
  dormitoryService,
  type IDormitoryResident,
} from '../../../services/dormitoryService';
import { getMonthLabel } from '../../../utils/calendarUtils';
import { formatDate } from '../../../utils/formatMoney';
import {
  buildDormitoryArchiveExport,
  buildDormitoryResidentsExport,
  closedInMonth,
  dismissedTone,
  DORMITORY_ARCHIVE_COLUMNS,
  dormitoryResidentColumns,
  isDismissedStay,
  touchesMonth,
} from '../../../utils/housingTables';
import { parseOneOf, parseString } from '../../../utils/sessionState';
import type { ITableView } from '../../../utils/tableView';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { DormitoriesModal } from './DormitoriesModal';
import { DormitoryPenaltiesPanel } from './DormitoryPenaltiesPanel';
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

/** Режим вкладки: жившие в месяце, «Архив» (выехавшие в месяце), «История взысканий». */
type ResidentsMode = 'current' | 'archive' | 'penalties';
const parseMode = parseOneOf<ResidentsMode>(['current', 'archive', 'penalties']);

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
 * Дата выезда, Паспорт (полный — с правкой «Реквизитов» или «Проживания»), Крайний проход (до конца месяца), Крайний проход на объекте,
 * Начальник участка, Комментарий; ширина столбцов — как в Excel. «Архив» (24.11.2026, было «История» — все
 * закончившиеся) — выехавшие в выбранном месяце, с комментарием. «История взысканий» (миграция 378) — отдельный список
 * и «Чёрный список» пропусков. «Справочник» — справочник общежитий (миграция 377): при заселении и переселении
 * общежитие выбирают из него. С правом правки — «Заселить» (с комментарием и предупреждением о взысканиях), клик по
 * строке и ✎ (даты, выезд, комментарий, «Переселить в другое общежитие…»), 🗑 — ошибочная запись. Уволенные подсвечены, галочка
 * «Уволенные» в фильтре «Сотрудника» их скрывает. Режим, общежитие, поиск и фильтры переживают уход в карточку.
 */
export const DormitoryResidentsPanel: FC<IDormitoryResidentsPanelProps> = ({
  canEdit, addresses, month, cardBackPath, onChanged,
}) => {
  const toast = useToast();
  const selectId = useId();
  const [savedPlace, setPlace] = useSessionState<string>('housing.dormitory.place', ALL, { parse: parseString });
  const [mode, setMode] = useSessionState<ResidentsMode>('housing.dormitory.mode', 'current', { parse: parseMode });
  const archive = mode === 'archive';
  const [year, monthNumber] = month.split('-').map(Number);
  const monthLabel = getMonthLabel(year, monthNumber);
  const [directoryOpen, setDirectoryOpen] = useState(false);
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
  /** «Архив»: выехавшие в выбранном месяце (не позже сегодня). */
  const archived = useMemo(() => all.filter(resident => closedInMonth(resident, month, today)), [all, month, today]);

  /**
   * Общежития с числом живших в месяце — по написанию первой записи, без учёта регистра. Каждая запись — один раз:
   * закончившаяся в выбранном месяце есть и в нём, и в «Архиве».
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

  // Сохранённое общежитие, которого больше нет в списке (переименовали, нет записей в охвате), — «Все общежития».
  const place = savedPlace === ALL || !query.data || places.some(item => item.label === savedPlace) ? savedPlace : ALL;
  const source = archive ? archived : current;
  const rows = useMemo(
    () => (query.data ? (place === ALL ? source : source.filter(resident => sameAddress(resident.address, place))) : undefined),
    [query.data, place, source],
  );
  const withPlace = place === ALL;
  const title = place === ALL ? 'Общежития' : place;
  const columns = useMemo(() => (archive ? DORMITORY_ARCHIVE_COLUMNS : dormitoryResidentColumns(withPlace)), [archive, withPlace]);
  const toggleMode = (next: ResidentsMode) => setMode(prev => (prev === next ? 'current' : next));

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
      {mode !== 'penalties' && (
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
      )}
      <button type="button" className={styles.toggle} aria-pressed={archive} onClick={() => toggleMode('archive')}>
        Архив
      </button>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={mode === 'penalties'}
        onClick={() => toggleMode('penalties')}
      >
        История взысканий
      </button>
      <button type="button" className={styles.toggle} onClick={() => setDirectoryOpen(true)}>
        Справочник
      </button>
    </div>
  );

  return (
    <>
      {mode === 'penalties' ? (
        <DormitoryPenaltiesPanel canEdit={canEdit} cardBackPath={cardBackPath} searchAside={aside} />
      ) : (
        <RegistryPanel
          // Другие столбцы — заново; сортировка, фильтры и поиск — из sessionStorage (viewKey), не сбрасываются.
          key={archive ? 'archive' : `current-${withPlace ? 'all' : 'one'}`}
          columnWidthsKey={archive ? 'housing.dormitory-history' : 'housing.dormitory'}
          viewKey={archive ? 'housing.dormitory.archive' : 'housing.dormitory'}
          emptyFilterFirst
          isDismissed={isDismissedStay}
          cellRenderers={cardCell}
          label={archive ? `${title} — архив, ${monthLabel}` : title}
          columns={columns}
          rows={rows}
          isLoading={query.isLoading}
          isError={query.isError}
          onRetry={() => { void query.refetch(); }}
          rowKey={residentKey}
          rowLabel={residentName}
          searchText={residentName}
          fioSearch
          {...(archive ? { initialView: BY_CHECK_OUT } : {})}
          searchAside={aside}
          buildExport={archive ? buildDormitoryArchiveExport(title, monthLabel) : buildDormitoryResidentsExport(title, withPlace)}
          sendExport={dormitoryService.exportTable}
          onAdd={canEdit && !archive ? () => setEditor({ mode: 'add' }) : undefined}
          addLabel="Заселить"
          onEdit={canEdit && !archive ? resident => setEditor({ mode: 'edit', stay: resident }) : undefined}
          // Клик по строке — то же окно, что ✎ (26.11.2026, как «Компенсация аренды»).
          onRowClick={canEdit && !archive ? resident => setEditor({ mode: 'edit', stay: resident }) : undefined}
          onDelete={canEdit && !archive ? resident => { void remove(resident); } : undefined}
          busyKey={busyId}
          rowTone={resident => dismissedTone(resident, today)}
        />
      )}

      {editor?.mode === 'add' && (
        <DormitoryStayModal
          addresses={addresses}
          {...(place === ALL ? {} : { initialAddress: place })}
          fixedKind="dormitory"
          withComment
          penaltyCheck
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
      {directoryOpen && (
        <DormitoriesModal canEdit={canEdit} onClose={() => setDirectoryOpen(false)} onChanged={onChanged} />
      )}
    </>
  );
};
