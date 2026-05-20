import { type FC } from 'react';
import styles from './MtsPage.module.css';

interface IProps {
  lat: number;
  lng: number;
  title?: string;
  /** Подпись (по умолчанию — сами координаты с 5 знаками). */
  label?: string;
}

/**
 * Координатная ссылка, открывающая точку на openstreetmap.org. При наведении —
 * всплывает встроенная мини-карта OSM (iframe-embed, без подключения Leaflet
 * на основную страницу). zoom~15, bbox ±0.005° даёт обзор района.
 */
export const OsmCoord: FC<IProps> = ({ lat, lng, title, label }) => {
  const text = label ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const fullHref = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  const d = 0.005;
  const bbox = `${(lng - d).toFixed(5)},${(lat - d).toFixed(5)},${(lng + d).toFixed(5)},${(lat + d).toFixed(5)}`;
  const embed = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
  return (
    <span className={styles.coordCell}>
      <a className={styles.link} href={fullHref} target="_blank" rel="noreferrer" title={title}>
        {text}
      </a>
      <span className={styles.miniMap} aria-hidden="true">
        <iframe src={embed} loading="lazy" title="Превью карты" />
      </span>
    </span>
  );
};
