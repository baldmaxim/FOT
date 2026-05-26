import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './MtsPage.module.css';

interface IProps {
  lat: number;
  lng: number;
  title?: string;
  /** Подпись (по умолчанию — сами координаты с 5 знаками). */
  label?: string;
}

interface IPos {
  top: number;
  left: number;
}

const MINI_W = 260;
const MINI_H = 200;

/**
 * Глобальный реестр активной мини-карты. Одновременно может быть открыта только
 * одна — при наведении на новую старая закрывается. Глобальный watchdog по
 * mousemove закрывает мини-карту, если курсор покинул триггер (мы наблюдали
 * случаи, когда mouseleave не срабатывает: быстрое перемещение, скролл таблицы,
 * перемонтирование строки во время re-render — в этих кейсах portal оставался
 * висеть в document.body).
 */
let active: { close: () => void; el: HTMLElement } | null = null;
let globalMoveAttached = false;

const handleGlobalMove = (e: MouseEvent): void => {
  if (!active) return;
  const r = active.el.getBoundingClientRect();
  const inside =
    e.clientX >= r.left && e.clientX <= r.right
    && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) {
    const c = active.close;
    active = null;
    c();
  }
};

const ensureGlobalMove = (): void => {
  if (globalMoveAttached) return;
  document.addEventListener('mousemove', handleGlobalMove, { passive: true });
  globalMoveAttached = true;
};

const closeAndDeactivate = (closer: () => void): void => {
  if (active && active.close === closer) active = null;
  closer();
};

export const OsmCoord: FC<IProps> = ({ lat, lng, title, label }) => {
  const text = label ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const fullHref = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  const d = 0.005;
  const bbox = `${(lng - d).toFixed(5)},${(lat - d).toFixed(5)},${(lng + d).toFixed(5)},${(lat + d).toFixed(5)}`;
  const embed = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;

  const triggerRef = useRef<HTMLAnchorElement>(null);
  const [pos, setPos] = useState<IPos | null>(null);

  const recompute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left;
    if (left + MINI_W > vw - 8) left = Math.max(8, vw - MINI_W - 8);
    let top = rect.bottom + 4;
    if (top + MINI_H > vh - 8) top = Math.max(8, rect.top - MINI_H - 4);
    setPos({ top, left });
  }, []);

  // Стабильный closer (useCallback с пустым deps → одна и та же ссылка между
  // ре-рендерами). Используем её и для регистрации в active, и для сравнения
  // в active.close === close при cleanup.
  const close = useCallback(() => {
    setPos(null);
  }, []);

  const open = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    // Закрываем предыдущую открытую мини-карту, если она не наша.
    if (active && active.el !== el) {
      const prev = active.close;
      active = null;
      prev();
    }
    recompute();
    active = { close, el };
    ensureGlobalMove();
  }, [recompute, close]);

  const closeAndUnregister = useCallback(() => {
    closeAndDeactivate(close);
  }, [close]);

  useEffect(() => {
    if (pos == null) return;
    const onScroll = (): void => recompute();
    const onResize = (): void => recompute();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [pos, recompute]);

  // Гарантированный cleanup при unmount.
  useEffect(() => () => {
    if (active && active.close === close) active = null;
  }, [close]);

  return (
    <span className={styles.coordCell}>
      <a
        ref={triggerRef}
        className={styles.link}
        href={fullHref}
        target="_blank"
        rel="noreferrer"
        title={title}
        onPointerEnter={open}
        onPointerLeave={closeAndUnregister}
        onFocus={open}
        onBlur={closeAndUnregister}
      >
        {text}
      </a>
      {pos != null && createPortal(
        <span
          className={styles.miniMap}
          style={{ top: pos.top, left: pos.left }}
          aria-hidden="true"
        >
          <iframe src={embed} loading="lazy" title="Превью карты" />
        </span>,
        document.body,
      )}
    </span>
  );
};
