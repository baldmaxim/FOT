import { type FC, type WheelEvent, useCallback, useEffect, useRef, useState } from 'react';
import { X, Download, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { documentService } from '../../services/documentService';
import { ModalShell } from '../ui/ModalShell';
import styles from './FilePreviewModal.module.css';

type Disposition = 'inline' | 'attachment';

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

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
  const [baseW, setBaseW] = useState<number | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Сброс зума при смене файла, чтобы новый открывался вписанным.
  useEffect(() => {
    setZoom(1);
    setBaseW(null);
  }, [url, fileName]);

  // Ширина картинки во вписанном (zoom=1) состоянии — база для масштаба.
  const handleImgLoad = useCallback(() => {
    const w = imgRef.current?.getBoundingClientRect().width;
    if (w) setBaseW(w);
  }, []);

  const zoomIn = useCallback(() => setZoom(z => clampZoom(z + ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom(z => clampZoom(z - ZOOM_STEP)), []);
  const zoomReset = useCallback(() => setZoom(1), []);

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
          <div className={styles.body} onWheel={handleWheel}>
            {error && <div className={styles.error}>{error}</div>}
            {!error && !url && <div className={styles.loading}>Загрузка…</div>}
            {url && !error && isImage && (
              <img
                ref={imgRef}
                src={url}
                alt={fileName}
                className={styles.image}
                onLoad={handleImgLoad}
                style={
                  zoom > 1 && baseW
                    ? { width: baseW * zoom, height: 'auto', maxWidth: 'none', maxHeight: 'none' }
                    : undefined
                }
                draggable={false}
              />
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
