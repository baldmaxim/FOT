import { type FC, type ReactNode, type SyntheticEvent, type WheelEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Download, Maximize, RotateCwSquare, X, ZoomIn, ZoomOut } from 'lucide-react';
import { fitImageSize, type IFitSize } from '../../utils/imageFit';
import styles from './FileViewer.module.css';

export type FileDisposition = 'inline' | 'attachment';

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

interface IViewerResult {
  /** Загрузчик, которому принадлежит результат: по нему видно, не устарел ли он. */
  loader: (disposition: FileDisposition) => Promise<string>;
  url?: string;
  error?: string;
}

interface IFileViewerProps {
  fileName: string;
  mimeType?: string | null;
  /** Источник ссылки на файл: 'inline' — для просмотра, 'attachment' — для скачивания. */
  loadUrl: (disposition: FileDisposition) => Promise<string>;
  /** Слот слева от имени файла: кнопка «назад» во встроенной панели. */
  leading?: ReactNode;
  /** Задан — в тулбаре рисуется крестик (модальный режим). */
  onClose?: () => void;
  /** Отступ под «чёлку»: нужен полноэкранной модалке на телефоне. */
  safeAreaTop?: boolean;
}

/**
 * Просмотр файла: вписывание с учётом поворота, зум колесом и кнопками,
 * поворот на 90°, PDF через iframe, скачивание, фолбэк для остальных типов.
 * Отдельно от модалки, чтобы тот же просмотрщик работал встроенной панелью
 * рядом с полями (реквизиты сотрудника, как в PassDesk).
 */
export const FileViewer: FC<IFileViewerProps> = ({ fileName, mimeType, loadUrl, leading, onClose, safeAreaTop = false }) => {
  // Результат привязан к загрузчику: когда файл сменился, прежняя ссылка
  // перестаёт считаться текущей сама — без сброса состояния в эффекте.
  const [result, setResult] = useState<IViewerResult | null>(null);
  const current = result?.loader === loadUrl ? result : null;
  const url = current?.url ?? null;
  const error = current?.error ?? null;
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [natural, setNatural] = useState<IFitSize | null>(null);
  const [box, setBox] = useState<IFitSize | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Сброс зума и поворота при смене файла, чтобы новый открывался вписанным.
  const viewKey = `${url ?? ''}|${fileName}`;
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (viewKey !== prevViewKey) {
    setPrevViewKey(viewKey);
    setZoom(1);
    setRotation(0);
    setNatural(null);
  }

  // Доступная область без padding. border-box не меняется от появления
  // скроллбара, поэтому зум не зацикливает пересчёт; offsetWidth не зависит
  // от scale-анимации входа модалки.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el);
      setBox({
        w: el.offsetWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        h: el.offsetHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
      });
    });
    ro.observe(el, { box: 'border-box' });
    return () => ro.disconnect();
  }, []);

  const handleImgLoad = useCallback((e: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (w && h) setNatural({ w, h });
  }, []);

  const zoomIn = useCallback(() => setZoom(z => clampZoom(z + ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom(z => clampZoom(z - ZOOM_STEP)), []);
  const zoomReset = useCallback(() => setZoom(1), []);
  const rotate = useCallback(() => setRotation(r => (r + 90) % 360), []);

  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(z => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
  }, []);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    loadUrl('inline')
      .then(u => {
        if (!active) {
          // Файл успел смениться: ссылку не показываем и сразу освобождаем.
          if (u.startsWith('blob:')) URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u.startsWith('blob:') ? u : null;
        setResult({ loader: loadUrl, url: u });
      })
      .catch(() => { if (active) setResult({ loader: loadUrl, error: 'Не удалось получить ссылку на файл' }); });
    // В панели реквизитов за один сеанс открывают много сканов — каждый blob
    // держит файл в памяти вкладки, поэтому освобождаем при смене документа.
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [loadUrl]);

  const handleDownload = useCallback(async () => {
    try {
      const u = await loadUrl('attachment');
      const a = document.createElement('a');
      a.href = u;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (u.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(u), 10_000);
    } catch {
      setResult({ loader: loadUrl, error: 'Не удалось скачать файл' });
    }
  }, [loadUrl, fileName]);

  const isImage = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  // Рамка — видимый прямоугольник, картинка поворачивается в её центре.
  const sideways = rotation % 180 !== 0;
  const imgSize = fitImageSize(natural, box, zoom, rotation);
  const showImage = Boolean(url && !error && isImage);

  return (
    <div className={styles.viewer}>
      <div className={`${styles.header} ${safeAreaTop ? styles.headerSafe : ''}`}>
        {leading && <div className={styles.leading}>{leading}</div>}
        <span className={styles.title} title={fileName}>{fileName}</span>
        <div className={styles.actions}>
          {url && isImage && (
            <>
              <button type="button" className={styles.iconBtn} onClick={rotate} title="Повернуть на 90°" aria-label="Повернуть на 90°">
                <RotateCwSquare size={16} />
              </button>
              <button type="button" className={styles.iconBtn} onClick={zoomOut} disabled={zoom <= ZOOM_MIN} title="Уменьшить" aria-label="Уменьшить">
                <ZoomOut size={16} />
              </button>
              <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
              <button type="button" className={styles.iconBtn} onClick={zoomIn} disabled={zoom >= ZOOM_MAX} title="Увеличить" aria-label="Увеличить">
                <ZoomIn size={16} />
              </button>
              <button type="button" className={styles.iconBtn} onClick={zoomReset} disabled={zoom === 1} title="Сбросить масштаб" aria-label="Сбросить масштаб">
                <Maximize size={16} />
              </button>
            </>
          )}
          {url && (
            <button type="button" className={styles.iconBtn} onClick={handleDownload} title="Скачать">
              <Download size={16} />
            </button>
          )}
          {onClose && (
            <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          )}
        </div>
      </div>
      <div
        ref={bodyRef}
        className={showImage ? `${styles.body} ${styles.bodyImage}` : styles.body}
        onWheel={handleWheel}
      >
        {error && <div className={styles.error}>{error}</div>}
        {!error && !url && <div className={styles.loading}>Загрузка…</div>}
        {showImage && url && (
          <div
            className={styles.imageFrame}
            style={imgSize ? { width: sideways ? imgSize.h : imgSize.w, height: sideways ? imgSize.w : imgSize.h } : undefined}
          >
            <img
              src={url}
              alt={fileName}
              className={styles.image}
              onLoad={handleImgLoad}
              style={
                imgSize
                  ? { width: imgSize.w, height: imgSize.h, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }
                  : undefined
              }
              draggable={false}
            />
          </div>
        )}
        {url && !error && isPdf && <iframe src={url} title={fileName} className={styles.iframe} />}
        {url && !error && !isImage && !isPdf && (
          <div className={styles.fallback}>
            <div>Предпросмотр недоступен для этого типа файла.</div>
            <button type="button" className={styles.downloadBtn} onClick={handleDownload}>
              <Download size={14} /> Скачать
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
