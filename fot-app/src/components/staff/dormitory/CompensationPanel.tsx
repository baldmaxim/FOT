import { useMemo, useState, type FC, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useSessionState } from '../../../hooks/useSessionState';
import {
  DORMITORY_ALL_STAYS_KEY,
  DORMITORY_COMPENSATION_KEY,
  dormitoryService,
  type ICompensationMonthRow,
} from '../../../services/dormitoryService';
import { getMonthLabel } from '../../../utils/calendarUtils';
import { formatDate } from '../../../utils/formatMoney';
import {
  buildCompensationArchiveExport,
  buildCompensationExport,
  COMPENSATION_ARCHIVE_COLUMNS,
  COMPENSATION_COLUMNS,
  compensationArchiveRows,
  compensationTone,
  compensationTotals,
  dismissedTone,
  isDismissedStay,
  pausedFromOf,
  type ICompensationArchiveRow,
} from '../../../utils/housingTables';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { parseOneOf } from '../../../utils/sessionState';
import type { ITableView } from '../../../utils/tableView';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { CompensationFilesModal } from './CompensationFilesModal';
import { CompensationPauseModal, type CompensationPauseAction } from './CompensationPauseModal';
import styles from './DormitoryTab.module.css';
import { DormitoryStayModal } from './DormitoryStayModal';
import { useEmployeeCardCell } from './useEmployeeCardCell';

interface ICompensationPanelProps {
  canEdit: boolean;
  /** Выбранный месяц (YYYY-MM) — общий выбор вкладок «Проживания». */
  month: string;
  /** Возврат из карточки сотрудника — сюда (вкладка и месяц). */
  cardBackPath: string;
  onChanged: () => void;
}

type Editor =
  | { mode: 'add' }
  | { mode: 'edit'; stay: ICompensationMonthRow }
  | { mode: 'pause'; stay: ICompensationMonthRow; action: CompensationPauseAction }
  | { mode: 'files'; stay: ICompensationMonthRow }
  | null;

/**
 * Что можно сделать с паузой строки (миграция 374): приостановленную без возобновления — возобновить или завершить,
 * действующую — приостановить; возобновлённую позже месяца — ничего.
 */
const pauseActionOf = (row: ICompensationMonthRow): CompensationPauseAction | null => {
  if (row.suspended === undefined) return null;
  if (row.suspended) return row.resumed_from ? null : 'resume';
  return 'suspend';
};

const PAUSE_LABELS: Record<CompensationPauseAction, string> = {
  suspend: 'Приостановить компенсацию…',
  resume: 'Возобновить или завершить компенсацию…',
};

const rowKey = (row: ICompensationMonthRow): number => row.id;
const rowName = (row: ICompensationMonthRow): string => row.full_name;
const archiveKey = (row: ICompensationArchiveRow): number => row.id;
const archiveName = (row: ICompensationArchiveRow): string => row.full_name;
const BY_END: ITableView = { sort: 'check_out', dir: 'desc', filters: {} };

type CompensationMode = 'list' | 'archive';
const parseMode = parseOneOf<CompensationMode>(['list', 'archive']);

/**
 * Вкладка «Компенсация аренды» (миграции 371, 374, 380) — как документ 1С «Список сотрудников для получения возмещения
 * за проживание» за выбранный месяц: №, Сотрудник (ссылка на карточку), Должность, Подразделение (на конец месяца),
 * Начало компенсации, Приостановлена, Обновление документов, Кол-во выходных, Кол-во дней (табель), Сумма к оплате,
 * Комментарий, Гражданство, Файлы; «Итого»; ширина столбцов — как в Excel. Дни и сумма — из того же расчёта, что
 * «Зарплата» (630 ₽/день); уволенные подсвечены (галочка «Уволенные» скрывает), в бригаде — жёлтым. С правом правки —
 * «Добавить сотрудника», клик по строке и ✎ (даты, «Обновление документов», комментарий, файлы, «Приостановить…» /
 * «Возобновить…»), галочка «Приостановлена», 🗑 — ошибочная запись (с днями в закрытых месяцах сервер не удалит).
 * 📎N — файлы сотрудника на просмотр. «Архив» (24.11.2026) — компенсации, закончившиеся в выбранном месяце (без
 * приостановленных), только просмотр.
 */
