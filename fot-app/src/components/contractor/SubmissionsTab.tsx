import { Fragment, useEffect, useState, type FC } from 'react';
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

interface ISubmissionDetailProps {
  submissionId: string;
  selected: Set<string> | undefined;
  onChange: (next: Set<string>) => void;
}

const SubmissionDetail: FC<ISubmissionDetailProps> = ({ submissionId, selected, onChange }) => {
  const detailQuery = useQuery({
    queryKey: ['contractor-sub-detail', submissionId],
    queryFn: () => contractorAdminService.getSubmissionDetail(submissionId),
    staleTime: 10_000,
  });

  const rows: ISubmissionDetailRow[] = detailQuery.data ?? [];
  const pendingRows = rows.filter(r => r.approval_status === 'pending');

  // Если parent ещё не инициализировал — по умолчанию выбраны все pending.
  useEffect(() => {
    if (selected === undefined && pendingRows.length > 0) {
      onChange(new Set(pendingRows.map(r => r.id)));
    }
  }, [selected, pendingRows.length, onChange, pendingRows]);

  const effective = selected ?? new Set(pendingRows.map(r => r.id));
  const allSelected = pendingRows.length > 0 && effective.size === pendingRows.length;
  const someSelected = effective.size > 0 && effective.size < pendingRows.length;

  const togglePass = (passId: string) => {
    const next = new Set(effective);
    if (next.has(passId)) next.delete(passId); else next.add(passId);
    onChange(next);
  };
  const toggleAll = () => {
    if (allSelected) onChange(new Set());
    else onChange(new Set(pendingRows.map(r => r.id)));
  };

  if (detailQuery.isLoading) return <div className={styles.detailRow}>Загрузка…</div>;
  if (rows.length === 0) return <div className={styles.detailRow}>Нет пропусков</div>;

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th style={{ width: 32 }}>
            <input
              type="checkbox"
              checked={allSelected}
              ref={el => { if (el) el.indeterminate = someSelected; }}
              onChange={toggleAll}
              disabled={pendingRows.length === 0}
              title="Выделить всех / снять"
            />
          </th>
          <th>№</th>
          <th>ФИО</th>
          <th>UID</th>
          <th>Точки доступа</th>
          <th>Статус</th>
          <th>Согласование</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const isPending = r.approval_status === 'pending';
          const isChecked = isPending && effective.has(r.id);
          return (
            <tr key={r.id} style={isPending && !isChecked ? { opacity: 0.55 } : undefined}>
              <td>
                {isPending && (
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => togglePass(r.id)}
                  />
                )}
              </td>
              <td>{r.pass_number}</td>
              <td>{r.holder_name ?? '—'}</td>
              <td>{r.card_uid ?? '—'}</td>
              <td>{(r.access_point_names ?? []).join(', ') || '—'}</td>
              <td>{passStatusLabel(r.pass_status)}</td>
              <td>{approvalStatusLabel(r.approval_status)}</td>
            </tr>
          );
        })}
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
  // selectedByPass: на каждую заявку — её выбор; undefined = ещё не трогали (дефолт-все).
  const [selectedByPass, setSelectedByPass] = useState<Map<string, Set<string>>>(new Map());

  const overlay = useOverlayDismiss(() => setRejectId(null));

  const subsQuery = useQuery({
    queryKey: ['contractor-pending-subs'],
    queryFn: contractorAdminService.getPendingSubmissions,
    staleTime: 15_000,
  });

  const refreshSubs = () => qc.invalidateQueries({ queryKey: ['contractor-pending-subs'] });

  const setSelectedFor = (submissionId: string, next: Set<string>) => {
    setSelectedByPass(prev => {
      const m = new Map(prev);
      m.set(submissionId, next);
      return m;
    });
  };

  const handleExport = async (sub: IPendingSubmission) => {
    setBusy(true);
    try {
      const blob = await contractorAdminService.exportSubmission(sub.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeOrg = sub.org_name.replace(/[\\/:*?"<>|]+/g, '_').trim();
      const dateIso = new Date(sub.submitted_at).toISOString().slice(0, 10);
      a.href = url;
      a.download = `Заявка_${safeOrg}_${dateIso}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось скачать');
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
            const selectedSet = selectedByPass.get(s.id);
            const selectedCount = selectedSet?.size ?? pending;
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
                      disabled={busy || pending === 0 || selectedCount === 0}
                    >
                      Открыть пропуска ({selectedCount})
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => { setRejectId(s.id); setRejectComment(''); }}
                      disabled={busy || s.status === 'partially_applied'}
                    >
                      Отклонить всю
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => void handleExport(s)}
                      disabled={busy || total === 0}
                      title="Скачать список людей в Excel"
                    >
                      Excel ↓
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={6}>
                      <SubmissionDetail
                        submissionId={s.id}
                        selected={selectedSet}
                        onChange={next => setSelectedFor(s.id, next)}
                      />
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
          orgDepartmentId={approveSub.org_department_id}
          initialSelected={selectedByPass.get(approveSub.id)}
          onSelectedChange={next => setSelectedFor(approveSub.id, next)}
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
