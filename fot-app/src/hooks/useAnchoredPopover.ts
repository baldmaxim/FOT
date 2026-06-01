import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

/**
 * Позиция выпадающей панели в портале (document.body) относительно триггера
 * через position:fixed. Панель не обрезается overflow-контейнерами (карточка/
 * таблица). При scroll/resize переезжает за триггером, НЕ закрываясь.
 * Возвращает inline-стиль для панели; `right:auto` гасит CSS `left/right:0`.
 */
export function useAnchoredPopover(open: boolean, anchorRef: RefObject<HTMLElement | null>): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});

  const reposition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setStyle({ position: 'fixed', top: r.bottom + 4, left: r.left, right: 'auto', width: r.width, zIndex: 9999 });
  }, [anchorRef]);

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
