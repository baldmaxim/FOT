import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import {
  DORMITORY_COMPENSATION_KEY,
  dormitoryService,
  type ICompensationMonthRow,
} from '../../../services/dormitoryService';
import { getMonthLabel } from '../../../utils/calendarUtils';
import { formatDate } from '../../../utils/formatMoney';
import {
  buildCompensationExport,
  COMPENSATION_COLUMNS,
  compensationTone,
  compensationTotals,
  isDismissedStay,
} from '../../../utils/housingTables';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { CompensationPauseModal, type CompensationPauseAction } from './CompensationPauseModal';
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

/**
 * Вкладка «Компенсация аренды» (миграции 371, 374) — как документ 1С «Список сотрудников для получения возмещения за
 * проживание» за выбранный месяц: №, Сотрудник (ссылка на карточку), Должность, Подразделение (на конец месяца),
 * Начало компенсации, Приостановлена, Возобновлена, Обновлено, Кол-во выходных, Кол-во дней (табель), Сумма к оплате,
 * Комментарий, Гражданство; «Итого»; ширина столбцов — как в Excel. Дни и сумма — из того же расчёта, что «Зарплата»
 * (630 ₽/день); уволенные подсвечены (галочка «Уволенные» скрывает), в бригаде — жёлтым. С правом правки —
 * «Добавить сотрудника», ✎ (даты, комментарий, «Приостановить…» / «Возобновить…»), 🗑 — ошибочная запись.
 */
export const CompensationPanel: FC<ICompensationPanelProps> = ({ canEdit, month, cardBackPath, onChanged }) => {
  const toast = useToast();
  const cardCell = useEmployeeCardCell<ICompensationMonthRow>(cardBackPath);
  const [editor, setEditor] = useState<Editor>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [year, monthNumber] = month.split('-').map(Number);
  const monthLabel = getMonthLabel(year, monthNumber);
  const today = moscowTodayIso();

  const query = useQuery({
    queryKey: [...DORMITORY_COMPENSATION_KEY, month],
    queryFn: ({ signal }) => dormitoryService.listCompensation(month, signal),
    staleTime: 0,
  });

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

  return (
    <>
      <RegistryPanel
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
        isDismissed={isDismissedStay}
        cellRenderers={cardCell}
        totals={compensationTotals}
        buildExport={buildCompensationExport(monthLabel)}
        sendExport={dormitoryService.exportTable}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', stay: row }) : undefined}
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
          {...(editor.mode === 'edit' && pauseActionOf(editor.stay) ? {
            extraAction: {
              label: PAUSE_LABELS[pauseActionOf(editor.stay)!],
              onClick: () => setEditor({ mode: 'pause', stay: editor.stay, action: pauseActionOf(editor.stay)! }),
            },
          } : {})}
          onClose={() => setEditor(prev => (prev?.mode === 'pause' ? prev : null))}
          onSaved={onChanged}
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
