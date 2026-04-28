import { type FC, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, X, Clock, CheckCircle, XCircle, Ban, ChevronRight, Paperclip } from 'lucide-react';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  type ILeaveRequest,
  type LeaveRequestType,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import { documentService } from '../../services/documentService';
import { useAuth } from '../../contexts/AuthContext';
import { getMyLeaveRequestsQueryKey, useMyLeaveRequests } from '../../hooks/usePortalData';
import './LeaveRequestsPage.css';

const ATTACHMENT_REQUIRED_TYPES = new Set<LeaveRequestType>(['remote', 'vacation']);

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

const REQUEST_TYPES: LeaveRequestType[] = ['vacation', 'sick_leave', 'remote', 'certificate', 'time_correction'];
const EMPTY_REQUESTS: ILeaveRequest[] = [];

export const LeaveRequestsPage: FC = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const employeeId = profile?.employee_id ?? null;
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { data, isLoading } = useMyLeaveRequests();
  const requests = data ?? EMPTY_REQUESTS;

  // Form state
  const [formType, setFormType] = useState<LeaveRequestType>('vacation');
  const [formStart, setFormStart] = useState('');
  const [formEnd, setFormEnd] = useState('');
  const [formReason, setFormReason] = useState('');
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Correction-specific fields
  const [correctionDate, setCorrectionDate] = useState('');
  const [correctionStatus, setCorrectionStatus] = useState('work');
  const [correctionHours, setCorrectionHours] = useState<number>(8);

  const isCorrection = formType === 'time_correction';
  const requireAttachment = ATTACHMENT_REQUIRED_TYPES.has(formType);

  const resetForm = () => {
    setShowForm(false);
    setFormType('vacation');
    setFormStart('');
    setFormEnd('');
    setFormReason('');
    setCorrectionDate('');
    setCorrectionStatus('work');
    setCorrectionHours(8);
    setAttachmentFile(null);
    setFormError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    if (isCorrection) {
      if (!correctionDate) return;
    } else {
      if (!formStart || !formEnd) return;
    }
    if (requireAttachment && !attachmentFile) {
      setFormError('Прикрепите файл-подтверждение');
      return;
    }
    if (requireAttachment && !employeeId) {
      setFormError('Не удалось определить сотрудника. Перезайдите в систему.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      let attachmentIds: number[] | undefined;
      if (attachmentFile && employeeId) {
        const uploaded = await documentService.uploadFile(attachmentFile, employeeId, 'leave_request_attachment');
        attachmentIds = [uploaded.id];
      }
      const payload: Record<string, unknown> = {
        request_type: formType,
        start_date: isCorrection ? correctionDate : formStart,
        end_date: isCorrection ? correctionDate : formEnd,
        reason: formReason || undefined,
      };
      if (isCorrection) {
        payload.correction_date = correctionDate;
        payload.correction_status = correctionStatus;
        payload.correction_hours = correctionHours;
      }
      if (attachmentIds) {
        payload.attachments = attachmentIds;
      }
      await leaveRequestService.create(payload as Parameters<typeof leaveRequestService.create>[0]);
      resetForm();
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
    } catch (err) {
      console.error('Create leave request error:', err);
      setFormError(err instanceof Error ? err.message : 'Ошибка создания заявления');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (id: number) => {
    try {
      await leaveRequestService.cancel(id);
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
    } catch (err) {
      console.error('Cancel leave request error:', err);
    }
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return (
    <div className="lr-page">
      <div className="lr-header">
        <h1 className="lr-title">Мои заявления</h1>
        <button className="lr-create-btn" onClick={() => setShowForm(true)}>
          <Plus size={16} /> Создать
        </button>
      </div>

      {showForm && (
        <div className="lr-form-card">
          <div className="lr-form-header">
            <h3>Новое заявление</h3>
            <button className="lr-form-close" onClick={() => setShowForm(false)}><X size={18} /></button>
          </div>
          <div className="lr-form-body">
            <label className="lr-form-label">
              Тип
              <select className="lr-form-select" value={formType} onChange={e => setFormType(e.target.value as LeaveRequestType)}>
                {REQUEST_TYPES.map(t => (
                  <option key={t} value={t}>{REQUEST_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
            {isCorrection ? (
              <>
                <label className="lr-form-label">
                  Дата корректировки
                  <input type="date" className="lr-form-input" value={correctionDate} onChange={e => setCorrectionDate(e.target.value)} />
                </label>
                <div className="lr-form-row">
                  <label className="lr-form-label">
                    Статус
                    <select className="lr-form-select" value={correctionStatus} onChange={e => setCorrectionStatus(e.target.value)}>
                      <option value="work">Присутствие</option>
                      <option value="remote">Удалёнка</option>
                      <option value="sick">Больничный</option>
                      <option value="vacation">Отпуск</option>
                    </select>
                  </label>
                  <label className="lr-form-label">
                    Часы
                    <input type="number" className="lr-form-input" value={correctionHours} onChange={e => setCorrectionHours(parseFloat(e.target.value) || 0)} min={0} max={24} step={0.5} />
                  </label>
                </div>
              </>
            ) : (
              <div className="lr-form-row">
                <label className="lr-form-label">
                  С
                  <input type="date" className="lr-form-input" value={formStart} onChange={e => setFormStart(e.target.value)} />
                </label>
                <label className="lr-form-label">
                  По
                  <input type="date" className="lr-form-input" value={formEnd} onChange={e => setFormEnd(e.target.value)} />
                </label>
              </div>
            )}
            <label className="lr-form-label">
              Причина / комментарий
              <textarea className="lr-form-textarea" value={formReason} onChange={e => setFormReason(e.target.value)} placeholder={isCorrection ? 'Укажите причину корректировки' : 'Необязательно'} />
            </label>
            <label className="lr-form-label">
              Файл {requireAttachment && <span style={{ color: 'var(--error, #ef4444)' }}>*</span>}
              <input
                ref={fileInputRef}
                type="file"
                className="lr-form-input"
                onChange={e => setAttachmentFile(e.target.files?.[0] || null)}
                accept="image/*,application/pdf"
              />
              {attachmentFile && (
                <div className="lr-attachment-preview">
                  <Paperclip size={14} /> {attachmentFile.name}
                </div>
              )}
              {requireAttachment && !attachmentFile && (
                <div className="lr-form-hint">Для удалёнки и корректировки табеля файл обязателен</div>
              )}
            </label>
            {formError && <div className="lr-form-error">{formError}</div>}
            <button
              className="lr-submit-btn"
              onClick={handleSubmit}
              disabled={
                saving
                || (isCorrection ? !correctionDate : (!formStart || !formEnd))
                || (requireAttachment && !attachmentFile)
              }
            >
              {saving ? 'Отправка...' : 'Отправить'}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="lr-loading">Загрузка...</div>
      ) : requests.length === 0 ? (
        <div className="lr-empty">Нет заявлений</div>
      ) : (
        <div className="lr-list">
          {requests.map(r => {
            const Icon = STATUS_ICONS[r.status];
            const handleCardClick = (e: React.MouseEvent) => {
              if ((e.target as HTMLElement).closest('button')) return;
              navigate(`/employee/requests/${r.id}`);
            };
            return (
              <div
                key={r.id}
                className="lr-card lr-card-clickable"
                onClick={handleCardClick}
                role="button"
                tabIndex={0}
              >
                <div className="lr-card-left">
                  <div className="lr-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>
                  {r.request_type === 'time_correction' && r.correction_date ? (
                    <div className="lr-card-dates">Дата: {formatDate(r.correction_date)} · Статус: {r.correction_status} · {r.correction_hours != null ? `${r.correction_hours}ч` : ''}</div>
                  ) : (
                    <div className="lr-card-dates">{formatDate(r.start_date)} — {formatDate(r.end_date)}</div>
                  )}
                  {r.reason && <div className="lr-card-reason">{r.reason}</div>}
                  {r.review_comment && <div className="lr-card-comment">Комментарий: {r.review_comment}</div>}
                </div>
                <div className="lr-card-right">
                  <span className="lr-status" style={{ color: STATUS_COLORS[r.status] }}>
                    <Icon size={16} /> {STATUS_LABELS[r.status]}
                  </span>
                  {r.status === 'pending' && (
                    <button className="lr-cancel-btn" onClick={() => handleCancel(r.id)}>Отменить</button>
                  )}
                  <ChevronRight size={18} className="lr-card-chevron" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
