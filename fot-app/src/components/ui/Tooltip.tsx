import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

/**
 * Единый источник дизайна всплывающих подсказок.
 *
 * Один глобальный хост: через делегирование событий на document перехватывает
 * наведение/фокус на ЛЮБОЙ элемент с `data-tooltip` или нативным `title`,
 * гасит браузерный тултип (снимает `title`, возвращает при уходе) и рисует
 * современный портал-тултип у элемента. Тема (тёмная/светлая) — через общие
 * CSS-переменные. Только десктоп: активен при `(hover: hover) and (pointer: fine)`,
 * фокус показывает тултип лишь при `:focus-visible` (клавиатура).
 */

const SELECTOR = '[data-tooltip], [title]';
const GAP = 8;
const MARGIN = 8;

type Placement = 'top' | 'bottom';
interface ITip {
  text: string;
  top: number;
  left: number;
  placement: Placement;
}

const getText = (el: Element, stored: WeakMap<Element, string>): string => {
  const ds = el.getAttribute('data-tooltip');
  if (ds && ds.trim()) return ds;
  const title = el.getAttribute('title');
  if (title && title.trim()) {
    stored.set(el, title);
    el.removeAttribute('title'); // гасим нативный тултип
    return title;
  }
  // title уже снят на предыдущем наведении — берём сохранённое значение
  const prev = stored.get(el);
  return prev && prev.trim() ? prev : '';
};

const place = (rect: DOMRect, w: number, h: number): Pick<ITip, 'top' | 'left' | 'placement'> => {
  let placement: Placement = 'bottom';
  let top = rect.bottom + GAP;
  if (top + h > window.innerHeight - MARGIN && rect.top - GAP - h > MARGIN) {
    placement = 'top';
    top = rect.top - GAP - h;
  }
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(MARGIN, Math.min(left, window.innerWidth - MARGIN - w));
  return { top, left, placement };
};

export const TooltipHost: FC = () => {
  const [tip, setTip] = useState<ITip | null>(null);
  const [open, setOpen] = useState(false);

  const nodeRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<Element | null>(null);
  const pendingRef = useRef<Element | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const storedRef = useRef<WeakMap<Element, string>>(new WeakMap());
  const showTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const positionedRef = useRef(false);

  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const cs = getComputedStyle(document.documentElement);
    const showDelay = parseInt(cs.getPropertyValue('--tooltip-delay'), 10) || 350;
    const closeDur = (parseInt(cs.getPropertyValue('--tooltip-close-dur'), 10) || 100) + 50;

    const clearShow = () => {
      if (showTimer.current != null) { window.clearTimeout(showTimer.current); showTimer.current = null; }
    };

    const restore = (el: Element) => {
      const v = storedRef.current.get(el);
      if (v != null && !el.hasAttribute('title')) el.setAttribute('title', v);
      storedRef.current.delete(el);
    };

    const hide = () => {
      clearShow();
      pendingRef.current = null;
      const el = activeRef.current;
      activeRef.current = null;
      if (el) restore(el);
      setOpen(false);
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => setTip(null), closeDur);
    };

    const show = (el: Element) => {
      if (!el.isConnected) return;
      const text = getText(el, storedRef.current);
      if (!text) return;
      if (closeTimer.current != null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
      activeRef.current = el;
      rectRef.current = el.getBoundingClientRect();
      positionedRef.current = false;
      setTip({ text, top: -9999, left: -9999, placement: 'bottom' });
      setOpen(false);
    };

    const scheduleShow = (el: Element) => {
      clearShow();
      pendingRef.current = el;
      showTimer.current = window.setTimeout(() => {
        pendingRef.current = null;
        show(el);
      }, showDelay);
    };

    const findTarget = (e: Event): Element | null => {
      const t = e.target;
      return t instanceof Element ? t.closest(SELECTOR) : null;
    };

    const onOver = (e: MouseEvent) => {
      const el = findTarget(e);
      if (!el || el === activeRef.current || el === pendingRef.current) return;
      if (activeRef.current) hide();
      scheduleShow(el);
    };

    const onOut = (e: MouseEvent) => {
      const el = findTarget(e);
      if (!el) return;
      const related = e.relatedTarget as Node | null;
      if (related && el.contains(related)) return; // движение внутри того же триггера
      if (pendingRef.current === el) { clearShow(); pendingRef.current = null; }
      if (activeRef.current === el) hide();
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = findTarget(e);
      if (!el || el === activeRef.current) return;
      try { if (!el.matches(':focus-visible')) return; } catch { return; }
      if (activeRef.current) hide();
      scheduleShow(el);
    };

    const onFocusOut = (e: FocusEvent) => {
      const el = findTarget(e);
      if (!el) return;
      if (pendingRef.current === el) { clearShow(); pendingRef.current = null; }
      if (activeRef.current === el) hide();
    };

    const onDismiss = () => { if (activeRef.current || pendingRef.current) hide(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('click', onDismiss, true);
    document.addEventListener('scroll', onDismiss, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onDismiss);

    return () => {
      clearShow();
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
      const el = activeRef.current;
      if (el) restore(el);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('click', onDismiss, true);
      document.removeEventListener('scroll', onDismiss, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, []);

  // Две фазы: измеряем размер скрытого тултипа → ставим финальную позицию → открываем.
  useLayoutEffect(() => {
    if (!tip || open || !nodeRef.current || !rectRef.current) return;
    if (!positionedRef.current) {
      // offsetWidth/Height — целые, без scale-трансформа (= размер открытого тултипа):
      // снимает субпиксельную петлю «измерил→переставил→переизмерил».
      const node = nodeRef.current;
      const pos = place(rectRef.current, node.offsetWidth, node.offsetHeight);
      positionedRef.current = true;
      setTip({ ...tip, ...pos });
      return;
    }
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, [tip, open]);

  if (!tip) return null;

  return createPortal(
    <div
      ref={nodeRef}
      className={styles.tooltip}
      role="tooltip"
      data-state={open ? 'open' : 'closing'}
      data-placement={tip.placement}
      style={{ top: tip.top, left: tip.left }}
    >
      {tip.text}
    </div>,
    document.body,
  );
};
