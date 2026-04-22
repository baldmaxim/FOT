import type { SkudEvent } from '../types';

export type DisplayItem =
  | { kind: 'event'; event: SkudEvent; pairDurationSeconds: number | null; isInternal: boolean }
  | { kind: 'break'; breakSeconds: number };

export const timeToSeconds = (time: string): number => {
  const [h, m, s = 0] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

export const toLocalISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const isToday = (dateStr: string): boolean => dateStr === toLocalISO(new Date());

export const nowSeconds = (): number => {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
};

const isInternalEvent = (event: SkudEvent, internalPoints: Set<string>): boolean =>
  !!event.access_point && internalPoints.has(event.access_point);

/**
 * Строит список отображаемых элементов: события + строки «Перерыв» между внешними парами.
 * Внутренние проходы показываются (isInternal=true), но не участвуют в парном расчёте.
 */
export const buildDisplayItems = (
  events: SkudEvent[],
  internalPoints: Set<string>,
  dateStr?: string,
): DisplayItem[] => {
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time));
  const items: DisplayItem[] = [];
  let pendingEntry: SkudEvent | null = null;
  let lastExitTimeSec: number | null = null;

  for (const ev of sorted) {
    const internal = isInternalEvent(ev, internalPoints);

    if (ev.direction === 'entry') {
      if (!internal && lastExitTimeSec !== null) {
        const gap = timeToSeconds(ev.event_time) - lastExitTimeSec;
        if (gap > 0) items.push({ kind: 'break', breakSeconds: gap });
        lastExitTimeSec = null;
      }
      items.push({ kind: 'event', event: ev, pairDurationSeconds: null, isInternal: internal });
      if (!internal && pendingEntry === null) {
        pendingEntry = ev;
      }
    } else {
      let pairDuration: number | null = null;
      if (!internal && pendingEntry) {
        pairDuration = timeToSeconds(ev.event_time) - timeToSeconds(pendingEntry.event_time);
        pendingEntry = null;
        lastExitTimeSec = timeToSeconds(ev.event_time);
      }
      items.push({ kind: 'event', event: ev, pairDurationSeconds: pairDuration, isInternal: internal });
    }
  }

  if (pendingEntry && dateStr && isToday(dateStr)) {
    const lastItem = items[items.length - 1];
    if (lastItem && lastItem.kind === 'event' && lastItem.event.id === pendingEntry.id) {
      lastItem.pairDurationSeconds = nowSeconds() - timeToSeconds(pendingEntry.event_time);
    }
  }

  return items;
};

/** Рабочее время в секундах: сумма внешних пар вход→выход; для «сегодня» — до now, если открыт. */
export const calculateWorkSeconds = (
  events: SkudEvent[],
  internalPoints: Set<string>,
  dateStr?: string,
): number => {
  const filtered = events.filter(e => !isInternalEvent(e, internalPoints));
  const sorted = [...filtered].sort((a, b) => a.event_time.localeCompare(b.event_time));
  let total = 0;
  let entryTime: number | null = null;

  for (const ev of sorted) {
    if (ev.direction === 'entry') {
      if (entryTime === null) entryTime = timeToSeconds(ev.event_time);
    } else if (ev.direction === 'exit' && entryTime !== null) {
      total += timeToSeconds(ev.event_time) - entryTime;
      entryTime = null;
    }
  }

  if (entryTime !== null && dateStr && isToday(dateStr)) {
    total += nowSeconds() - entryTime;
  }

  return total;
};

/** Первый внешний entry за день. */
export const findFirstExternalEntry = (events: SkudEvent[], internalPoints: Set<string>): SkudEvent | null => {
  for (const ev of events) {
    if (ev.direction === 'entry' && !isInternalEvent(ev, internalPoints)) return ev;
  }
  return null;
};

/** Последний внешний exit за день. */
export const findLastExternalExit = (events: SkudEvent[], internalPoints: Set<string>): SkudEvent | null => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.direction === 'exit' && !isInternalEvent(ev, internalPoints)) return ev;
  }
  return null;
};

/** Суммарная длительность строк «Перерыв» в списке items. */
export const sumBreakSeconds = (items: DisplayItem[]): number =>
  items.reduce((sum, item) => (item.kind === 'break' ? sum + item.breakSeconds : sum), 0);
