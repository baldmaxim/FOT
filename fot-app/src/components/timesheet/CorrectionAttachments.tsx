import { type FC, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, Trash2, Upload, Eye, FileText } from 'lucide-react';
import { correctionAttachmentsService, type ICorrectionAttachment } from '../../services/correctionAttachmentsService';
import { FilePreviewModal } from '../documents/FilePreviewModal';

interface IProps {
  adjustmentId: number;
  /**
   * modal — drop-zone + список (внутри основной модалки корректировки);
   * popover — компактный список без drop-zone (для всплывающей подсказки в списке).
   */
  variant: 'modal' | 'popover';
  /** Разрешена ли загрузка/удаление (зависит от прав родителя). */
  canEdit?: boolean;
}

const MAX_BYTES = 25 * 1024 * 1024;

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
};

export const CorrectionAttachments: FC<IProps> = ({ adjustmentId, variant, canEdit = true }) => {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ICorrectionAttachment | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const queryKey = ['correction-attachments', adjustmentId];

  const { data: items = [], isLoading, error: loadError } = useQuery({
    queryKey,
    queryFn: () => correctionAttachmentsService.list(adjustmentId),
    staleTime: 30_000,
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => correctionAttachmentsService.upload(adjustmentId, file),
    onSuccess: () => {
      setUploadError(null);
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] });
    },
    onError: (err: unknown) => setUploadError(err instanceof Error ? err.message : 'Ошибка загрузки'),
  });

  const deleteMutation = useMutation({
    mutationFn: (attachmentId: number) => correctionAttachmentsService.remove(adjustmentId, attachmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] });
    },
  });

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        setUploadError(`Файл «${file.name}» больше 25 МБ`);
        continue;
      }
      uploadMutation.mutate(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDelete = (item: ICorrectionAttachment) => {
    if (item.source !== 'adjustment') return;
    if (!window.confirm(`Удалить файл «${item.original_name}»?`)) return;
    deleteMutation.mutate(item.id);
  };

  return (
    <div className={`ts-corr-attachments ts-corr-attachments--${variant}`}>
      {variant === 'modal' && (
        <div className="ts-corr-attachments__header">
          <Paperclip size={14} />
          <span>Файлы корректировки</span>
        </div>
      )}

      {isLoading && <div className="ts-corr-attachments__empty">Загрузка…</div>}
      {loadError instanceof Error && (
        <div className="ts-corr-attachments__error">{loadError.message}</div>
      )}

      {!isLoading && items.length === 0 && (
        <div className="ts-corr-attachments__empty">Файлов нет</div>
      )}

      {items.length > 0 && (
        <ul className="ts-corr-attachments__list">
          {items.map(item => {
            const isLeaveRequest = item.source === 'leave_request';
            return (
              <li key={item.id} className="ts-corr-attachments__item">
                <FileText size={14} className="ts-corr-attachments__icon" />
                <span
                  className="ts-corr-attachments__name"
                  title={`${item.original_name} · ${formatSize(item.file_size)}${isLeaveRequest ? ' · из заявки' : ''}`}
                >
                  {item.original_name}
                </span>
                <span className="ts-corr-attachments__meta">{formatSize(item.file_size)}</span>
                {isLeaveRequest && (
                  <span className="ts-corr-attachments__tag" title="Файл прикреплён в исходной заявке">
                    заявка
                  </span>
                )}
                <button
                  type="button"
                  className="ts-corr-attachments__btn"
                  onClick={() => setPreview(item)}
                  title="Открыть файл"
                  aria-label="Открыть файл"
                >
                  <Eye size={14} />
                </button>
                {canEdit && !isLeaveRequest && (
                  <button
                    type="button"
                    className="ts-corr-attachments__btn ts-corr-attachments__btn--danger"
                    onClick={() => handleDelete(item)}
                    title="Удалить файл"
                    aria-label="Удалить файл"
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && (
        <div className="ts-corr-attachments__upload">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={e => handleFiles(e.target.files)}
            aria-label="Прикрепить файлы"
          />
          <button
            type="button"
            className="ts-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
          >
            <Upload size={14} /> {uploadMutation.isPending ? 'Загрузка…' : 'Прикрепить'}
          </button>
          {uploadError && <span className="ts-corr-attachments__error">{uploadError}</span>}
        </div>
      )}

      {preview && (
        <FilePreviewModal
          fileName={preview.original_name}
          mimeType={preview.mime_type}
          urlLoader={async () => preview.download_url}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
};
