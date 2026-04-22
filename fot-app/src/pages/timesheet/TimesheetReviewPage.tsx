import { type FC, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, Clock, CheckCircle, XCircle, RotateCcw, History } from 'lucide-react';
import { Tabs } from '../../components/ui/Tabs';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  APPROVAL_STATUS_LABELS,
  timesheetApprovalService,
  type ITimesheetApproval,
  type ITimesheetApprovalEvent,
  type TimesheetApprovalStatus,
} from '../../services/timesheetApprovalService';
import { useStructureTree } from '../../hooks/useStructure';
import { useTimesheetApprovalHistory, useTimesheetApprovalReviewList } from '../../hooks/useTimesheetApprovalData';
import { formatTimesheetRangeLabel } from '../../utils/timesheetApprovalPeriod';
import './TimesheetReviewPage.css';

interface IDeptMap { [id: string]: string }

type CommentMode = 'review' | 'return' | null;

const TAB_STATUSES = ['submitted', 'approved', 'rejected'] as const;
const TAB_LABELS = ['На проверке', 'Утверждённые', 'Отклонённые'];
const EMPTY_MESSAGES = ['Нет табелей на проверке', 'Нет утверждённых табелей', 'Нет отклонённых или возвращённых табелей'];
const HISTORY_ACTION_LABELS: Record<ITimesheetApprovalEvent['action'], string> = {
  submitted: 'Подан',
  approved: 'Утверждён',
  rejected: 'Отклонён',
  returned_to_rework: 'Возвращён на доработку',
};

const getVisualStatus = (status: TimesheetApprovalStatus): 'submitted' | 'approved' | 'rejected' | 'returned' => {
  if (status === 'approved' || status === 'rejected' || status === 'returned') {
    return status;
  }
  return 'submitted';
};

const formatDateTime = (value: string): string => new Date(value).toLocaleString('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const formatActorLine = (event: ITimesheetApprovalEvent): string => {
  const name = event.actor_full_name || event.actor_user_id;
  if (event.actor_position_name) {
    return `${name} • ${event.actor_position_name}`;
  }
  return name;
};

const getDecisionMeta = (status: ITimesheetApproval['status']) => {
  if (status === 'approved') {
    return {
      icon: CheckCircle,
      label: 'Утверждён',
    };
  }

  if (status === 'returned') {
    return {
      icon: RotateCcw,
      label: 'Возвращён на доработку',
    };
  }

  return {
    icon: XCircle,
    label: 'Отклонён',
  };
};

