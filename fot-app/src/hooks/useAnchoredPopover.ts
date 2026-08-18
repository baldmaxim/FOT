import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

/** Зазор до края экрана — панель не должна прилипать к нему вплотную. */
const VIEWPORT_MARGIN = 8;

/**
 * Позиция выпадающей панели в портале (document.body) относительно триггера
 * через position:fixed. Панель не обрезается overflow-контейнерами (карточка/
 * таблица). При scroll/resize переезжает за триггером, НЕ закрываясь.
 * Возвращает inline-стиль для панели; `right:auto` гасит CSS `left/right:0`.
 *
 * `minWidth` — для панелей ШИРЕ триггера (они перебивают width на `auto`). Без него
 * панель у прижатого к правому краю триггера уезжает за границу экрана: базовый контракт
 * «панель по ширине триггера» такой случай не покрывает. Верх/низ тоже ограничиваются:
 * у нижнего края экрана панель ужимается и скроллится внутри себя.
 */
export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  minWidth = 0,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});

  const reposition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();

    // Ширина панели: не уже триггера, не уже minWidth и не шире экрана.
    const width = Math.min(
      Math.max(r.width, minWidth),
      window.innerWidth - VIEWPORT_MARGIN * 2,
    );
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(r.left, window.innerWidth - width - VIEWPORT_MARGIN),
    );

    setStyle({
      position: 'fixed',
      top: r.bottom + 4,
      left,
      right: 'auto',
      width: r.width,
      maxHeight: window.innerHeight - r.bottom - VIEWPORT_MARGIN * 2,
      overflowY: 'auto',
      zIndex: 9999,
    });
  }, [anchorRef, minWidth]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const h = () => reposition();
    window.addEventListener('resize', h);
    window.addEventListener('scroll', h, true);
    return () => {
      window.removeEventListener('resize', h);
      window.removeEventListener('scroll', h, true);
    };
  }, [open, reposition]);

  return style;
}
