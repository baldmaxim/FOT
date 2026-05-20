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
 * Координатная ссылка, открывающая точку на openstreetmap.org. При наведении —
 * всплывает встроенная мини-карта OSM (iframe-embed). Превью рендерится через
 * React Portal в document.body, чтобы не обрезаться overflow родительского
 * .tableWrap; координаты — fixed по getBoundingClientRect().
 */
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
    // Если справа не помещается — прижимаем к правому краю; снизу — выводим сверху.
    let left = rect.left;
    if (left + MINI_W > vw - 8) left = Math.max(8, vw - MINI_W - 8);
    let top = rect.bottom + 4;
    if (top + MINI_H > vh - 8) top = Math.max(8, rect.top - MINI_H - 4);
    setPos({ top, left });
  }, []);

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

  return (
    <span className={styles.coordCell}>
      <a
        ref={triggerRef}
        className={styles.link}
        href={fullHref}
        target="_blank"
        rel="noreferrer"
        title={title}
        onMouseEnter={recompute}
        onMouseLeave={() => setPos(null)}
        onFocus={recompute}
        onBlur={() => setPos(null)}
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
