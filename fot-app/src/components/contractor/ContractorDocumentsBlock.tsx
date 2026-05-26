import { useRef, useState, type DragEvent, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { contractorService, type IContractorDocument } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_BATCH = 10;

const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const fmtDate = (iso: string): string => {
  try { return new Date(iso).toLocaleString('ru'); } catch { return iso; }
};

const validateFile = (f: File): string | null => {
  if (f.size > MAX_BYTES) return `Файл «${f.name}» больше 10 МБ`;
  if (!ALLOWED_MIME.has(f.type)) {
    const lower = f.name.toLowerCase();
    if (!ALLOWED_EXT.some(ext => lower.endsWith(ext))) {
      return `Файл «${f.name}» не PDF/JPG/PNG`;
    }
  }
  return null;
};

export const ContractorDocumentsBlock: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ['contractor-documents'],
    queryFn: () => contractorService.listDocuments(),
    staleTime: 30_000,
  });

  const docs: IContractorDocument[] = query.data ?? [];

  const uploadMany = async (files: File[]) => {
    if (files.length === 0) return;
    const batch = files.slice(0, MAX_BATCH);
    if (files.length > MAX_BATCH) {
      toast.error(`За раз — не более ${MAX_BATCH} файлов`);
    }
    const errs: string[] = [];
    for (const f of batch) {
      const err = validateFile(f);
      if (err) { errs.push(err); continue; }
    }
    if (errs.length > 0) toast.error(errs.join('; '));

    setBusy(true);
    try {
      let uploaded = 0;
      for (const f of batch) {
        if (validateFile(f)) continue;
        try {
          await contractorService.uploadDocument(f);
          uploaded += 1;
        } catch (e) {
          toast.error(`«${f.name}»: ${e instanceof Error ? e.message : 'ошибка'}`);
        }
      }
      if (uploaded > 0) {
        toast.success(`Загружено файлов: ${uploaded}`);
        await qc.invalidateQueries({ queryKey: ['contractor-documents'] });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    await uploadMany(files);
  };

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    await uploadMany(files);
  };

  const handleDelete = async (doc: IContractorDocument) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return;
    setBusy(true);
    try {
      await contractorService.deleteDocument(doc.id);
      toast.success('Файл удалён');
      await qc.invalidateQueries({ queryKey: ['contractor-documents'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить');
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async (doc: IContractorDocument) => {
    try {
      const { url } = await contractorService.getDocumentDownloadUrl(doc.id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось получить ссылку');
    }
  };

  return (
    <div className={styles.docsBlock}>
      <h3 className={styles.title} style={{ marginTop: 0 }}>Документы организации</h3>
      <div className={styles.statusNote} style={{ marginBottom: 8 }}>
        Прикладывайте сюда сканы доверенностей, договоров и т.п. Эти файлы видит админ при согласовании
        любой заявки. PDF / JPG / PNG, до 10 МБ за файл, до {MAX_BATCH} за раз.
      </div>

      <div
        className={`${styles.docsDropzone} ${dragOver ? styles.docsDropzoneOver : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => void handleDrop(e)}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <div>
          {busy ? 'Загрузка…' : 'Перетащите файлы сюда или нажмите, чтобы выбрать'}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          multiple
          style={{ display: 'none' }}
          onChange={e => void handlePick(e)}
        />
      </div>

      {query.isLoading ? (
        <div className={styles.empty} style={{ padding: 12 }}>Загрузка…</div>
      ) : docs.length === 0 ? (
        <div className={styles.empty} style={{ padding: 12 }}>Документов нет</div>
      ) : (
        <table className={styles.table} style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Файл</th><th>Размер</th><th>Загружен</th><th></th></tr>
          </thead>
          <tbody>
            {docs.map(d => (
              <tr key={d.id}>
                <td>{d.file_name}</td>
                <td>{fmtSize(d.file_size)}</td>
                <td>{fmtDate(d.created_at)}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-secondary" onClick={() => void handleDownload(d)}>
                    Скачать
                  </button>
                  <button className="btn-secondary" onClick={() => void handleDelete(d)} disabled={busy}>
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default ContractorDocumentsBlock;
