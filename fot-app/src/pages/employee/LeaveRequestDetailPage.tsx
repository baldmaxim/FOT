import { type FC } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Clock, CheckCircle, XCircle, Ban, FileText, Image as ImageIcon } from 'lucide-react';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import { documentService, type IDocument } from '../../services/documentService';
import { getMyLeaveRequestsQueryKey } from '../../hooks/usePortalData';
import { useToast } from '../../contexts/ToastContext';
import { formatFioShort } from '../../utils/formatFio';
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

  const handleCancel = async () => {
    if (!request) return;
    if (!confirm('Отменить заявку?')) return;
    try {
      await leaveRequestService.cancel(request.id);
      await queryClient.invalidateQueries({ queryKey: ['leave-request', requestId] });
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
      showToast('success', 'Заявка отменена');
    } catch {
      showToast('error', 'Не удалось отменить заявку');
    }
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
          <StatusIcon size={20} /> {STATUS_LABELS[request.status]}
        </span>
      </div>

      <div className="lr-detail-grid">
        <section className="lr-detail-card">
          <h3>Период</h3>
          {request.request_type === 'time_correction' && request.correction_date ? (
            <div className="lr-detail-row">
              <span className="lr-detail-label">Дата</span>
              <span className="lr-detail-value">{formatDate(request.correction_date)}</span>
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
                  <div key={doc.id} className="lr-attachment">
                    <Icon size={18} />
                    <div className="lr-attachment-info">
                      <div className="lr-attachment-name">{doc.file_name}</div>
                      <div className="lr-attachment-meta">{formatBytes(doc.file_size)}</div>
                    </div>
                    <button
                      className="lr-attachment-download"
                      onClick={() => handleDownload(doc)}
                      aria-label="Скачать"
                    >
                      <Download size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="lr-detail-card">
          <h3>Решение руководителя</h3>
          {request.status === 'pending' ? (
            <div className="lr-detail-empty">Ожидает рассмотрения</div>
          ) : request.status === 'cancelled' ? (
            <div className="lr-detail-empty">Отменена автором</div>
          ) : (
            <>
              {request.reviewer && (
                <div className="lr-detail-row">
                  <span className="lr-detail-label">Рассмотрел</span>
                  <span className="lr-detail-value">{formatFioShort(request.reviewer.full_name) || '—'}</span>
                </div>
              )}
              {request.reviewed_at && (
                <div className="lr-detail-row">
                  <span className="lr-detail-label">Дата</span>
                  <span className="lr-detail-value">{formatDateTime(request.reviewed_at)}</span>
                </div>
              )}
              {request.review_comment && (
                <div className="lr-detail-row lr-detail-row-col">
                  <span className="lr-detail-label">Комментарий</span>
                  <span className="lr-detail-value">{request.review_comment}</span>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {request.status === 'pending' && (
        <div className="lr-detail-actions">
          <button className="lr-cancel-btn" onClick={handleCancel}>
            Отменить заявку
          </button>
        </div>
      )}
    </div>
  );
};
