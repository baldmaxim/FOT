import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';

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
  compensationTotals,
  dismissedTone,
} from '../../../utils/housingTables';
import { moscowTodayIso, shiftMonth } from '../../../utils/moscowDate';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { DormitoryStayModal } from './DormitoryStayModal';
import styles from './DormitoryTab.module.css';

interface ICompensationPanelProps {
  canEdit: boolean;
  onChanged: () => void;
}

type Editor = { mode: 'add' } | { mode: 'edit'; stay: ICompensationMonthRow } | null;

const rowKey = (row: ICompensationMonthRow): number => row.id;
const rowName = (row: ICompensationMonthRow): string => row.full_name;

/**
 * Вкладка «Компенсация аренды» (миграция 371) — как документ 1С «Список сотрудников для получения возмещения за
 * проживание»: месяц ← → (по умолчанию прошлый — полный), №, Сотрудник, Должность, Подразделение, Начало компенсации,
 * Обновлено, Кол-во выходных, Кол-во дней (табель), Сумма к оплате, Комментарий, Гражданство; «Итого». Дни и сумма —
 * из того же расчёта, что «Зарплата» (630 ₽/день); уволенные месяца — подсвечены. С правом правки — «Добавить
 * сотрудника», ✎ (даты, комментарий), 🗑 — ошибочная запись.
 */
export const CompensationPanel: FC<ICompensationPanelProps> = ({ canEdit, onChanged }) => {
  const toast = useToast();
  const currentMonth = moscowTodayIso().slice(0, 7);
  const [month, setMonth] = useState(() => shiftMonth(currentMonth, -1));
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

  const aside = () => (
    <div className={styles.monthNav}>
      <button
        type="button"
        className={styles.monthButton}
        onClick={() => setMonth(value => shiftMonth(value, -1))}
        aria-label="Предыдущий месяц"
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <span className={styles.monthLabel}>{monthLabel}</span>
      <button
        type="button"
        className={styles.monthButton}
        onClick={() => setMonth(value => shiftMonth(value, 1))}
        disabled={month >= currentMonth}
        aria-label="Следующий месяц"
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );

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
        searchAside={aside}
        totals={compensationTotals}
        buildExport={buildCompensationExport(monthLabel)}
        sendExport={dormitoryService.exportTable}
        onAdd={canEdit ? () => setEditor({ mode: 'add' }) : undefined}
        onEdit={canEdit ? row => setEditor({ mode: 'edit', stay: row }) : undefined}
        onDelete={canEdit ? row => { void remove(row); } : undefined}
        busyKey={busyId}
        rowTone={row => dismissedTone(row, today)}
      />

      {editor && (
        <DormitoryStayModal
          stay={editor.mode === 'edit' ? editor.stay : undefined}
          addresses={[]}
          fixedKind="apartment"
          withComment
          onClose={() => setEditor(null)}
          onSaved={onChanged}
        />
      )}
    </>
  );
};