export const CompensationPanel: FC<ICompensationPanelProps> = ({ canEdit, month, cardBackPath, onChanged }) => {
  const toast = useToast();
  const cardCell = useEmployeeCardCell<ICompensationMonthRow>(cardBackPath);
  const [editor, setEditor] = useState<Editor>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [year, monthNumber] = month.split('-').map(Number);
  const monthLabel = getMonthLabel(year, monthNumber);
  const today = moscowTodayIso();

  const [mode, setMode] = useSessionState<CompensationMode>('housing.compensation.mode', 'list', { parse: parseMode });
  const archive = mode === 'archive';

  const query = useQuery({
    queryKey: [...DORMITORY_COMPENSATION_KEY, month],
    queryFn: ({ signal }) => dormitoryService.listCompensation(month, signal),
    staleTime: 0,
    enabled: !archive,
  });
  const archiveQuery = useQuery({
    queryKey: DORMITORY_ALL_STAYS_KEY,
    queryFn: ({ signal }) => dormitoryService.list(signal),
    staleTime: 0,
    enabled: archive,
  });
  const archiveRows = useMemo(
    () => (archiveQuery.data ? compensationArchiveRows(archiveQuery.data, month, today) : undefined),
    [archiveQuery.data, month, today],
  );
  const archiveCardCell = useEmployeeCardCell<ICompensationArchiveRow>(cardBackPath);

  // Галочка «Приостановлена» (26.11.2026): поставить — окно «Приостановить» с датой, снять — «Возобновить»; без права
  // правки или без действия (возобновлена позже месяца) — только показывает. Клик по ней строку не открывает.
  const pausedCell = (row: ICompensationMonthRow): ReactNode => {
    const action = pauseActionOf(row);
    const checked = row.suspended ?? row.paused_from != null;
    const date = pausedFromOf(row);
    return (
      <label
        className={styles.pauseCheck}
        onClick={event => event.stopPropagation()}
        title={checked ? 'Снять — возобновить компенсацию' : 'Поставить — приостановить компенсацию'}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!canEdit || action === null || busyId !== null}
          onChange={() => { if (action) setEditor({ mode: 'pause', stay: row, action }); }}
          aria-label={`${checked ? 'Возобновить' : 'Приостановить'} компенсацию: ${row.full_name}`}
        />
        {date && <span>{formatDate(date)}</span>}
      </label>
    );
  };

  // 📎N — файлы компенсации сотрудника (миграция 380): просмотр и скачивание; нет файлов — «—» столбца.
  const filesCell = (row: ICompensationMonthRow): ReactNode | undefined => (row.files_count ? (
    <button
      type="button"
      className={styles.filesButton}
      onClick={event => { event.stopPropagation(); setEditor({ mode: 'files', stay: row }); }}
      title="Файлы"
      aria-label={`Файлы: ${row.full_name}, ${row.files_count}`}
    >
      <Paperclip size={14} aria-hidden="true" />
      {row.files_count}
    </button>
  ) : undefined);

  const listCells = { ...cardCell, paused_from: pausedCell, files: filesCell };

  const remove = async (row: ICompensationMonthRow) => {
    if (busyId !== null) return;
    if (!window.confirm(`Удалить компенсацию: ${row.full_name}, с ${formatDate(row.check_in)}? Окончание ставят в ✎.`)) return;
    setBusyId(row.id);
    try {
      await dormitoryService.remove(row.id);
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

  if (archive) {
    return (
      <RegistryPanel
        key="archive"
        label={`Компенсация аренды — архив, ${monthLabel}`}
        columns={COMPENSATION_ARCHIVE_COLUMNS}
        rows={archiveRows}
        isLoading={archiveQuery.isLoading}
        isError={archiveQuery.isError}
        onRetry={() => { void archiveQuery.refetch(); }}
        rowKey={archiveKey}
        rowLabel={archiveName}
        searchText={archiveName}
        fioSearch
        initialView={BY_END}
        searchAside={aside}
        columnWidthsKey="housing.compensation-archive"
        viewKey="housing.compensation.archive"
        emptyFilterFirst
        isDismissed={isDismissedStay}
        cellRenderers={archiveCardCell}
        buildExport={buildCompensationArchiveExport(monthLabel)}
        sendExport={dormitoryService.exportTable}
        rowTone={row => dismissedTone(row, today)}
      />
    );
  }

  return (
    <>
      <RegistryPanel
        key="list"
        label={`Компенсация аренды — ${monthLabel}`}
        columns={COMPENSATION_COLUMNS}
        rows={query.data}
        isLoading={query.isLoading}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        columnWidthsKey="housing.compensation"
        viewKey="housing.compensation"
        emptyFilterFirst
        searchAside={aside}
        isDismissed={isDismissedStay}
        cellRenderers={listCells}
        totals={compensationTotals}
        buildExport={buildCompensationExport(monthLabel)}
        sendExport={dormitoryService.exportTable}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', stay: row }) : undefined}
        // Клик по строке — то же окно, что ✎ (26.11.2026).
        onRowClick={canEdit ? row => setEditor({ mode: 'edit', stay: row }) : undefined}
        onDelete={canEdit ? row => { void remove(row); } : undefined}
        busyKey={busyId}
        rowTone={row => compensationTone(row, today)}
      />

      {(editor?.mode === 'add' || editor?.mode === 'edit') && (
        <DormitoryStayModal
          stay={editor.mode === 'edit' ? editor.stay : undefined}
          addresses={[]}
          fixedKind="apartment"
          withComment
          compensation
          {...(editor.mode === 'edit' && pauseActionOf(editor.stay) ? {
            extraAction: {
              label: PAUSE_LABELS[pauseActionOf(editor.stay)!],
              onClick: () => setEditor({ mode: 'pause', stay: editor.stay, action: pauseActionOf(editor.stay)! }),
            },
          } : {})}
          onClose={() => setEditor(prev => (prev?.mode === 'pause' ? prev : null))}
          onSaved={(_stay, resumed) => {
            onChanged();
            if (resumed) toast.success(`Документы обновлены — компенсация возобновлена с ${formatDate(resumed.check_in)}`);
          }}
        />
      )}
      {editor?.mode === 'files' && (
        <CompensationFilesModal
          employeeId={editor.stay.employee_id}
          fullName={editor.stay.full_name}
          onClose={() => setEditor(null)}
        />
      )}
      {editor?.mode === 'pause' && (
        <CompensationPauseModal
          row={editor.stay}
          action={editor.action}
          today={today}
          onClose={() => setEditor(null)}
          onSaved={onChanged}
        />
      )}
    </>
  );
};
