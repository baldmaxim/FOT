import type { SkudEvent, SkudEventFailure } from '../types';

export type DisplayItem =
  | { kind: 'event'; event: SkudEvent; pairDurationSeconds: number | null; isInternal: boolean }
  | { kind: 'break'; breakSeconds: number }
  | { kind: 'failure'; failure: SkudEventFailure };

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

/**
 * Вставляет ошибочные события Sigur в список display-элементов на правильное
 * место по `event_time`. Не группирует с PASS_DETECTED в пары вход/выход —
 * failures отображаются отдельной строкой с маркером.
 */
export const mergeFailuresIntoDisplay = (
  items: DisplayItem[],
  failures: SkudEventFailure[],
): DisplayItem[] => {
  if (failures.length === 0) return items;
  const failureItems: DisplayItem[] = failures
    .slice()
    .sort((a, b) => a.event_time.localeCompare(b.event_time))
    .map(f => ({ kind: 'failure', failure: f }));

  const getItemTime = (item: DisplayItem): number => {
    if (item.kind === 'event') return timeToSeconds(item.event.event_time);
    if (item.kind === 'failure') return timeToSeconds(item.failure.event_time);
    // break-строки наследуют позицию у предшествующего exit — оставляем их где стоят.
    return Number.MAX_SAFE_INTEGER;
  };

  // Простая стабильная сортировка: events/failures по времени, breaks остаются между ними.
  const eventItems = items.filter(i => i.kind !== 'break');
  const breakItems = items.filter(i => i.kind === 'break');
  const merged = [...eventItems, ...failureItems].sort((a, b) => getItemTime(a) - getItemTime(b));
  // breaks были сгенерированы между парами в buildDisplayItems — вернём их обратно
  // на исходные позиции (после соответствующих exit). Берём индексы из исходного items.
  if (breakItems.length === 0) return merged;
  const result: DisplayItem[] = [];
  let breakCursor = 0;
  let originalCursor = 0;
  for (const m of merged) {
    result.push(m);
    // если в исходном списке после текущего event/failure был break — вставляем его
    if (m.kind === 'event') {
      // ищем оригинальную позицию этого event в items
      const origIdx = items.indexOf(m, originalCursor);
      if (origIdx !== -1) {
        originalCursor = origIdx + 1;
        if (items[origIdx + 1]?.kind === 'break' && breakCursor < breakItems.length) {
          result.push(breakItems[breakCursor]);
          breakCursor++;
        }
      }
    }
  }
  // если остались неприкреплённые breaks — добавим в конец, чтобы не потерять
  while (breakCursor < breakItems.length) {
    result.push(breakItems[breakCursor]);
    breakCursor++;
  }
  return result;
};
