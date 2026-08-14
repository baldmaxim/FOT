import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  contractorAdminService,
  type IContractorPassEvent,
  type IMonitorPassRow,
  type IPassEventsResponse,
} from '../../services/contractorService';
import type { SkudEvent } from '../../types/skud';
import {
  buildDisplayItems,
  calculateWorkSeconds,
  findUnclosedEntryId,
  type DisplayItem,
} from '../../utils/skudDisplay';
import styles from '../../pages/contractor/Contractor.module.css';

interface IPassEventsModalProps {
  pass: IMonitorPassRow;
  onClose: () => void;
}

/** YYYY-MM-DD → ДД.ММ.ГГГГ. */
const formatIsoDate = (iso: string): string => iso.split('-').reverse().join('.');

/**
 * Момент выдачи в МСК. Именно Intl с явным timeZone, а не toLocaleString('ru'):
 * события нормализованы в московское время, и подпись про дату выдачи не должна
 * разъезжаться с данными у пользователя в другом часовом поясе.
 */
const moscowDateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const formatMoscowDateTime = (iso: string): string => moscowDateTimeFormat.format(new Date(iso));

/** Ч:ММ из секунд. */
const formatDuration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
};

/** HH:MM из HH:MM:SS. */
const formatTime = (time: string): string => time.slice(0, 5);

const REASON_TEXT: Record<string, string> = {
  no_holder: 'Пропуск свободен — держателя нет, показывать нечего.',
  holder_not_approved: 'Заявка на этого держателя ещё не одобрена — выдачи не было.',
  no_employee: 'Профиль Sigur не сопоставлен с сотрудником — проходы подтянуть не по чему.',
};

interface IDayGroup {
  date: string;
  items: DisplayItem[];
  workSeconds: number;
  unclosedEntryId: number | null;
}

/**
 * Утилиты skudDisplay типизированы под общий SkudEvent, где card_number и
 * physical_person не nullable. Адаптируем, не трогая общий тип: он используется
 * всеми СКУД-экранами.
 */
const toSkudEvents = (events: IContractorPassEvent[]): SkudEvent[] =>
  events.map(e => ({
    ...e,
    physical_person: e.physical_person ?? '',
    card_number: e.card_number ?? '',
  }));

/**
 * Группировка по дням (свежие сверху). Третий аргумент dateStr в утилиты НЕ
 * передаём: он включает ветку nowSeconds(), которая берёт «сейчас» из часового
 * пояса браузера, тогда как события в МСК. Поэтому итог дня — только по закрытым
 * парам, а незакрытый вход показывается отдельной пометкой (см. findUnclosedEntryId).
 */
const groupByDay = (events: IContractorPassEvent[], internalPoints: Set<string>): IDayGroup[] => {
  const byDate = new Map<string, SkudEvent[]>();
  for (const ev of toSkudEvents(events)) {
    const list = byDate.get(ev.event_date);
    if (list) list.push(ev);
    else byDate.set(ev.event_date, [ev]);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, dayEvents]) => ({
      date,
      items: buildDisplayItems(dayEvents, internalPoints),
      workSeconds: calculateWorkSeconds(dayEvents, internalPoints),
      unclosedEntryId: findUnclosedEntryId(dayEvents, internalPoints),
    }));
};

/**
 * Проходы СКУД текущего держателя пропуска подрядчика.
 * Период необязателен: пустые поля означают «последние 14 дней», их считает сервер
 * по Москве. Нижняя граница обрезается датой фактической выдачи (approved_at),
 * поэтому проходы предыдущего держателя слота сюда не попадают.
 */
