import { type FC, useEffect, useMemo, useState } from 'react';
import { X, Check, AlertTriangle, MapPin } from 'lucide-react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { travelTimeService } from '../../services/travelTimeService';
import { useToast } from '../../contexts/ToastContext';
import type { ITravelSegment } from '../../types';

interface ITravelExceptionModalProps {
  open: boolean;
  onClose: () => void;
  employeeId: number | null;
  employeeName: string | null;
  workDate: string | null;
}

const formatHM = (minutes: number): string => {
  const sign = minutes < 0 ? '−' : '';
  const total = Math.round(Math.abs(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${sign}${m}мин`;
  if (m === 0) return `${sign}${h}ч`;
  return `${sign}${h}ч ${String(m).padStart(2, '0')}мин`;
};

const formatTimeShort = (value: string | null | undefined): string => {
  if (!value) return '—';
  const match = value.match(/(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '—';
};

const formatDateRu = (value: string): string => {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
};

const STATUS_LABEL: Record<ITravelSegment['status'], string> = {
  auto_approved: 'В пределах лимита',
  pending: 'Ожидает решения',
  approved: 'Подтверждено',
  rejected: 'Отклонено',
  needs_object: 'Точка не привязана к объекту',
  needs_route: 'Маршрут не настроен',
};

const STATUS_COLOR: Record<ITravelSegment['status'], string> = {
  auto_approved: '#16a34a',
  pending: '#f59e0b',
  approved: '#16a34a',
  rejected: '#dc2626',
  needs_object: '#6b7280',
  needs_route: '#6b7280',
};

export const TravelExceptionModal: FC<ITravelExceptionModalProps> = ({
  open,
  onClose,
  employeeId,
  employeeName,
  workDate,
}) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [comments, setComments] = useState<Record<string, string>>({});

  const queryEnabled = open && employeeId != null && !!workDate;

  const { data: segments = [], isLoading, isError } = useQuery({
    queryKey: ['travel-day-segments', employeeId, workDate],
    queryFn: () => travelTimeService.getDaySegments(employeeId!, workDate!),
    enabled: queryEnabled,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) queueMicrotask(() => setComments({}));
  }, [open]);

  const invalidateRelated = (): void => {
    queryClient.invalidateQueries({ queryKey: ['travel-day-segments', employeeId, workDate] });
    queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet'] });
  };

  const approveMutation = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) => (
      travelTimeService.approveSegment(id, comment)
    ),
    onSuccess: () => {
      toast.success?.('Превышение подтверждено — время засчитано');
      invalidateRelated();
    },
    onError: (err: unknown) => {
      toast.error?.(err instanceof Error ? err.message : 'Не удалось подтвердить');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) => (
      travelTimeService.rejectSegment(id, comment)
    ),
    onSuccess: () => {
      toast.success?.('Превышение отклонено — засчитан только лимит');
      invalidateRelated();
    },
    onError: (err: unknown) => {
      toast.error?.(err instanceof Error ? err.message : 'Не удалось отклонить');
    },
  });

  const limitMinutes = useMemo(() => {
    const norm = segments.find(seg => seg.norm_minutes != null)?.norm_minutes;
    return norm ?? null;
  }, [segments]);

  if (!open) return null;

  const isPending = approveMutation.isPending || rejectMutation.isPending;

  return (
    <div className="ts-modal-overlay ts-modal-overlay--open" onClick={onClose}>
      <div className="ts-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="ts-modal-header">
          <div className="ts-modal-title">
            Передвижения {workDate ? `за ${formatDateRu(workDate)}` : ''}
            {employeeName ? ` — ${employeeName}` : ''}
          </div>
          <button className="ts-panel-close" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
        <div className="ts-modal-body">
          {limitMinutes != null && (
            <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-muted, #6b7280)' }}>
              Лимит передвижения: <b>{formatHM(limitMinutes)}</b>. В пределах лимита время автоматически
              засчитывается как рабочее. Превышение зачитывается только после подтверждения руководителя.
            </div>
          )}

          {isLoading && <div className="ts-modal-events-empty">Загрузка…</div>}
          {isError && <div className="ts-modal-events-empty">Не удалось загрузить передвижения</div>}
          {!isLoading && !isError && segments.length === 0 && (
            <div className="ts-modal-events-empty">Передвижений за этот день нет</div>
          )}

          {segments.map(seg => {
            const comment = comments[seg.id] ?? seg.approval_comment ?? '';
            const isDecided = seg.status === 'approved' || seg.status === 'rejected';
            const canDecide = seg.status === 'pending' && !isPending;
            const fromLabel = seg.from_object_name || seg.from_access_point_name || '—';
            const toLabel = seg.to_object_name || seg.to_access_point_name || '—';
            return (
              <div
                key={seg.id}
                style={{
                  border: '1px solid var(--border, #e5e7eb)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 10,
                  background: 'var(--surface, #fff)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <MapPin size={14} />
                  <div style={{ fontWeight: 600 }}>{fromLabel} → {toLabel}</div>
                  <div
                    style={{
                      marginLeft: 'auto',
                      fontSize: 12,
                      fontWeight: 600,
                      color: STATUS_COLOR[seg.status],
                    }}
                  >
                    {STATUS_LABEL[seg.status]}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted, #6b7280)', marginBottom: 8 }}>
                  Выход: <b>{formatTimeShort(seg.exit_time)}</b>
                  {' '}· Вход: <b>{formatTimeShort(seg.entry_time)}</b>
                  {' '}· Фактически: <b>{formatHM(seg.actual_minutes)}</b>
                  {seg.delay_minutes > 0 && (
                    <>
                      {' '}· Превышение: <b style={{ color: '#dc2626' }}>+{formatHM(seg.delay_minutes)}</b>
                    </>
                  )}
                </div>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  Засчитано в работу: <b>{formatHM(seg.credited_minutes)}</b>
                  {' '}/ из <b>{formatHM(seg.actual_minutes)}</b>
                </div>

                {seg.status === 'needs_object' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#92400e', fontSize: 12 }}>
                    <AlertTriangle size={14} />
                    Привяжите точку доступа к объекту в настройках СКУД, чтобы рассчитать норматив.
                  </div>
                )}

                {isDecided && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted, #6b7280)' }}>
                    {seg.status === 'approved' ? 'Подтвердил' : 'Отклонил'}
                    {seg.approved_by_name ? `: ${seg.approved_by_name}` : ''}
                    {seg.approved_at ? ` · ${new Date(seg.approved_at).toLocaleString('ru-RU')}` : ''}
                    {seg.approval_comment ? ` · «${seg.approval_comment}»` : ''}
                  </div>
                )}

                {canDecide && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                    <input
                      type="text"
                      placeholder="Комментарий (необязательно)"
                      value={comment}
                      onChange={e => setComments(prev => ({ ...prev, [seg.id]: e.target.value }))}
                      maxLength={1000}
                      style={{
                        padding: '6px 8px',
                        border: '1px solid var(--border, #e5e7eb)',
                        borderRadius: 6,
                        fontSize: 13,
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="ts-btn ts-btn--primary"
                        onClick={() => approveMutation.mutate({ id: seg.id, comment: comment.trim() || undefined })}
                        disabled={isPending}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <Check size={14} /> Подтвердить
                      </button>
                      <button
                        type="button"
                        className="ts-btn ts-btn--danger"
                        onClick={() => rejectMutation.mutate({ id: seg.id, comment: comment.trim() || undefined })}
                        disabled={isPending}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <X size={14} /> Отклонить
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
