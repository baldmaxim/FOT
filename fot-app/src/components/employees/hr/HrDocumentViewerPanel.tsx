import { useCallback, useMemo, useState, type FC } from 'react';
import { ArrowLeft, FileText, Image as ImageIcon } from 'lucide-react';
import { FileViewer, type FileDisposition } from '../../documents/FileViewer';
import { hrProfileService } from '../../../services/hrProfileService';
import type { IHrDocument, IHrDocumentSlot } from '../../../types/hrProfile';
import { fmtBytes } from './hrFormat';
import styles from './HrProfileModal.module.css';

interface IHrDocumentViewerPanelProps {
  slots: IHrDocumentSlot[];
  loading: boolean;
}

interface IListed {
  doc: IHrDocument;
  typeLabel: string;
}

/**
 * Панель «Оригинал» рядом с полями реквизитов — то же, что справа в карточке
 * PassDesk. Сначала список сканов по типам, по клику — просмотрщик с зумом,
 * поворотом и скачиванием. Сам скан скачивается и расшифровывается только
 * после клика: без этого открытие карточки тянуло бы файлы и писало бы в
 * аудит просмотры, которых человек не делал.
 */
export const HrDocumentViewerPanel: FC<IHrDocumentViewerPanelProps> = ({ slots, loading }) => {
  const [selected, setSelected] = useState<IListed | null>(null);

  const listed = useMemo<IListed[]>(
    () => slots.flatMap(slot => slot.files.map(doc => ({ doc, typeLabel: slot.label }))),
    [slots],
  );

  const selectedId = selected?.doc.id ?? null;
  const loadUrl = useCallback(
    (disposition: FileDisposition): Promise<string> =>
      selectedId == null
        ? Promise.reject(new Error('Документ не выбран'))
        : hrProfileService.documentBlobUrl(selectedId, disposition),
    [selectedId],
  );

  if (selected) {
    return (
      <div className={styles.viewerPanel}>
        <FileViewer
          fileName={selected.doc.file_name}
          mimeType={selected.doc.mime_type}
          loadUrl={loadUrl}
          leading={
            <>
              <button type="button" className={styles.viewerBack} onClick={() => setSelected(null)} title="К списку сканов" aria-label="К списку сканов">
                <ArrowLeft size={16} />
              </button>
              <span className={styles.viewerType}>{selected.typeLabel}</span>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.viewerPanel}>
      <div className={styles.viewerListHead}>
        <h4>Оригиналы</h4>
        <span className={styles.slotCount}>{listed.length}</span>
      </div>
      <div className={styles.viewerList}>
        {loading && <div className={styles.muted}>Загрузка…</div>}
        {!loading && listed.length === 0 && <div className={styles.muted}>Сканов пока нет. Загрузить их можно на вкладке «Файлы».</div>}
        {listed.map(item => (
          <button key={item.doc.id} type="button" className={styles.viewerRow} onClick={() => setSelected(item)}>
            {item.doc.mime_type.startsWith('image/') ? <ImageIcon size={15} /> : <FileText size={15} />}
            <span className={styles.viewerRowMain}>
              <span className={styles.viewerRowType}>{item.typeLabel}</span>
              <span className={styles.viewerRowName} title={item.doc.file_name}>{item.doc.file_name}</span>
            </span>
            <span className={styles.viewerRowSize}>{fmtBytes(item.doc.file_size)}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
