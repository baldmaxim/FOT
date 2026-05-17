import { Fragment, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { contractorAdminService } from '../../services/contractorService';
import styles from '../contractor/Contractor.module.css';

const SubmissionDetail: FC<{ id: string }> = ({ id }) => {
  const detailQuery = useQuery({
    queryKey: ['contractor-sub-detail', id],
    queryFn: () => contractorAdminService.getSubmissionDetail(id),
    staleTime: 10_000,
  });
  if (detailQuery.isLoading) return <div className={styles.detailRow}>Загрузка…</div>;
  const rows = detailQuery.data ?? [];
  if (rows.length === 0) return <div className={styles.detailRow}>Нет изменений</div>;
  return (
    <table className={styles.table}>
      <thead><tr><th>№ пропуска</th><th>ФИО</th><th>UID</th><th>Объекты</th><th>Статус</th></tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id}>
            <td>{r.pass_number}</td>
            <td>{r.holder_name ?? '—'}</td>
            <td>{r.card_uid ?? '—'}</td>
            <td>{r.object_label || '—'}</td>
            <td>{r.pass_status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export const ContractorApprovalsPage: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectComment, setRejectComment] = useState('');

  const overlay = useOverlayDismiss(() => setRejectId(null));

  const subsQuery = useQuery({
    queryKey: ['contractor-pending-subs'],
    queryFn: contractorAdminService.getPendingSubmissions,
    staleTime: 15_000,
  });

  const refreshSubs = () => qc.invalidateQueries({ queryKey: ['contractor-pending-subs'] });

  const handleApprove = async (id: string) => {
    setBusy(true);
    try {
      const res = await contractorAdminService.approveSubmission(id);
      if (res.status === 'approved') toast.success(`Согласовано (${res.applied})`);
      else toast.error(`Частично применено: ${res.failed} ошибок`);
      await refreshSubs();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка согласования');
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <div className={styles.page}>
      {subsQuery.isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : subs.length === 0 ? (
        <div className={styles.empty}>Нет заявок на согласовании</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Организация</th><th>Отправлена</th><th>Пропусков</th><th>Применено</th>
              <th>Статус</th><th></th>
            </tr>
          </thead>
          <tbody>
            {subs.map(s => (
              <Fragment key={s.id}>
                <tr>
                  <td>{s.org_name}</td>
                  <td>{new Date(s.submitted_at).toLocaleString('ru')}</td>
                  <td>{s.passes}</td>
                  <td>{s.applied}</td>
                  <td>
                    <span className={`${styles.badge} ${s.status === 'partially_applied' ? styles.badgeRemove : styles.badgePending}`}>
                      {s.status === 'partially_applied' ? 'частично' : 'ожидает'}
                    </span>
                  </td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn-secondary"
                      onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                    >
                      {expanded === s.id ? 'Скрыть' : 'Детали'}
                    </button>
                    <button
                      className="btn-primary"
                      onClick={() => void handleApprove(s.id)}
                      disabled={busy}
                    >
                      Согласовать
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => { setRejectId(s.id); setRejectComment(''); }}
                      disabled={busy || s.status === 'partially_applied'}
                    >
                      Отклонить
                    </button>
                  </td>
                </tr>
                {expanded === s.id && (
                  <tr>
                    <td colSpan={6}><SubmissionDetail id={s.id} /></td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

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
    </div>
  );
};

export default ContractorApprovalsPage;