export const PassEventsModal: FC<IPassEventsModalProps> = ({ pass, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const query = useQuery<IPassEventsResponse>({
    queryKey: ['contractor-pass-events', pass.id, dateFrom, dateTo],
    queryFn: () => contractorAdminService.getPassEvents(
      pass.id,
      dateFrom || undefined,
      dateTo || undefined,
    ),
    staleTime: 30_000,
  });

  const data = query.data;
  const internalPoints = useMemo(
    () => new Set(data?.internal_points ?? []),
    [data?.internal_points],
  );
  const days = useMemo(
    () => (data ? groupByDay(data.events, internalPoints) : []),
    [data, internalPoints],
  );

  const renderBody = () => {
    if (query.isLoading) return <div className={styles.empty}>Загрузка…</div>;
    if (query.isError) {
      return (
        <div className={styles.empty}>
          <div>Не удалось загрузить проходы</div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void query.refetch()}
          >
            Повторить
          </button>
        </div>
      );
    }
    if (!data) return <div className={styles.empty}>Нет данных</div>;
    if (data.reason) return <div className={styles.empty}>{REASON_TEXT[data.reason]}</div>;
    if (days.length === 0) return <div className={styles.empty}>Проходов за период нет</div>;

    return days.map(day => (
      <div key={day.date}>
        <div className={styles.eventsDay}>
          <span className={styles.eventsDayDate}>{formatIsoDate(day.date)}</span>
          {/* При truncated итог считать нельзя: день мог обрезаться посередине. */}
          {!data.truncated && (
            <span className={styles.eventsDayHours}>
              Отработано (по закрытым парам): {formatDuration(day.workSeconds)}
            </span>
          )}
        </div>
        <div className={styles.eventsScroll}>
          <table className={styles.table}>
            <thead>
              <tr><th>Время</th><th>Событие</th><th>Точка доступа</th><th>Длительность</th></tr>
            </thead>
            <tbody>
              {day.items.map((item, idx) => {
                if (item.kind === 'break') {
                  return (
                    <tr key={`break-${idx}`}>
                      <td className={styles.eventsMuted}>—</td>
                      <td className={styles.eventsMuted}>Перерыв</td>
                      <td className={styles.eventsMuted}>—</td>
                      <td className={styles.eventsMuted}>{formatDuration(item.breakSeconds)}</td>
                    </tr>
                  );
                }
                if (item.kind === 'failure') return null;
                const { event, pairDurationSeconds, isInternal } = item;
                const isUnclosed = event.id === day.unclosedEntryId;
                return (
                  <tr key={event.id}>
                    <td>{formatTime(event.event_time)}</td>
                    <td>
                      {event.direction === 'entry' ? 'вход' : 'выход'}
                      {isUnclosed && (
                        <span className={`${styles.badge} ${styles.badgeRemove}`} style={{ marginLeft: 8 }}>
                          вход без выхода
                        </span>
                      )}
                    </td>
                    <td>
                      {event.access_point ?? '—'}
                      {isInternal && <span className={styles.eventsMuted}> (внутренняя)</span>}
                    </td>
                    <td>{pairDurationSeconds === null ? '—' : formatDuration(pairDurationSeconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    ));
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={overlay.onMouseDown}
      onMouseUp={overlay.onMouseUp}
      onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart}
      onTouchEnd={overlay.onTouchEnd}
    >
      <div className={`${styles.modal} ${styles.modalScroll}`} style={{ maxWidth: 720 }}>
        <h2 className={styles.modalTitle}>
          Проходы — пропуск № {pass.pass_number}
          {pass.holder_name ? `, ${pass.holder_name}` : ''}
        </h2>

        <div className={styles.filterRow}>
          <div className={styles.field}>
            <span className={styles.label}>С</span>
            <input
              className={styles.input}
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>По</span>
            <input
              className={styles.input}
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.modalScrollArea}>
          {data && !data.reason && (
            <>
              <div className={styles.eventsNote}>
                Период: {formatIsoDate(data.date_from)} — {formatIsoDate(data.date_to)}.
                {' '}Пустые поля — последние 14 дней.
              </div>
              {data.clipped && data.effective_start_at && (
                <div className={styles.eventsNote}>
                  Показаны проходы с {formatMoscowDateTime(data.effective_start_at)} (МСК) —
                  {' '}пропуск выдан текущему держателю с этого момента.
                </div>
              )}
              {data.truncated && (
                <div className={`${styles.eventsNote} ${styles.eventsNoteWarn}`}>
                  Показаны не все события — сузьте период. Часы за день скрыты,
                  чтобы не показать неверный итог.
                </div>
              )}
            </>
          )}
          {renderBody()}
        </div>

        <div className={styles.modalActions}>
          <button className="btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
};

export default PassEventsModal;
