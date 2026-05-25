import { Fragment, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  contractorAdminService,
  type ISubmissionDetailRow,
  type IPendingSubmission,
} from '../../services/contractorService';
import { passStatusLabel, approvalStatusLabel } from '../../utils/contractorStatus';
import { ApproveSubmissionModal } from './ApproveSubmissionModal';
import styles from '../../pages/contractor/Contractor.module.css';

const SubmissionDetail: FC<{ submissionId: string }> = ({ submissionId }) => {
  const detailQuery = useQuery({
    queryKey: ['contractor-sub-detail', submissionId],
    queryFn: () => contractorAdminService.getSubmissionDetail(submissionId),
    staleTime: 10_000,
  });

  if (detailQuery.isLoading) return <div className={styles.detailRow}>Загрузка…</div>;
  const rows: ISubmissionDetailRow[] = detailQuery.data ?? [];
  if (rows.length === 0) return <div className={styles.detailRow}>Нет пропусков</div>;

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>№</th>
          <th>ФИО</th>
          <th>UID</th>
          <th>Точки доступа</th>
          <th>Статус</th>
          <th>Согласование</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id}>
            <td>{r.pass_number}</td>
            <td>{r.holder_name ?? '—'}</td>
            <td>{r.card_uid ?? '—'}</td>
            <td>{(r.access_point_names ?? []).join(', ') || '—'}</td>
            <td>{passStatusLabel(r.pass_status)}</td>
            <td>{approvalStatusLabel(r.approval_status)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export const SubmissionsTab: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [approveSub, setApproveSub] = useState<IPendingSubmission | null>(null);

  const overlay = useOverlayDismiss(() => setRejectId(null));

  const subsQuery = useQuery({
    queryKey: ['contractor-pending-subs'],
    queryFn: contractorAdminService.getPendingSubmissions,
    staleTime: 15_000,
  });

  const refreshSubs = () => qc.invalidateQueries({ queryKey: ['contractor-pending-subs'] });

  const handleReject = async () => {
    if (!rejectId) return;
    setBusy(true);
    try {
      await contractorAdminService.rejectSubmission(rejectId, rejectComment.trim() || undefined);
      toast.success('Заявка отклонена');
      setRejectId(null);
      setRejectComment('');
      await refreshSubs();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка отклонения');
    } finally {
      setBusy(false);
    }
  };

  const subs = subsQuery.data ?? [];

  if (subsQuery.isLoading) return <div className={styles.empty}>Загрузка…</div>;
  if (subs.length === 0) return <div className={styles.empty}>Нет заявок на согласовании</div>;

  return (
    <div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Организация</th>
            <th>Отправлена</th>
            <th>Пропусков</th>
            <th>Применено</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {subs.map(s => {
            const total = Number(s.passes) || 0;
            const applied = Number(s.applied) || 0;
            const pending = Math.max(total - applied, 0);
            const isOpen = expanded === s.id;
            return (
              <Fragment key={s.id}>
                <tr>
                  <td
                    onClick={() => setExpanded(isOpen ? null : s.id)}
                    style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 600 }}
                    title={isOpen ? 'Скрыть список людей' : 'Показать список людей'}
                  >
                    <span style={{ display: 'inline-block', width: 14, color: 'var(--text-secondary)' }}>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    {s.org_name}
                  </td>
                  <td>{new Date(s.submitted_at).toLocaleString('ru')}</td>
                  <td>{total}</td>
                  <td>{applied}</td>
                  <td>
                    <span className={`${styles.badge} ${s.status === 'partially_applied' ? styles.badgeRemove : styles.badgePending}`}>
                      {s.status === 'partially_applied' ? 'частично' : 'ожидает'}
                    </span>
                  </td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn-primary"
                      onClick={() => setApproveSub(s)}
                      disabled={busy || pending === 0}
                    >
                      Открыть пропуска ({pending})
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => { setRejectId(s.id); setRejectComment(''); }}
                      disabled={busy || s.status === 'partially_applied'}
                    >
                      Отклонить всю
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={6}>
                      <SubmissionDetail submissionId={s.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {rejectId && (
        <div
          className={styles.overlay}
          onMouseDown={overlay.onMouseDown}
          onMouseUp={overlay.onMouseUp}
          onMouseLeave={overlay.onMouseLeave}
          onTouchStart={overlay.onTouchStart}
          onTouchEnd={overlay.onTouchEnd}
        >
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>Отклонить заявку</h2>
            <div className={styles.field}>
              <span className={styles.label}>Причина (необязательно)</span>
              <textarea
                className={styles.textarea}
                value={rejectComment}
                onChange={e => setRejectComment(e.target.value)}
              />
            </div>
            <div className={styles.modalActions}>
              <button className="btn-secondary" onClick={() => setRejectId(null)} disabled={busy}>
                Отмена
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleReject()}
                disabled={busy}
              >
                Отклонить
              </button>
            </div>
          </div>
        </div>
      )}

      {approveSub && (
        <ApproveSubmissionModal
          submissionId={approveSub.id}
          orgName={approveSub.org_name}
          onClose={() => setApproveSub(null)}
          onApplied={() => {
            setApproveSub(null);
            void refreshSubs();
          }}
        />
      )}
    </div>
  );
};

export default SubmissionsTab;
