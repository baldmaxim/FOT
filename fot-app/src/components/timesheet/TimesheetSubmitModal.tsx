import { type FC, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Upload, Trash2, FileText, Send, Loader2, AlertCircle } from 'lucide-react';
import { timesheetApprovalService, type IApprovalAttachment } from '../../services/timesheetApprovalService';

interface IProps {
  open: boolean;
  departmentId: string;
  startDate: string;
  endDate: string;
  onClose: () => void;
  onSubmitted: () => void;
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};

export const TimesheetSubmitModal: FC<IProps> = ({
  open,
  departmentId,
  startDate,
  endDate,
  onClose,
  onSubmitted,
}) => {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [weekendWorkDates, setWeekendWorkDates] = useState<string[]>([]);

  const attachmentsQuery = useQuery({
    queryKey: ['timesheet-approval-attachments', departmentId, startDate, endDate],
    queryFn: () => timesheetApprovalService.listAttachments({
      department_id: departmentId,
      start_date: startDate,
      end_date: endDate,
    }),
    enabled: open,
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => timesheetApprovalService.uploadAttachment({
      department_id: departmentId,
      start_date: startDate,
      end_date: endDate,
      file,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timesheet-approval-attachments', departmentId, startDate, endDate] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: number) => timesheetApprovalService.deleteAttachment(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timesheet-approval-attachments', departmentId, startDate, endDate] });
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => timesheetApprovalService.submit(departmentId, startDate, endDate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] });
      queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] });
      queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
      onSubmitted();
    },
    onError: (err: unknown) => {
      const errObj = err as { message?: string; status?: number; code?: string };
      if (errObj?.code === 'WEEKEND_CONFIRMATION_REQUIRED') {
        setWeekendWorkDates([]);
      }
      setSubmitError(errObj?.message || 'Ошибка подачи табеля');
    },
  });

  if (!open) return null;

  const attachments: IApprovalAttachment[] = attachmentsQuery.data ?? [];

  const handleChooseFile = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await uploadMutation.mutateAsync(file);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async () => {
    setSubmitError(null);
    setWeekendWorkDates([]);
    await submitMutation.mutateAsync();
  };

  const submitting = submitMutation.isPending;
  const loadingAttachments = attachmentsQuery.isLoading;
  const hasAttachments = attachments.length > 0;

  return (
    <div className="ts-modal-overlay ts-modal-overlay--open" onClick={onClose}>
      <div className="ts-modal ts-submit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ts-modal-header">
          <h3>Подача табеля</h3>
          <button type="button" className="ts-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="ts-modal-body">
          <p className="ts-submit-period">Период: {startDate} — {endDate}</p>
          <p className="ts-submit-hint">
            Если в периоде есть работа в выходные дни — прикрепите подтверждающий документ (приказ, служебная записка).
          </p>

          <div className="ts-submit-attachments">
            <div className="ts-submit-attachments-header">
              <strong>Подтверждающие документы</strong>
              <button
                type="button"
                className="ts-btn ts-btn--chip"
                onClick={handleChooseFile}
                disabled={uploadMutation.isPending}
              >
                {uploadMutation.isPending ? <Loader2 size={14} className="ts-refresh-spinning" /> : <Upload size={14} />}
                {uploadMutation.isPending ? 'Загрузка…' : 'Добавить файл'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                accept="application/pdf,image/png,image/jpeg"
                onChange={handleFileChange}
              />
            </div>

            {loadingAttachments ? (
              <div className="ts-submit-attachments-empty">Загрузка…</div>
            ) : attachments.length === 0 ? (
              <div className="ts-submit-attachments-empty">Файлы ещё не загружены</div>
            ) : (
              <ul className="ts-submit-attachments-list">
                {attachments.map(att => (
                  <li key={att.document_id} className="ts-submit-attachment-item">
                    <FileText size={14} />
                    <span className="ts-submit-attachment-name">{att.file_name}</span>
                    <span className="ts-submit-attachment-size">{formatSize(att.file_size)}</span>
                    <button
                      type="button"
                      className="ts-corrections-btn ts-corrections-btn--danger"
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate(att.document_id)}
                      title="Удалить"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {submitError && (
            <div className="ts-submit-error">
              <AlertCircle size={14} />
              <span>{submitError}</span>
            </div>
          )}

          {weekendWorkDates.length > 0 && (
            <div className="ts-submit-weekend-info">
              <strong>Выходные с фактом работы:</strong> {weekendWorkDates.join(', ')}
            </div>
          )}
        </div>

        <div className="ts-modal-footer">
          <button type="button" className="ts-btn" onClick={onClose} disabled={submitting}>
            Отмена
          </button>
          <button
            type="button"
            className="ts-btn ts-btn--primary"
            onClick={handleSubmit}
            disabled={submitting || (weekendWorkDates.length > 0 && !hasAttachments)}
          >
            {submitting ? <Loader2 size={14} className="ts-refresh-spinning" /> : <Send size={14} />}
            {submitting ? 'Отправка…' : 'Подать'}
          </button>
        </div>
      </div>
    </div>
  );
};
