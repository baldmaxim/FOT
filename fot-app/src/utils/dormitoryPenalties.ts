import type {
  IDormitoryCandidate,
  IDormitoryPenaltyRow,
  IPenaltyMatchItem,
  PenaltyLevel,
} from '../services/dormitoryService';
import { formatDate } from './formatMoney';
import { moscowTodayIso } from './moscowDate';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * «Проживание» → «Общежитие» → «История взысканий» (миграция 378): столбцы таблицы и xlsx, подписи предупреждения
 * окна «Заселить», проверка формы записи.
 */

/** Как CHECK dormitory_penalty_note_length (миграция 378). */
export const PENALTY_NOTE_MAX_LENGTH = 1000;

export const PENALTY_SOURCE_LABELS: Readonly<Record<IDormitoryPenaltyRow['source'], string>> = {
  list: 'Список',
  blacklist: 'Чёрный список (пропуска)',
};

/** Заголовок блока в «Заселить»: «Есть» — заселять не нужно; «Проверьте» — взыскание у человека с тем же ФИО. */
export const PENALTY_WARNING_TITLES: Readonly<Record<PenaltyLevel, string>> = {
  yes: '⚠ Есть взыскания — заселять не нужно',
  check: '⚠ Проверьте: взыскание у сотрудника с тем же ФИО',
};

/** Пометка под ФИО в подсказке поиска «Заселить»; нет взысканий — null. */
export const penaltyCandidateNote = (candidate: IDormitoryCandidate): string | null => {
  if (candidate.penalty === 'yes') return '⚠ Есть взыскания';
  if (candidate.penalty === 'check') return '⚠ Проверьте взыскания: совпадает ФИО';
  return null;
};

/** Строка списка взысканий в «Заселить»: «05.10.2026 · Список · Драка»; у «Проверьте» — и чьё ФИО. */
export const penaltyItemText = (item: IPenaltyMatchItem): string => [
  item.penalty_date ? formatDate(item.penalty_date) : null,
  PENALTY_SOURCE_LABELS[item.source],
  item.note,
  item.level === 'check' ? item.full_name : null,
].filter(Boolean).join(' · ');

/** Уволен ли сотрудник строки (подсветка и галочка «Уволенные»). */
export const isDismissedPenaltyRow = (row: IDormitoryPenaltyRow): boolean => (
  row.employment_status === 'fired' || row.employment_status === 'dismissed'
  || (row.dismissal_date !== null && row.dismissal_date <= moscowTodayIso())
);

const orDash = (value: string | null): string => (value ? value : '—');

export const PENALTY_COLUMNS: ReadonlyArray<IRegistryColumn<IDormitoryPenaltyRow>> = [
  {
    key: 'full_name',
    label: 'Сотрудник',
    type: 'text',
    text: row => row.full_name,
    sortValue: row => row.full_name,
  },
  {
    key: 'department',
    label: 'Подразделение',
    type: 'text',
    width: 180,
    text: row => orDash(row.department),
    sortValue: row => row.department,
  },
  {
    key: 'penalty_date',
    label: 'Дата',
    type: 'text',
    width: 112,
    nowrap: true,
    text: row => (row.penalty_date ? formatDate(row.penalty_date) : '—'),
    sortValue: row => row.penalty_date,
  },
  {
    key: 'note',
    label: 'Информация',
    type: 'text',
    width: 280,
    text: row => row.note ?? '',
    sortValue: row => row.note,
  },
  {
    key: 'source',
    label: 'Источник',
    type: 'text',
    width: 160,
    text: row => PENALTY_SOURCE_LABELS[row.source],
    sortValue: row => PENALTY_SOURCE_LABELS[row.source],
  },
];

export const buildPenaltiesExport = (rows: ReadonlyArray<IDormitoryPenaltyRow>): ITableExportSnapshot => {
  const isoDate = moscowTodayIso();
  return buildExportTable({
    title: 'История взысканий',
    subtitle: `Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
    fileName: `История взысканий_${isoDate}.xlsx`,
    columns: PENALTY_COLUMNS,
    rows,
    isMuted: isDismissedPenaltyRow,
  });
};

export type PenaltyFormField = 'employee' | 'penalty_date' | 'note';

/** Форма записи: сотрудник (при добавлении), дата не позже сегодня, дата или информация — хотя бы одно. */
export const parsePenaltyForm = (
  form: { employeeSelected: boolean; penaltyDate: string; note: string },
  today: string,
): { ok: true; payload: { penalty_date: string | null; note: string | null } } | { ok: false; field: PenaltyFormField; message: string } => {
  if (!form.employeeSelected) return { ok: false, field: 'employee', message: 'Выберите сотрудника' };
  const penaltyDate = form.penaltyDate.trim() || null;
  const note = form.note.replace(/\s+/g, ' ').trim() || null;
  if (penaltyDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(penaltyDate)) {
    return { ok: false, field: 'penalty_date', message: 'Дата — ДД.ММ.ГГГГ' };
  }
  if (penaltyDate !== null && penaltyDate > today) {
    return { ok: false, field: 'penalty_date', message: 'Дата взыскания — не позже сегодня' };
  }
  if (note !== null && note.length > PENALTY_NOTE_MAX_LENGTH) {
    return { ok: false, field: 'note', message: `Информация — не длиннее ${PENALTY_NOTE_MAX_LENGTH} знаков` };
  }
  if (penaltyDate === null && note === null) return { ok: false, field: 'note', message: 'Укажите дату или информацию' };
  return { ok: true, payload: { penalty_date: penaltyDate, note } };
};
