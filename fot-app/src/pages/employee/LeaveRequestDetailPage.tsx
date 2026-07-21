import { type FC, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Clock, CheckCircle, XCircle, Ban, FileText, Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  getRequestDecision,
  type ILeaveRequest,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import { CancelRequestModal } from '../../components/dashboard/CancelRequestModal';
import { documentService, type IDocument } from '../../services/documentService';
import { getMyLeaveRequestsQueryKey } from '../../hooks/usePortalData';
import { useToast } from '../../contexts/ToastContext';
import { formatFioShort } from '../../utils/formatFio';
import { hasDiscreteDates } from '../../utils/leaveRequestDates';
import { displayFileName } from '../../utils/fileNameDisplay';
import { FilePreviewModal } from '../../components/documents/FilePreviewModal';
import './LeaveRequestsPage.css';

const STATUS_ICONS: Record<LeaveRequestStatus, FC<{ size?: number }>> = {
  pending: Clock,
  approved: CheckCircle,
  rejected: XCircle,
  cancelled: Ban,
};

const STATUS_COLORS: Record<LeaveRequestStatus, string> = {
  pending: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  cancelled: '#6b7280',
};

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
};

const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 МБ
const ACCEPT_ATTR = '.pdf,application/pdf,image/jpeg,image/png';

