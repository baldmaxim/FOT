import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  contractorAdminService,
  type IDecideItem,
  type ISubmissionDetailRow,
  type ISigurAccessPointOption,
} from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

interface IProps {
  submissionId: string;
  orgName: string;
  onClose: () => void;
  onApplied: () => void;
}

export const ApproveSubmissionModal: FC<IProps> = ({
  submissionId,
  orgName,
  onClose,
  onApplied,
}) => {
  const toast = useToast();
  const qc = useQueryClient();
  const overlay = useOverlayDismiss(onClose);

  const detailQuery = useQuery({
    queryKey: ['contractor-sub-detail', submissionId],
    queryFn: () => contractorAdminService.getSubmissionDetail(submissionId),
    staleTime: 10_000,
  });
  const apQuery = useQuery({
    queryKey: ['contractor-sigur-access-points'],
    queryFn: () => contractorAdminService.listSigurAccessPoints(),
    staleTime: 5 * 60_000,
  });

  const pendingRows = useMemo<ISubmissionDetailRow[]>(
    () => (detailQuery.data ?? []).filter(r => r.approval_status === 'pending'),
    [detailQuery.data],
  );

  // Map: passId -> выбранные имена точек доступа (предзаполняется текущими).
  const [points, setPoints] = useState<Map<string, string[]>>(new Map());
  const [expandedPass, setExpandedPass] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Предзаполнение при загрузке деталей.
  useEffect(() => {
    if (!detailQuery.data) return;
    setPoints(prev => {
      const next = new Map(prev);
      for (const r of detailQuery.data) {
        if (r.approval_status === 'pending' && !next.has(r.id)) {
          next.set(r.id, [...(r.access_point_names ?? [])]);
        }
      }
      return next;
    });
  }, [detailQuery.data]);

  const allOptions: ISigurAccessPointOption[] = apQuery.data ?? [];

  const togglePoint = (passId: string, name: string) => {
    setPoints(prev => {
      const next = new Map(prev);
      const current = next.get(passId) ?? [];
      next.set(
        passId,
        current.includes(name) ? current.filter(n => n !== name) : [...current, name],
      );
      return next;
    });
  };

  const handleApply = async () => {
    if (pendingRows.length === 0) {
      toast.error('Нет пропусков для открытия');
      return;
    }
    const decisions: IDecideItem[] = pendingRows.map(r => ({
      pass_id: r.id,
      decision: 'approved',
      access_point_names: points.get(r.id) ?? r.access_point_names ?? [],
    }));
    setBusy(true);
    try {
      const res = await contractorAdminService.decideSubmissionItems(submissionId, decisions);
      if (res.failed === 0) {
        toast.success(`Открыто пропусков: ${res.applied}`);
      } else {
        toast.error(`Открыто: ${res.applied}, ошибок: ${res.failed}. ${res.errors.slice(0, 1).join('; ')}`);
      }
      await qc.invalidateQueries({ queryKey: ['contractor-pending-subs'] });
      await qc.invalidateQueries({ queryKey: ['contractor-sub-detail', submissionId] });
      onApplied();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const loading = detailQuery.isLoading || apQuery.isLoading;

  return (
    <div
      className={styles.overlay}
      onMouseDown={overlay.onMouseDown}
      onMouseUp={overlay.onMouseUp}
      onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart}
      onTouchEnd={overlay.onTouchEnd}
    >
      <div className={styles.modal} style={{ maxWidth: 720 }}>
        <h2 className={styles.modalTitle}>Открыть пропуска — {orgName}</h2>

        {loading && <div className={styles.detailRow}>Загрузка…</div>}

        {!loading && pendingRows.length === 0 && (
          <div className={styles.empty}>Нет пропусков, ожидающих согласования</div>
        )}

        {!loading && pendingRows.length > 0 && (
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>№</th>
                  <th>ФИО</th>
                  <th>Точки доступа</th>
                </tr>
              </thead>
              <tbody>
                {pendingRows.map(r => {
                  const selected = points.get(r.id) ?? [];
                  const isOpen = expandedPass === r.id;
                  return (
                    <tr key={r.id}>
                      <td>{r.pass_number}</td>
                      <td>{r.holder_name ?? '—'}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ flex: 1, color: 'var(--text-primary)' }}>
                            {selected.length > 0 ? selected.join(', ') : <span style={{ color: 'var(--text-tertiary)' }}>не выбрано</span>}
                          </div>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => setExpandedPass(isOpen ? null : r.id)}
                            disabled={busy}
                          >
                            {isOpen ? 'Свернуть' : 'Изменить'}
                          </button>
                        </div>
                        {isOpen && (
                          <div className={styles.checkList} style={{ marginTop: 8 }}>
                            {allOptions.length === 0 && (
                              <span className={styles.statusNote}>Список точек Sigur пуст</span>
                            )}
                            {allOptions.map(opt => {
                              const on = selected.includes(opt.name);
                              return (
                                <label
                                  key={opt.id}
                                  className={`${styles.checkItem} ${on ? styles.checkItemOn : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={() => togglePoint(r.id, opt.name)}
                                    disabled={busy}
                                  />
                                  {opt.name}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.modalActions}>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="btn-primary"
            onClick={() => void handleApply()}
            disabled={busy || loading || pendingRows.length === 0}
          >
            Открыть пропуска ({pendingRows.length})
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApproveSubmissionModal;
