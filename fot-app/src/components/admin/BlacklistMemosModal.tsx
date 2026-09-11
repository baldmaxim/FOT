import { useRef, useState } from 'react';
import type { FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalShell } from '../ui/ModalShell';
import { useToast } from '../../contexts/ToastContext';
import { adminService, type IBlacklistMemo, type IBlacklistRow } from '../../services/adminService';
import { MEMO_ACCEPT, formatFileSize, memoErrorText, uploadMemoFiles } from './blacklistMemoUpload';
import styles from '../../pages/admin/Admin.module.css';

interface IBlacklistMemosModalProps {
  entry: IBlacklistRow;
  onClose: () => void;
}

const formatDateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
};

/**
 * Служебные записки к записи чёрного списка: открыть, скачать, приложить ещё,
 * удалить ошибочно приложенную. Удаление мягкое — файл остаётся в хранилище,
 * в истории действий видно, кто удалил.
 */
export const BlacklistMemosModal: FC<IBlacklistMemosModalProps> = ({ entry, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const memosQuery = useQuery<IBlacklistMemo[]>({
    queryKey: ['admin-users', 'blacklist', 'memos', entry.id],
    queryFn: ({ signal }) => adminService.getBlacklistMemos(entry.id, signal),
    // Ссылки на файлы подписаны на час — держим свежими, чтобы не открыть протухшую.
    staleTime: 60_000,
  });
  const memos = memosQuery.data || [];

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-users', 'blacklist', 'memos', entry.id] }),
      queryClient.invalidateQueries({ queryKey: ['admin-users', 'blacklist'] }),
    ]);
  };

  const handleFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (fileInput.current) fileInput.current.value = '';
    if (files.length === 0) return;

    setUploading(true);
    try {
      const summary = await uploadMemoFiles(entry.id, files);
      if (summary.added.length > 0) toast.success(`Приложено файлов: ${summary.added.length}`);
      if (summary.duplicates.length > 0) {
        toast.info(`Уже приложены ранее: ${summary.duplicates.join(', ')}`);
      }
      if (summary.failed.length > 0) {
        toast.error(summary.failed.map(f => `${f.name}: ${f.error}`).join('; '));
      }
      await refresh();
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async (memo: IBlacklistMemo) => {
    if (!confirm(`Удалить служебную записку «${memo.file_name}»?`)) return;
    setRemovingId(memo.id);
    try {
      await adminService.removeBlacklistMemo(entry.id, memo.id);
      toast.success('Служебная записка удалена');
      await refresh();
    } catch (error) {
      toast.error(memoErrorText(error));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={styles.modalOverlay}
      containerClassName={styles.blacklistModal}
    >
      {({ requestClose }) => (
        <>
          <div className={styles.blacklistModalHeader}>
            <h2>Служебные записки</h2>
          </div>

          <div className={styles.blacklistModalBody}>
            <div className={styles.blacklistPicked}>
              <strong>{entry.full_name}</strong>
              <span className={styles.blacklistSub}>Причина: {entry.reason}</span>
            </div>

            {memosQuery.isPending && <div className={styles.blacklistHint}>Загрузка…</div>}
            {memosQuery.isError && (
              <div className={styles.blacklistWarning}>{memoErrorText(memosQuery.error)}</div>
            )}
            {!memosQuery.isPending && !memosQuery.isError && memos.length === 0 && (
              <div className={styles.blacklistHint}>Служебных записок нет</div>
            )}

            {memos.length > 0 && (
              <ul className={styles.blacklistMemoList}>
                {memos.map(memo => (
                  <li key={memo.id} className={styles.blacklistMemoItem}>
                    <div className={styles.blacklistMemoInfo}>
                      <span className={styles.blacklistMemoName}>{memo.file_name}</span>
                      <span className={styles.blacklistSub}>
                        {formatFileSize(memo.file_size)} · {memo.uploaded_by_name} · {formatDateTime(memo.created_at)}
                      </span>
                    </div>
                    <div className={styles.blacklistMemoActions}>
                      {memo.preview_url && (
                        <a
                          className={styles.cancelBtn}
                          href={memo.preview_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Открыть
                        </a>
                      )}
                      <a className={styles.cancelBtn} href={memo.download_url} rel="noopener noreferrer">
                        Скачать
                      </a>
                      <button
                        className={styles.dangerBtn}
                        onClick={() => handleRemove(memo)}
                        disabled={removingId === memo.id}
                      >
                        {removingId === memo.id ? '…' : 'Удалить'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className={styles.blacklistHint}>
              PDF, JPEG, PNG, WebP, DOC или DOCX до 25 МБ. Повторно приложить тот же файл нельзя — дубля не будет.
            </div>
          </div>

          <div className={styles.blacklistModalFooter}>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={MEMO_ACCEPT}
              hidden
              onChange={e => handleFiles(e.target.files)}
            />
            <button className={styles.cancelBtn} onClick={requestClose} disabled={uploading}>
              Закрыть
            </button>
            <button
              className={styles.primaryBtn}
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              {uploading ? 'Загрузка…' : 'Приложить файл'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
