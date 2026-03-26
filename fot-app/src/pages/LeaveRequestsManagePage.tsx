import { type FC, useState, useEffect, useCallback } from 'react';
import { Check, X, Clock, CheckCircle, XCircle, Ban } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  type ILeaveRequest,
  type LeaveRequestStatus,
} from '../services/leaveRequestService';
import { employeeService } from '../services/employeeService';
import type { Employee } from '../types';
import './LeaveRequestsManagePage.css';

const STATUS_COLORS: Record<LeaveRequestStatus, string> = {
  pending: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  cancelled: '#6b7280',
};

const STATUS_ICONS: Record<LeaveRequestStatus, FC<{ size?: number }>> = {
  pending: Clock,
  approved: CheckCircle,
  rejected: XCircle,
  cancelled: Ban,
};

export const LeaveRequestsManagePage: FC = () => {
  const { positionType } = useAuth();
  const isHeader = positionType === 'header';

  const [requests, setRequests] = useState<ILeaveRequest[]>([]);
  const [employeeMap, setEmployeeMap] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [commentId, setCommentId] = useState<number | null>(null);
  const [comment, setComment] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = isHeader
        ? await leaveRequestService.getDepartment()
        : await leaveRequestService.getAll(filter === 'pending' ? 'pending' : undefined);
      setRequests(data);

      // Загружаем имена сотрудников
      const empIds = [...new Set(data.map(r => r.employee_id))];
      const map = new Map<number, string>();
      for (const id of empIds) {
        try {
          const emp = await employeeService.getById(id);
          map.set(id, emp.full_name);
        } catch {
          map.set(id, `Сотрудник #${id}`);
        }
      }
      setEmployeeMap(map);
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [isHeader, filter]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleApprove = async (id: number) => {
    try {
      await leaveRequestService.approve(id, comment || undefined);
      setCommentId(null);
      setComment('');
      await loadData();
    } catch (err) {
      console.error('Approve error:', err);
    }
  };

  const handleReject = async (id: number) => {
    try {
      await leaveRequestService.reject(id, comment || undefined);
      setCommentId(null);
      setComment('');
      await loadData();
    } catch (err) {
      console.error('Reject error:', err);
    }
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const filteredRequests = filter === 'pending' && isHeader
    ? requests.filter(r => r.status === 'pending')
    : requests;

  return (
    <div className="lrm-page">
      <div className="lrm-header">
        <h1 className="lrm-title">Заявления</h1>
        <div className="lrm-filter">
          <button className={`lrm-filter-btn ${filter === 'pending' ? 'active' : ''}`} onClick={() => setFilter('pending')}>
            Ожидающие
          </button>
          <button className={`lrm-filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            Все
          </button>
        </div>
      </div>

      {loading ? (
        <div className="lrm-loading">Загрузка...</div>
      ) : filteredRequests.length === 0 ? (
        <div className="lrm-empty">Нет заявлений</div>
      ) : (
        <div className="lrm-list">
          {filteredRequests.map(r => {
            const Icon = STATUS_ICONS[r.status];
            return (
              <div key={r.id} className="lrm-card">
                <div className="lrm-card-main">
                  <div className="lrm-card-top">
                    <span className="lrm-card-employee">{employeeMap.get(r.employee_id) || `#${r.employee_id}`}</span>
                    <span className="lrm-status" style={{ color: STATUS_COLORS[r.status] }}>
                      <Icon size={14} /> {STATUS_LABELS[r.status]}
                    </span>
                  </div>
                  <div className="lrm-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>
                  <div className="lrm-card-dates">{formatDate(r.start_date)} — {formatDate(r.end_date)}</div>
                  {r.reason && <div className="lrm-card-reason">{r.reason}</div>}
                  {r.review_comment && <div className="lrm-card-comment">Комментарий: {r.review_comment}</div>}
                </div>

                {r.status === 'pending' && (
                  <div className="lrm-card-actions">
                    {commentId === r.id ? (
                      <div className="lrm-comment-form">
                        <input
                          className="lrm-comment-input"
                          placeholder="Комментарий (необязательно)"
                          value={comment}
                          onChange={e => setComment(e.target.value)}
                        />
                        <div className="lrm-comment-btns">
                          <button className="lrm-action-btn approve" onClick={() => handleApprove(r.id)}>
                            <Check size={14} /> Одобрить
                          </button>
                          <button className="lrm-action-btn reject" onClick={() => handleReject(r.id)}>
                            <X size={14} /> Отклонить
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="lrm-action-row">
                        <button className="lrm-action-btn approve" onClick={() => handleApprove(r.id)}>
                          <Check size={14} /> Одобрить
                        </button>
                        <button className="lrm-action-btn reject" onClick={() => setCommentId(r.id)}>
                          <X size={14} /> Отклонить
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
