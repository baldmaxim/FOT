import { type FC, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { timesheetDayFilesService, type ITimesheetDayFile } from '../../services/timesheetDayFilesService';
import { FilePreviewModal } from '../documents/FilePreviewModal';
import { displayFileName } from '../../utils/fileNameDisplay';

interface ITimesheetDayFilesProps {
  employeeId: number;
  workDate: string;
}

const MAX_BYTES = 25 * 1024 * 1024;
// Тот же список, что принимает сервер (без SVG).
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.pdf,.doc,.docx,.xls,.xlsx,.txt';

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
};

/** «Файлы дня» в окне дня: кадровый админ прикладывает файл/фото к дню без корректировки. */
export const TimesheetDayFiles: FC<ITimesheetDayFilesProps> = ({ employeeId, workDate }) => {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ITimesheetDayFile | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const queryKey = ['timesheet-day-files', employeeId, workDate];

  const { data: items = [], isLoading, error: loadError } = useQuery({
    queryKey,
    queryFn: () => timesheetDayFilesService.list(employeeId, workDate),
    staleTime: 30_000,
  });

  // Файлы грузятся по одному: первая ошибка останавливает очередь, загруженные остаются.
  const uploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        await timesheetDayFilesService.upload(employeeId, workDate, file);
      }
    },
    onSuccess: () => setUploadError(null),
    onError: (err: unknown) => setUploadError(err instanceof Error ? err.message : 'Ошибка загрузки'),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: number) => timesheetDayFilesService.remove(documentId),
    onError: (err: unknown) => setUploadError(err instanceof Error ? err.message : 'Ошибка удаления'),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    if (fileInputRef.current) fileInputRef.current.value = '';
    const tooBig = files.find(file => file.size > MAX_BYTES);
    if (tooBig) {
      setUploadError(`Файл «${tooBig.name}» больше 25 МБ`);
      return;
    }
    uploadMutation.mutate(files);
  };

  const handleDelete = (item: ITimesheetDayFile) => {
    if (!window.confirm(`Удалить файл «${item.original_name}»?`)) return;
    deleteMutation.mutate(item.id);
  };

  return (
    <div className="ts-corr-attachments ts-corr-attachments--modal ts-day-files">
      <div className="ts-corr-attachments__header">
        <Paperclip size={14} />
        <span>Файлы</span>
      </div>

      {isLoading && <div className="ts-corr-attachments__empty">Загрузка…</div>}
      {loadError instanceof Error && (
        <div className="ts-corr-attachments__error">{loadError.message}</div>
      )}

      {items.length > 0 && (
        <ul className="ts-corr-attachments__list">
          {items.map(item => (
            <li key={item.id} className="ts-corr-attachments__item">
              <FileText size={14} className="ts-corr-attachments__icon" />
              <span
                className="ts-corr-attachments__name"
                title={[item.original_name, formatSize(item.file_size), item.uploader_name].filter(Boolean).join(' · ')}
              >
                {displayFileName(item.original_name)}
              </span>
              <span className="ts-corr-attachments__meta">{formatSize(item.file_size)}</span>
              <button
                type="button"
                className="ts-corr-attachments__btn ts-day-files__icon-btn"
                onClick={() => setPreview(item)}
                title="Открыть файл"
                aria-label="Открыть файл"
              >
                <Eye size={16} />
              </button>
              <button
                type="button"
                className="ts-corr-attachments__btn ts-corr-attachments__btn--danger ts-day-files__icon-btn"
                onClick={() => handleDelete(item)}
                title="Удалить файл"
                aria-label="Удалить файл"
                disabled={deleteMutation.isPending}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="ts-corr-attachments__upload">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={e => handleFiles(e.target.files)}
          aria-label="Вложить файл"
        />
        <button
          type="button"
          className="ts-btn ts-day-files__add"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
        >
          <Upload size={14} /> {uploadMutation.isPending ? 'Загрузка…' : 'Вложить файл'}
        </button>
        {uploadError && <span className="ts-corr-attachments__error">{uploadError}</span>}
      </div>

      {preview && (
        <FilePreviewModal
          fileName={preview.original_name}
          mimeType={preview.mime_type}
          urlLoader={async (disposition) => (disposition === 'inline' ? preview.preview_url : preview.download_url)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
};
