import { Fragment, useState, useEffect, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  contractorAdminService,
  type ISubmissionDetailRow,
  type IDecideItem,
} from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

interface IDetailProps {
  submissionId: string;
  onAction: () => Promise<void> | void;
  busy: boolean;
  setBusy: (v: boolean) => void;
}

const SubmissionDetail: FC<IDetailProps> = ({ submissionId, onAction, busy, setBusy }) => {
  const toast = useToast();
  const qc = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ['contractor-sub-detail', submissionId],
    queryFn: () => contractorAdminService.getSubmissionDetail(submissionId),
    staleTime: 10_000,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commonPoints, setCommonPoints] = useState('');

  // Сброс выделения при смене заявки.
  useEffect(() => { setSelected(new Set()); }, [submissionId]);

  const rows: ISubmissionDetailRow[] = detailQuery.data ?? [];
  const pendingRows = rows.filter(r => r.approval_status === 'pending');

  const toggleSel = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === pendingRows.length) setSelected(new Set());
    else setSelected(new Set(pendingRows.map(r => r.id)));
  };

  const decideMany = async (decision: 'approved' | 'rejected') => {
    const ids = selected.size > 0
      ? Array.from(selected)
      : pendingRows.map(r => r.id);
    if (ids.length === 0) {
      toast.error('Нет пропусков для решения');
      return;
    }
    const pointsArr = commonPoints.split(',').map(s => s.trim()).filter(Boolean);
    const decisions: IDecideItem[] = ids.map(id => ({
      pass_id: id,
      decision,
      ...(decision === 'approved' && pointsArr.length > 0 ? { access_point_names: pointsArr } : {}),
    }));
    setBusy(true);
    try {
      const res = await contractorAdminService.decideSubmissionItems(submissionId, decisions);
      if (res.failed === 0) {
        toast.success(`Одобрено: ${res.applied}, отклонено: ${res.rejected}`);
      } else {
        toast.error(`Ошибок: ${res.failed}. ${res.errors.slice(0, 1).join('; ')}`);
      }
      await qc.invalidateQueries({ queryKey: ['contractor-sub-detail', submissionId] });
      await onAction();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  if (detailQuery.isLoading) return <div className={styles.detailRow}>Загрузка…</div>;
  if (rows.length === 0) return <div className={styles.detailRow}>Нет пропусков</div>;

  return (
    <div>
      {pendingRows.length > 0 && (
        <div className={styles.toolbar}>
          <button className="btn-secondary" onClick={toggleAll} disabled={busy}>
            {selected.size === pendingRows.length && pendingRows.length > 0 ? 'Снять выделение' : 'Выделить все'}
          </button>
          <input
            className={`${styles.input} ${styles.fullInput}`}
            style={{ maxWidth: 320 }}
            placeholder="Точки доступа через запятую (если меняем)"
            value={commonPoints}
            onChange={e => setCommonPoints(e.target.value)}
          />
          <button className="btn-primary" onClick={() => void decideMany('approved')} disabled={busy}>
            Одобрить {selected.size > 0 ? `(${selected.size})` : 'все ожидающие'}
          </button>
          <button className="btn-secondary" onClick={() => void decideMany('rejected')} disabled={busy}>
            Отклонить {selected.size > 0 ? `(${selected.size})` : 'все ожидающие'}
          </button>
        </div>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            <th></th><th>№</th><th>ФИО</th><th>UID</th><th>Объекты</th>
            <th>Точки доступа</th><th>Статус</th><th>Согласование</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>
                {r.approval_status === 'pending' && (
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleSel(r.id)}
                    disabled={busy}
                  />
                )}
              </td>
              <td>{r.pass_number}</td>
              <td>{r.holder_name ?? '—'}</td>
              <td>{r.card_uid ?? '—'}</td>
              <td>{r.object_label || '—'}</td>
              <td>{(r.access_point_names ?? []).join(', ') || '—'}</td>
              <td>{r.pass_status}</td>
              <td>{r.approval_status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const SubmissionsTab: FC = () => {
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

  if (subsQuery.isLoading) return <div className={styles.empty}>Загрузка…</div>;
  if (subs.length === 0) return <div className={styles.empty}>Нет заявок на согласовании</div>;

  return (
    <div>
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
                    Открыть все пропуска
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
              {expanded === s.id && (
                <tr>
                  <td colSpan={6}>
                    <SubmissionDetail
                      submissionId={s.id}
                      onAction={refreshSubs}
                      busy={busy}
                      setBusy={setBusy}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
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
    </div>
  );
};

export default SubmissionsTab;
