import { type FC, type MouseEvent as ReactMouseEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, History } from 'lucide-react';
import {
  leaveRequestService,
  formatCorrectionHours,
  HISTORY_ACTION_LABELS,
  REQUEST_TYPE_LABELS,
  type ILeaveRequestHistoryEntry,
} from '../../services/leaveRequestService';
import { formatFioShort } from '../../utils/formatFio';
import styles from './LeaveRequestHistory.module.css';

interface ILeaveRequestHistoryProps {
  requestId: number;
}

const formatMoment = (iso: string): string =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

const readHours = (value: Record<string, unknown> | null): string | null => {
  const raw = value?.hours;
  if (raw == null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  return `${formatCorrectionHours(raw)}ч`;
};

const readType = (value: Record<string, unknown> | null): string | null => {
  const raw = value?.request_type;
  if (typeof raw !== 'string') return null;
  return REQUEST_TYPE_LABELS[raw] ?? raw;
};

/** «Было → стало» строкой; null, если у действия нет измеримого значения. */
const formatChange = (entry: ILeaveRequestHistoryEntry): string | null => {
  if (entry.action === 'hours_changed') {
    const from = readHours(entry.old_value);
    const to = readHours(entry.new_value);
    return to ? `${from ?? '—'} → ${to}` : null;
  }
  if (entry.action === 'type_changed') {
    const from = readType(entry.old_value);
    const to = readType(entry.new_value);
    return to ? `${from ?? '—'} → ${to}` : null;
  }
  return null;
};

/**
 * История изменений заявления: кто, когда и что менял. Свёрнута по умолчанию —
 * запрос уходит только при раскрытии, иначе список заявлений дёргал бы эндпоинт
 * на каждую карточку.
 */
export const LeaveRequestHistory: FC<ILeaveRequestHistoryProps> = ({ requestId }) => {
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['leave-request-history', requestId],
    queryFn: () => leaveRequestService.getHistory(requestId),
    enabled: expanded,
    staleTime: 30_000,
  });

  const toggle = (e: ReactMouseEvent) => {
    // Карточка корректировки кликабельна (открывает панель СКУД) — не пробрасываем.
    e.stopPropagation();
    setExpanded(prev => !prev);
  };

  return (
    <div className={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={styles.toggle} onClick={toggle} aria-expanded={expanded}>
        <History size={13} />
        <span>История</span>
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {expanded && (
        <div className={styles.list}>
          {isLoading && <div className={styles.empty}>Загрузка…</div>}
          {isError && <div className={styles.empty}>Не удалось загрузить историю</div>}
          {!isLoading && !isError && (data?.length ?? 0) === 0 && (
            <div className={styles.empty}>Записей нет</div>
          )}
          {data?.map(entry => {
            const change = formatChange(entry);
            return (
              <div key={entry.id} className={styles.item}>
                <div className={styles.head}>
                  <span className={styles.action}>{HISTORY_ACTION_LABELS[entry.action] ?? entry.action}</span>
                  {change && <span className={styles.change}>{change}</span>}
                </div>
                <div className={styles.meta}>
                  {formatMoment(entry.created_at)}
                  {entry.actor_name ? ` · ${formatFioShort(entry.actor_name)}` : ''}
                </div>
                {entry.comment && <div className={styles.comment}>{entry.comment}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
