import { type FC, type SyntheticEvent, type WheelEvent, useCallback, useEffect, useRef, useState } from 'react';
import { X, Download, ZoomIn, ZoomOut, Maximize, RotateCwSquare } from 'lucide-react';
import { documentService } from '../../services/documentService';
import { ModalShell } from '../ui/ModalShell';
import styles from './FilePreviewModal.module.css';

type Disposition = 'inline' | 'attachment';

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

interface ISize {
  w: number;
  h: number;
}

interface IFilePreviewModalProps {
  documentId?: number;
  fileName: string;
  mimeType?: string | null;
  onClose: () => void;
  /**
   * Альтернативный источник signed URL. Если задан — используется он;
   * иначе берётся documentService.getDownloadUrl(documentId).
   * disposition='inline' — для предпросмотра, 'attachment' — для скачивания.
   */
  urlLoader?: (disposition: Disposition) => Promise<string>;
}

export const FilePreviewModal: FC<IFilePreviewModalProps> = ({
  documentId,
  fileName,
  mimeType,
  onClose,
  urlLoader,
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [natural, setNatural] = useState<ISize | null>(null);
  const [box, setBox] = useState<ISize | null>(null);
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

  const loadUrl = useCallback(
    (disposition: Disposition): Promise<string> => {
      if (urlLoader) return urlLoader(disposition);
      if (documentId != null) {
        return documentService.getDownloadUrl(documentId, disposition).then(r => r.download_url);
      }
      return Promise.reject(new Error('Не указан источник файла'));
    },
    [documentId, urlLoader],
  );

  useEffect(() => {
    let active = true;
    loadUrl('inline')
      .then(u => { if (active) setUrl(u); })
      .catch(() => { if (active) setError('Не удалось получить ссылку на файл'); });
    return () => { active = false; };
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
    } catch {
      setError('Не удалось скачать файл');
    }
  }, [loadUrl, fileName]);

  const isImage = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  // Вписывание с учётом поворота: боком у картинки меняются местами стороны.
  // Рамка — видимый прямоугольник, картинка поворачивается в её центре.
  const sideways = rotation % 180 !== 0;
  let imgSize: ISize | null = null;
  if (natural && box && box.w > 0 && box.h > 0) {
    const fit = Math.min(
      1,
      box.w / (sideways ? natural.h : natural.w),
      box.h / (sideways ? natural.w : natural.h),
    ) * zoom;
    imgSize = { w: natural.w * fit, h: natural.h * fit };
  }
  const showImage = Boolean(url && !error && isImage);

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container}>
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <span className={styles.title} title={fileName}>{fileName}</span>
            <div className={styles.actions}>
              {url && isImage && (
                <>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={rotate}
                    title="Повернуть на 90°"
                    aria-label="Повернуть на 90°"
                  >
                    <RotateCwSquare size={16} />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={zoomOut}
                    disabled={zoom <= ZOOM_MIN}
                    title="Уменьшить"
                    aria-label="Уменьшить"
                  >
                    <ZoomOut size={16} />
                  </button>
                  <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={zoomIn}
                    disabled={zoom >= ZOOM_MAX}
                    title="Увеличить"
                    aria-label="Увеличить"
                  >
                    <ZoomIn size={16} />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={zoomReset}
                    disabled={zoom === 1}
                    title="Сбросить масштаб"
                    aria-label="Сбросить масштаб"
                  >
                    <Maximize size={16} />
                  </button>
                </>
              )}
              {url && (
                <button type="button" className={styles.iconBtn} onClick={handleDownload} title="Скачать">
                  <Download size={16} />
                </button>
              )}
              <button type="button" className={styles.iconBtn} onClick={requestClose} aria-label="Закрыть">
                <X size={18} />
              </button>
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
            {url && !error && isPdf && (
              <iframe src={url} title={fileName} className={styles.iframe} />
            )}
            {url && !error && !isImage && !isPdf && (
              <div className={styles.fallback}>
                <div>Предпросмотр недоступен для этого типа файла.</div>
                <button type="button" className={styles.downloadBtn} onClick={handleDownload}>
                  <Download size={14} /> Скачать
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
};