const ApprovalHistorySection: FC<{ approvalId: number }> = ({ approvalId }) => {
  const [opened, setOpened] = useState(false);
  const historyQuery = useTimesheetApprovalHistory(approvalId, opened);
  const events = historyQuery.data ?? [];

  return (
    <details
      className="tsr-history"
      onToggle={event => setOpened((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="tsr-history-summary">
        <span className="tsr-history-summary-icon">
          <History size={14} />
        </span>
        История согласования
      </summary>

      <div className="tsr-history-body">
        {historyQuery.isLoading ? (
          <div className="tsr-history-empty">Загрузка истории...</div>
        ) : events.length === 0 ? (
          <div className="tsr-history-empty">История пока пуста</div>
        ) : (
          <div className="tsr-history-list">
            {events.map(event => (
              <div key={event.id} className="tsr-history-item">
                <div className="tsr-history-item-head">
                  <span className="tsr-history-item-badge">{HISTORY_ACTION_LABELS[event.action]}</span>
                  <span className="tsr-history-item-date">{formatDateTime(event.created_at)}</span>
                </div>
                <div className="tsr-history-item-text">
                  {formatActorLine(event)}
                </div>
                {event.comment && (
                  <div className="tsr-history-item-comment">
                    {event.comment}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
};

export const TimesheetReviewPage: FC = () => {
  const { hasPermission } = useAuth();
  const [commentId, setCommentId] = useState<number | null>(null);
  const [commentMode, setCommentMode] = useState<CommentMode>(null);
  const [comment, setComment] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();
  const canReviewTimesheets = hasPermission('timesheet.workflow.review');
  const canMonitorTimesheets = canReviewTimesheets || hasPermission('timesheet.workflow.monitor');
  const status = TAB_STATUSES[activeTab];
  const approvalsQuery = useTimesheetApprovalReviewList(status, canMonitorTimesheets);
  const approvals: ITimesheetApproval[] = approvalsQuery.data ?? [];
  const structureQuery = useStructureTree();
  const deptMap = useMemo<IDeptMap>(() => {
    const map: IDeptMap = {};
    const flatten = (nodes: Array<{ id: string; name: string; children?: unknown[] }>) => {
      for (const node of nodes) {
        map[node.id] = node.name;
        if (Array.isArray(node.children)) {
          flatten(node.children as Array<{ id: string; name: string; children?: unknown[] }>);
        }
      }
    };
    flatten(structureQuery.data?.departments ?? []);
    return map;
  }, [structureQuery.data]);
  const loading = approvalsQuery.isLoading || structureQuery.isLoading;
  const isSubmittedTab = activeTab === 0;
  const isApprovedTab = activeTab === 1;

  const resetCommentForm = () => {
    setCommentId(null);
    setCommentMode(null);
    setComment('');
  };

  const openCommentForm = (id: number, mode: CommentMode) => {
    setCommentId(id);
    setCommentMode(mode);
    setComment('');
  };

  const refreshData = async () => {
    await queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] });
  };

  const runAction = async (
    id: number,
    action: () => Promise<unknown>,
    successMessage: string,
    fallbackMessage: string,
  ) => {
    setProcessingId(id);
    try {
      await action();
      toast.success(successMessage);
      resetCommentForm();
      await refreshData();
    } catch (error) {
      console.error(fallbackMessage, error);
      toast.error(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setProcessingId(null);
    }
  };

  const handleApprove = async (id: number) => {
    const effectiveComment = commentId === id && commentMode === 'review' ? comment || undefined : undefined;
    await runAction(
      id,
      () => timesheetApprovalService.approve(id, effectiveComment),
      'Табель утверждён',
      'Не удалось утвердить табель',
    );
  };

  const handleReject = async (id: number) => {
    const effectiveComment = commentId === id && commentMode === 'review' ? comment || undefined : undefined;
    await runAction(
      id,
      () => timesheetApprovalService.reject(id, effectiveComment),
      'Табель отклонён',
      'Не удалось отклонить табель',
    );
  };

  const handleReturnToRework = async (id: number) => {
    const effectiveComment = commentId === id && commentMode === 'return' ? comment || undefined : undefined;
    await runAction(
      id,
      () => timesheetApprovalService.returnToRework(id, effectiveComment),
      'Табель возвращён на доработку',
      'Не удалось вернуть табель на доработку',
    );
  };

  const handleTabChange = (index: number) => {
    setActiveTab(index);
    resetCommentForm();
  };

  return (
    <div className="tsr-page">
      {!canMonitorTimesheets ? (
        <div className="tsr-empty">Для этой роли не включён мониторинг табелей.</div>
      ) : (
        <>
      <div className="tsr-toolbar">
        <div className="tsr-tabs">
          <Tabs tabs={TAB_LABELS} activeTab={activeTab} onTabChange={handleTabChange} />
        </div>
        <div className={`tsr-summary-badge tsr-summary-badge--${status}`}>
          Всего {approvals.length}
        </div>
      </div>

      {loading ? (
        <div className="tsr-loading">Загрузка...</div>
      ) : approvals.length === 0 ? (
        <div className="tsr-empty">{EMPTY_MESSAGES[activeTab]}</div>
      ) : (
        <div className="tsr-list">
          {approvals.map(approval => {
            const visualStatus = getVisualStatus(approval.status);
            const decisionMeta = getDecisionMeta(approval.status);
            const DecisionIcon = decisionMeta.icon;
            const commentFormOpened = commentId === approval.id && !!commentMode;
            const isProcessing = processingId === approval.id;

            return (
              <div key={approval.id} className={`tsr-card ${!isSubmittedTab ? `tsr-card--${visualStatus}` : ''}`}>
                <div className="tsr-card-info">
                  <div className="tsr-card-head">
                    <div className="tsr-card-dept">{deptMap[approval.department_id] || approval.department_id}</div>
                    <span className={`tsr-card-badge tsr-card-badge--${visualStatus}`}>
                      {APPROVAL_STATUS_LABELS[approval.status]}
                    </span>
                  </div>

                  <div className="tsr-card-meta">
                    <div className="tsr-card-period">
                      <Clock size={14} /> {formatTimesheetRangeLabel(approval.start_date, approval.end_date)}
                    </div>
                    {isSubmittedTab && approval.submitted_at && (
                      <div className="tsr-card-date">
                        Подан: {formatDateTime(approval.submitted_at)}
                      </div>
                    )}
                    {!isSubmittedTab && approval.reviewed_at && (
                      <div className="tsr-card-date">
                        <DecisionIcon size={12} />
                        {decisionMeta.label}: {formatDateTime(approval.reviewed_at)}
                      </div>
                    )}
                  </div>

                  {!isSubmittedTab && approval.review_comment && (
                    <div className="tsr-card-comment">
                      {approval.review_comment}
                    </div>
                  )}

                  <ApprovalHistorySection approvalId={approval.id} />
                </div>

                {isSubmittedTab && canReviewTimesheets && (
                  <div className="tsr-card-actions">
                    {commentFormOpened && commentMode === 'review' ? (
                      <div className="tsr-comment-form">
                        <input
                          className="tsr-comment-input"
                          placeholder="Комментарий HR (необязательно)"
                          value={comment}
                          onChange={event => setComment(event.target.value)}
                        />
                        <div className="tsr-comment-actions">
                          <button className="tsr-btn approve" onClick={() => handleApprove(approval.id)} disabled={isProcessing}>
                            <Check size={14} /> Утвердить
                          </button>
                          <button className="tsr-btn reject" onClick={() => handleReject(approval.id)} disabled={isProcessing}>
                            <X size={14} /> Отклонить
                          </button>
                          <button className="tsr-btn neutral" onClick={resetCommentForm} disabled={isProcessing}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button className="tsr-btn approve" onClick={() => handleApprove(approval.id)} disabled={isProcessing}>
                          <Check size={14} /> Утвердить
                        </button>
                        <button className="tsr-btn reject" onClick={() => openCommentForm(approval.id, 'review')} disabled={isProcessing}>
                          <X size={14} /> Отклонить
                        </button>
                      </>
                    )}
                  </div>
                )}

                {isApprovedTab && canReviewTimesheets && (
                  <div className="tsr-card-actions">
                    {commentFormOpened && commentMode === 'return' ? (
                      <div className="tsr-comment-form">
                        <input
                          className="tsr-comment-input"
                          placeholder="Комментарий HR (необязательно)"
                          value={comment}
                          onChange={event => setComment(event.target.value)}
                        />
                        <div className="tsr-comment-actions">
                          <button className="tsr-btn warning" onClick={() => handleReturnToRework(approval.id)} disabled={isProcessing}>
                            <RotateCcw size={14} /> На доработку
                          </button>
                          <button className="tsr-btn neutral" onClick={resetCommentForm} disabled={isProcessing}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="tsr-btn warning" onClick={() => openCommentForm(approval.id, 'return')} disabled={isProcessing}>
                        <RotateCcw size={14} /> Вернуть на доработку
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
        </>
      )}
    </div>
  );
};