export const LeaveRequestDetailPage: FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const requestId = Number(id);

  const requestQuery = useQuery({
    queryKey: ['leave-request', requestId],
    queryFn: () => leaveRequestService.getById(requestId),
    enabled: !isNaN(requestId),
  });

  const attachmentsQuery = useQuery<IDocument[]>({
    queryKey: ['leave-request-attachments', requestId],
    queryFn: () => documentService.getByLeaveRequest(requestId).catch(() => []),
    enabled: !isNaN(requestId),
  });

  const request = requestQuery.data;
  const attachments = attachmentsQuery.data ?? [];
  const [previewDoc, setPreviewDoc] = useState<IDocument | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canEditAttachments = !!request && request.status === 'pending';

  const handleAddFiles = async (incoming: FileList | null) => {
    if (!incoming || !request) return;
    const valid: File[] = [];
    for (const file of Array.from(incoming)) {
      if (!ALLOWED_MIMES.includes(file.type)) { showToast('error', `${file.name}: разрешены только PDF, JPG, PNG`); continue; }
      if (file.size > MAX_FILE_SIZE) { showToast('error', `${file.name}: превышает 10 МБ`); continue; }
      valid.push(file);
    }
    if (valid.length === 0) return;
    setUploading(true);
    try {
      const results = await Promise.allSettled(
        valid.map(file => documentService.uploadFile(file, request.employee_id, 'leave_request_attachment', request.id)),
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      await queryClient.invalidateQueries({ queryKey: ['leave-request-attachments', requestId] });
      if (failed > 0) showToast('warning', `${failed} файл(ов) не загрузились`);
      else showToast('success', 'Файл добавлен');
    } catch {
      showToast('error', 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (doc: IDocument) => {
    if (!confirm(`Удалить файл «${displayFileName(doc.file_name)}»?`)) return;
    try {
      await documentService.remove(doc.id);
      await queryClient.invalidateQueries({ queryKey: ['leave-request-attachments', requestId] });
      showToast('success', 'Файл удалён');
    } catch {
      showToast('error', 'Не удалось удалить файл');
    }
  };

  const today = new Date().toLocaleDateString('en-CA');
  const isPast = request
    ? request.request_type === 'time_correction'
      ? !!request.correction_date && request.correction_date < today
      : request.end_date < today
    : false;
  const canCancel =
    !!request && (request.status === 'pending' || request.status === 'approved') && !isPast;

  const handleCancelled = async (updated: ILeaveRequest) => {
    setShowCancelModal(false);
    queryClient.setQueryData<ILeaveRequest | undefined>(
      ['leave-request', requestId],
      (prev) => (prev ? { ...prev, ...updated } : prev),
    );
    await queryClient.invalidateQueries({ queryKey: ['leave-request', requestId] });
    await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
    showToast('success', 'Заявка отменена');
  };

  const handleDownload = async (doc: IDocument) => {
    try {
      const { download_url, file_name } = await documentService.getDownloadUrl(doc.id);
      const a = document.createElement('a');
      a.href = download_url;
      a.download = file_name;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
    } catch {
      showToast('error', 'Не удалось получить ссылку на скачивание');
    }
  };

  if (requestQuery.isLoading) {
    return <div className="lr-page"><div className="lr-loading">Загрузка...</div></div>;
  }

  if (requestQuery.isError || !request) {
    return (
      <div className="lr-page">
        <button className="lr-back-btn" onClick={() => navigate('/employee/requests')}>
          <ArrowLeft size={16} /> К списку
        </button>
        <div className="lr-empty">Заявка не найдена</div>
      </div>
    );
  }

  const StatusIcon = STATUS_ICONS[request.status];
  const decision = getRequestDecision(request);

  return (
    <div className="lr-page">
      <button className="lr-back-btn" onClick={() => navigate('/employee/requests')}>
        <ArrowLeft size={16} /> К списку
      </button>

      <div className="lr-detail-header">
        <div>
          <h1 className="lr-title">{REQUEST_TYPE_LABELS[request.request_type]}</h1>
          <div className="lr-detail-dates">
            Подана: {formatDateTime(request.created_at)}
          </div>
        </div>
        <span className="lr-status-big" style={{ color: STATUS_COLORS[request.status] }}>
          <StatusIcon size={20} /> {decision.label}
        </span>
      </div>

      {(request.request_type === 'time_correction' || request.request_type === 'work')
        && request.correction_approval_status === 'pending' && (
          <div className="lr-card-pending-admin" style={{ color: '#f59e0b', marginTop: 12 }}>
            <Clock size={14} /> <strong>Ожидает согласования</strong>
          </div>
        )}

      <div className="lr-detail-grid">
        <section className="lr-detail-card">
          <h3>Период</h3>
          {request.request_type === 'time_correction' && request.correction_date ? (
            <div className="lr-detail-row">
              <span className="lr-detail-label">Дата</span>
              <span className="lr-detail-value">{formatDate(request.correction_date)}</span>
            </div>
          ) : hasDiscreteDates(request) ? (
            <div className="lr-detail-row lr-detail-row-col">
              <span className="lr-detail-label">Дни ({request.selected_dates!.length})</span>
              <div className="lr-detail-days-list">
                {request.selected_dates!.map(d => (
                  <span key={d} className="lr-detail-day-chip">{formatDate(d)}</span>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="lr-detail-row">
                <span className="lr-detail-label">С</span>
                <span className="lr-detail-value">{formatDate(request.start_date)}</span>
              </div>
              <div className="lr-detail-row">
                <span className="lr-detail-label">По</span>
                <span className="lr-detail-value">{formatDate(request.end_date)}</span>
              </div>
            </>
          )}
          {request.request_type === 'time_correction' && (
            <>
              <div className="lr-detail-row">
                <span className="lr-detail-label">Статус</span>
                <span className="lr-detail-value">{request.correction_status ?? '—'}</span>
              </div>
              {request.correction_hours != null && (
                <div className="lr-detail-row">
                  <span className="lr-detail-label">Часы</span>
                  <span className="lr-detail-value">{request.correction_hours}</span>
                </div>
              )}
            </>
          )}
          {request.reason && (
            <div className="lr-detail-row lr-detail-row-col">
              <span className="lr-detail-label">Причина / комментарий</span>
              <span className="lr-detail-value">{request.reason}</span>
            </div>
          )}
        </section>

        <section className="lr-detail-card">
          <h3>Прикреплённые файлы</h3>
          {attachmentsQuery.isLoading ? (
            <div className="lr-detail-empty">Загрузка...</div>
          ) : attachments.length === 0 ? (
            <div className="lr-detail-empty">Файлов нет</div>
          ) : (
            <div className="lr-attachments">
              {attachments.map(doc => {
                const isImage = doc.mime_type.startsWith('image/');
                const Icon = isImage ? ImageIcon : FileText;
                return (
                  <div
                    key={doc.id}
                    className="lr-attachment lr-attachment-clickable"
                    onClick={() => setPreviewDoc(doc)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreviewDoc(doc); } }}
                    title="Открыть предпросмотр"
                  >
                    <Icon size={18} />
                    <div className="lr-attachment-info">
                      <div className="lr-attachment-name" title={doc.file_name}>{displayFileName(doc.file_name)}</div>
                      <div className="lr-attachment-meta">{formatBytes(doc.file_size)}</div>
                    </div>
                    <button
                      className="lr-attachment-download"
                      onClick={e => { e.stopPropagation(); handleDownload(doc); }}
                      aria-label="Скачать"
                    >
                      <Download size={16} />
                    </button>
                    {canEditAttachments && (
                      <button
                        className="lr-attachment-download"
                        onClick={e => { e.stopPropagation(); handleDelete(doc); }}
                        aria-label="Удалить"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {canEditAttachments && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTR}
                style={{ display: 'none' }}
                onChange={e => { handleAddFiles(e.target.files); e.target.value = ''; }}
              />
              <button
                type="button"
                className="lr-attachment-add"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                <Plus size={16} /> {uploading ? 'Загрузка...' : 'Добавить файл'}
              </button>
            </>
          )}
        </section>

        <section className="lr-detail-card">
          <h3>Решение / отмена</h3>
          {request.status === 'pending' ? (
            <div className="lr-detail-empty">Ожидает рассмотрения</div>
          ) : !decision.actor && !decision.at && !decision.comment ? (
            <div className="lr-detail-empty">{decision.label}</div>
          ) : (
            <>
              <div className="lr-detail-row">
                <span className="lr-detail-label">Статус</span>
                <span className="lr-detail-value">{decision.label}</span>
              </div>
              {decision.actor && (
                <div className="lr-detail-row">
                  <span className="lr-detail-label">
                    {request.status === 'cancelled' ? 'Отменил' : 'Рассмотрел'}
                  </span>
                  <span className="lr-detail-value">{formatFioShort(decision.actor) || '—'}</span>
                </div>
              )}
              {decision.at && (
                <div className="lr-detail-row">
                  <span className="lr-detail-label">Дата</span>
                  <span className="lr-detail-value">{formatDateTime(decision.at)}</span>
                </div>
              )}
              {decision.comment && (
                <div className="lr-detail-row lr-detail-row-col">
                  <span className="lr-detail-label">
                    {request.status === 'cancelled' ? 'Причина' : 'Комментарий'}
                  </span>
                  <span className="lr-detail-value">{decision.comment}</span>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {canCancel && (
        <div className="lr-detail-actions">
          <button className="lr-cancel-btn" onClick={() => setShowCancelModal(true)}>
            Отменить заявку
          </button>
        </div>
      )}

      {showCancelModal && (
        <CancelRequestModal
          request={request}
          onClose={() => setShowCancelModal(false)}
          onCancelled={handleCancelled}
        />
      )}

      {previewDoc && (
        <FilePreviewModal
          documentId={previewDoc.id}
          fileName={previewDoc.file_name}
          mimeType={previewDoc.mime_type}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </div>
  );
};
