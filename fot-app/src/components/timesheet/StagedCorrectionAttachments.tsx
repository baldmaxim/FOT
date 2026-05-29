import { type FC, useRef, useState } from 'react';
import { Paperclip, Trash2, Upload, FileText } from 'lucide-react';

interface IProps {
  /** Выбранные, но ещё не загруженные файлы (корректировка создаётся при «Сохранить»). */
  files: File[];
  onChange: (files: File[]) => void;
}

const MAX_BYTES = 25 * 1024 * 1024;

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
};

/**
 * Picker файлов для формы СОЗДАНИЯ корректировки: складывает File[] локально,
 * без обращения к API (adjustment_id ещё нет). Загрузка — после создания
 * корректировки в родителе через correctionAttachmentsService.upload.
 */
export const StagedCorrectionAttachments: FC<IProps> = ({ files, onChange }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const accepted: File[] = [];
    for (const file of Array.from(list)) {
      if (file.size > MAX_BYTES) {
        setError(`Файл «${file.name}» больше 25 МБ`);
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) {
      setError(null);
      onChange([...files, ...accepted]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemove = (index: number) => {
    onChange(files.filter((_, i) => i !== index));
  };

  return (
    <div className="ts-corr-attachments ts-corr-attachments--modal">
      <div className="ts-corr-attachments__header">
        <Paperclip size={14} />
        <span>Файлы корректировки</span>
      </div>

      {files.length > 0 && (
        <ul className="ts-corr-attachments__list">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="ts-corr-attachments__item">
              <FileText size={14} className="ts-corr-attachments__icon" />
              <span
                className="ts-corr-attachments__name"
                title={`${file.name} · ${formatSize(file.size)}`}
              >
                {file.name}
              </span>
              <span className="ts-corr-attachments__meta">{formatSize(file.size)}</span>
              <button
                type="button"
                className="ts-corr-attachments__btn ts-corr-attachments__btn--danger"
                onClick={() => handleRemove(index)}
                title="Убрать файл"
                aria-label="Убрать файл"
              >
                <Trash2 size={14} />
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
          onChange={e => handleFiles(e.target.files)}
          aria-label="Прикрепить файлы"
        />
        <button
          type="button"
          className="ts-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={14} /> Прикрепить
        </button>
        {error && <span className="ts-corr-attachments__error">{error}</span>}
      </div>
    </div>
  );
};
