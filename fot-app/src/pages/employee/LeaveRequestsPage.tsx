import { type FC, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, X, Clock, CheckCircle, XCircle, Ban } from 'lucide-react';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  type ILeaveRequest,
  type LeaveRequestType,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import { getMyLeaveRequestsQueryKey, useMyLeaveRequests } from '../../hooks/usePortalData';
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

const REQUEST_TYPES = Object.keys(REQUEST_TYPE_LABELS) as LeaveRequestType[];
const EMPTY_REQUESTS: ILeaveRequest[] = [];

export const LeaveRequestsPage: FC = () => {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data, isLoading } = useMyLeaveRequests();
  const requests = data ?? EMPTY_REQUESTS;

  // Form state
  const [formType, setFormType] = useState<LeaveRequestType>('vacation');
  const [formStart, setFormStart] = useState('');
  const [formEnd, setFormEnd] = useState('');
  const [formReason, setFormReason] = useState('');
  // Correction-specific fields
  const [correctionDate, setCorrectionDate] = useState('');
  const [correctionStatus, setCorrectionStatus] = useState('work');
  const [correctionHours, setCorrectionHours] = useState<number>(8);

  const isCorrection = formType === 'time_correction';

  const handleSubmit = async () => {
    if (isCorrection) {
      if (!correctionDate) return;
    } else {
      if (!formStart || !formEnd) return;
    }
    setSaving(true);
    try {
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
      await leaveRequestService.create(payload as Parameters<typeof leaveRequestService.create>[0]);
      setShowForm(false);
      setFormType('vacation');
      setFormStart('');
      setFormEnd('');
      setFormReason('');
      setCorrectionDate('');
      setCorrectionStatus('work');
      setCorrectionHours(8);
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
    } catch (err) {
      console.error('Create leave request error:', err);
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
                      <option value="business_trip">Командировка</option>
                      <option value="manual">Ручная корр.</option>
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
            <button className="lr-submit-btn" onClick={handleSubmit} disabled={saving || (isCorrection ? !correctionDate : (!formStart || !formEnd))}>
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
            return (
              <div key={r.id} className="lr-card">
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
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
