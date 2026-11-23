import { useEffect, useMemo, useState, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';

import type { IColumnResize } from '../components/ui/ColumnResizeHandle';
import { useColumnWidths } from './useColumnWidths';
import {
  clampColumnWidth,
  COLUMN_AUTOFIT_MAX_WIDTH,
  COLUMN_WIDTH_STEP,
  type ColumnWidths,
} from '../utils/columnWidths';

/**
 * Ширина тянется мышью и только на широком экране: на ≤ 768 у таблицы своя раскладка (узкие «№» и ФИО), туда ширины
 * компьютера не переносятся; на сенсоре жест по заголовку прокручивает таблицу.
 */
const RESIZE_QUERY = '(min-width: 769px) and (pointer: fine)';
const NO_WIDTHS: ColumnWidths = {};
/** Таблица не шире блока прокрутки (с запасом на дробные пиксели) — растянута на весь экран. */
const FIT_SLACK = 1;

const useMediaMatch = (query: string): boolean => {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return matches;
};

interface IUseColumnResizeOptions {
  /** Ключ хранилища ширин; нет — ширина не меняется. */
  storageKey: string | undefined;
  /**
   * Ключи столбцов с ручкой (у их <col> — data-col-key с тем же ключом). Таблица — в своём блоке прокрутки (родитель
   * <table>): таблица не шире его — столбцы растянуты на весь экран.
   */
  columnKeys: readonly string[];
  /** Класс скрытой копии таблицы для замера «по тексту»: без fixed-раскладки, текст в строку. */
  measuringClass: string;
  /** Класс контейнера копии: вне экрана, невидимый. */
  measureHostClass: string;
}

export interface IColumnResizeState {
  /** Ширины пользователя по ключу столбца; выключено (узкое окно, сенсор) — пусто. */
  widths: ColumnWidths;
  /** Ширина таблицы — ровно сумма столбцов, без растяжки на 100%: есть хоть одна ширина пользователя. */
  exact: boolean;
  /** Ручка ширины столбца; выключено — нет. */
  resizeOf: (columnKey: string) => IColumnResize | undefined;
}

const colOf = (header: HTMLTableCellElement): HTMLTableColElement | null => (
  header.closest('table')?.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col')[header.cellIndex] ?? null
);

/**
 * Ширина «по тексту»: скрытая копия шапки и отрисованных строк (без строк-распорок виртуализации и «Итого») в
 * авто-раскладке, текст в одну строку; ширина заголовка столбца в ней. Живая таблица и её прокрутка не трогаются.
 */
const measureNaturalWidth = (
  header: HTMLTableCellElement,
  measuringClass: string,
  measureHostClass: string,
): number | null => {
  const table = header.closest('table');
  if (!table?.tHead) return null;
  const host = document.createElement('div');
  host.className = measureHostClass;
  host.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('table');
  copy.className = `${table.className} ${measuringClass}`;
  copy.append(table.tHead.cloneNode(true));
  const body = document.createElement('tbody');
  table.querySelectorAll(':scope > tbody > tr[data-index]').forEach(row => body.append(row.cloneNode(true)));
  copy.append(body);
  host.append(copy);
  document.body.append(host);
  try {
    return copy.tHead?.rows[0]?.cells[header.cellIndex]?.getBoundingClientRect().width ?? null;
  } finally {
    host.remove();
  }
};

/**
 * Ширина столбцов таблицы «Расчётов» как в Excel («Проживание»): граница заголовка тянется мышью, двойной клик — по
 * самому длинному тексту строк на экране, ← / → / Enter на ручке; ширины — в localStorage по ключу таблицы.
 *
 * Таблица — table-layout: fixed, width: 100%: пока столбцы уже экрана, браузер растягивает их все, и граница не шла бы
 * за мышью. Поэтому с первой правки таблица «точная» (width: 0 — по CSS 2.1 §17.5.2.1 ширина = сумма столбцов), а если
 * она была растянута — сначала запоминаются фактические ширины всех видимых столбцов: без скачка. Столбцы без своей
 * ширины (подстолбцы новой порции, «+», возвращённые шестерёнкой) берут ширину класса.
 */
export const useColumnResize = ({
  storageKey, columnKeys, measuringClass, measureHostClass,
}: IUseColumnResizeOptions): IColumnResizeState => {
  const enabled = useMediaMatch(RESIZE_QUERY) && storageKey !== undefined;
  const { widths, setWidths } = useColumnWidths(storageKey);
  const hasWidths = Object.keys(widths).length > 0;

  const handlers = useMemo(() => {
    const result = new Map<string, IColumnResize>();
    if (!enabled || !setWidths) return result;

    /**
     * Первая правка: таблица становится точной (ширина = сумма столбцов) без скачка. Была растянута на весь экран —
     * запоминаются фактические ширины всех видимых столбцов; иначе — только этого. Столбцы без ключа слева («№») после
     * переключения вернутся к ширине своего класса — освободившееся отдаётся первому столбцу с ключом («Сотрудник»):
     * границы остальных столбцов, и та, за которую взялись, не сдвигаются.
     */
    const freeze = (header: HTMLTableCellElement, key: string) => {
      const table = header.closest('table');
      const scroll = table?.parentElement;
      const heads = table?.tHead?.rows[0]?.cells;
      if (hasWidths || !table || !scroll || !heads) return;
      const cols = [...table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col')];
      const widthOf = (index: number) => heads[index]?.getBoundingClientRect().width ?? 0;
      const stretched = table.getBoundingClientRect().width <= scroll.clientWidth + FIT_SLACK;
      const snapshot: Record<string, number> = {};
      if (stretched) {
        cols.forEach((col, index) => {
          if (col.dataset.colKey) snapshot[col.dataset.colKey] = clampColumnWidth(widthOf(index));
        });
      } else {
        snapshot[key] = clampColumnWidth(header.getBoundingClientRect().width);
      }
      const lead = cols.findIndex(col => col.dataset.colKey);
      const leadKey = lead >= 0 ? cols[lead].dataset.colKey : undefined;
      const leadingWidth = () => cols.slice(0, Math.max(lead, 0)).reduce((sum, _col, index) => sum + widthOf(index), 0);
      const before = leadingWidth();
      flushSync(() => setWidths(snapshot));
      const freed = before - leadingWidth();
      if (stretched && leadKey && snapshot[leadKey] !== undefined && Math.abs(freed) >= 1) {
        flushSync(() => setWidths({ [leadKey]: clampColumnWidth(snapshot[leadKey] + freed) }));
      }
    };

    for (const key of columnKeys) {
      result.set(key, {
        onPointerDown: (event: PointerEvent<HTMLSpanElement>) => {
          if (event.button !== 0) return;
          const handle = event.currentTarget;
          const header = handle.closest('th');
          if (!header || !colOf(header)) return;
          event.preventDefault();
          event.stopPropagation();
          // Таблица становится точной до первого движения — иначе при сужении браузер растянул бы её обратно.
          freeze(header, key);
          const col = colOf(header);
          if (!col) return;
          const startX = event.clientX;
          const startWidth = header.getBoundingClientRect().width;
          const startStyle = col.style.width;
          let width = startWidth;
          handle.setPointerCapture(event.pointerId);
          // Пока тянут — прямо в <col>, без перерисовки строк; таблица = сумма столбцов, растёт на ту же дельту.
          const move = (moveEvent: globalThis.PointerEvent) => {
            width = clampColumnWidth(startWidth + moveEvent.clientX - startX);
            col.style.width = `${width}px`;
          };
          const finish = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', finish);
            handle.removeEventListener('pointercancel', finish);
            if (Math.round(width) !== Math.round(startWidth)) setWidths({ [key]: width });
            else col.style.width = startStyle;
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', finish);
          handle.addEventListener('pointercancel', finish);
        },
        onAutoFit: header => {
          if (!header) return;
          const natural = measureNaturalWidth(header, measuringClass, measureHostClass);
          if (natural === null) return;
          freeze(header, key);
          setWidths({ [key]: clampColumnWidth(Math.ceil(natural), COLUMN_AUTOFIT_MAX_WIDTH) });
        },
        onStep: (delta, header) => {
          if (!header) return;
          freeze(header, key);
          const current = header.getBoundingClientRect().width;
          setWidths({ [key]: clampColumnWidth(current + delta * COLUMN_WIDTH_STEP) });
        },
      });
    }
    return result;
  }, [enabled, setWidths, hasWidths, columnKeys, measuringClass, measureHostClass]);

  return {
    widths: enabled ? widths : NO_WIDTHS,
    exact: enabled && hasWidths,
    resizeOf: key => handlers.get(key),
  };
};
