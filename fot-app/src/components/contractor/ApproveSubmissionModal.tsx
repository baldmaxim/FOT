import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  contractorAdminService,
  type IContractorDocument,
  type IDecideItem,
  type ISubmissionDetailRow,
  type ISigurAccessPointOption,
} from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

interface IProps {
  submissionId: string;
  orgName: string;
  orgDepartmentId: string;
  initialSelected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
  onClose: () => void;
  onApplied: () => void;
}

export const ApproveSubmissionModal: FC<IProps> = ({
  submissionId,
  orgName,
  orgDepartmentId,
  initialSelected,
  onSelectedChange,
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
  const docsQuery = useQuery({
    queryKey: ['contractor-org-documents', orgDepartmentId],
    queryFn: () => contractorAdminService.listOrgDocuments(orgDepartmentId),
    staleTime: 30_000,
    enabled: !!orgDepartmentId,
  });

  const handleDownloadDoc = async (doc: IContractorDocument) => {
    try {
      const { url } = await contractorAdminService.getOrgDocumentDownloadUrl(doc.id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось получить ссылку');
    }
  };

  const pendingRows = useMemo<ISubmissionDetailRow[]>(
    () => (detailQuery.data ?? []).filter(r => r.approval_status === 'pending'),
    [detailQuery.data],
  );

  // Map: passId -> выбранные имена точек доступа (предзаполняется текущими).
  const [points, setPoints] = useState<Map<string, string[]>>(new Map());
  const [expandedPass, setExpandedPass] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // По умолчанию все pending-пропуска выбраны (если родитель не передал initialSelected).
  const [selectedPasses, setSelectedPasses] = useState<Set<string>>(initialSelected ?? new Set());

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
    setSelectedPasses(prev => {
      if (prev.size > 0) return prev;
      if (initialSelected && initialSelected.size > 0) return new Set(initialSelected);
      return new Set(detailQuery.data.filter(r => r.approval_status === 'pending').map(r => r.id));
    });
  }, [detailQuery.data, initialSelected]);

  const togglePassSelected = (passId: string) => {
    setSelectedPasses(prev => {
      const next = new Set(prev);
      if (next.has(passId)) next.delete(passId); else next.add(passId);
      onSelectedChange?.(next);
      return next;
    });
  };
  const toggleAllPasses = () => {
    setSelectedPasses(prev => {
      const next = prev.size === pendingRows.length ? new Set<string>() : new Set(pendingRows.map(r => r.id));
      onSelectedChange?.(next);
      return next;
    });
  };

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
    const targets = pendingRows.filter(r => selectedPasses.has(r.id));
    if (targets.length === 0) {
      toast.error('Выберите пропуска для одобрения');
      return;
    }
    const decisions: IDecideItem[] = targets.map(r => ({
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

        <div style={{ marginBottom: 12 }}>
          <div className={styles.statusNote} style={{ marginBottom: 6 }}>
            Документы организации:
          </div>
          {docsQuery.isLoading ? (
            <div className={styles.detailRow}>Загрузка…</div>
          ) : (docsQuery.data ?? []).length === 0 ? (
            <div className={styles.statusNote}>Подрядчик не приложил документы</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(docsQuery.data ?? []).map((d: IContractorDocument) => (
                <li key={d.id} style={{ marginBottom: 4 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ padding: '2px 8px', fontSize: 13 }}
                    onClick={() => void handleDownloadDoc(d)}
                  >
                    ↓ {d.file_name}
                  </button>
                  <span className={styles.statusNote} style={{ marginLeft: 8 }}>
                    {fmtSize(d.file_size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {loading && <div className={styles.detailRow}>Загрузка…</div>}

        {!loading && pendingRows.length === 0 && (
          <div className={styles.empty}>Нет пропусков, ожидающих согласования</div>
        )}

        {!loading && pendingRows.length > 0 && (
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      checked={selectedPasses.size === pendingRows.length && pendingRows.length > 0}
                      ref={el => {
                        if (el) el.indeterminate = selectedPasses.size > 0 && selectedPasses.size < pendingRows.length;
                      }}
                      onChange={toggleAllPasses}
                      disabled={busy}
                      title="Выделить всё / снять"
                    />
                  </th>
                  <th>№</th>
                  <th>ФИО</th>
                  <th>Точки доступа</th>
                </tr>
              </thead>
              <tbody>
                {pendingRows.map(r => {
                  const selected = points.get(r.id) ?? [];
                  const isOpen = expandedPass === r.id;
                  const isChecked = selectedPasses.has(r.id);
                  return (
                    <tr key={r.id} style={{ opacity: isChecked ? 1 : 0.55 }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => togglePassSelected(r.id)}
                          disabled={busy}
                        />
                      </td>
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
            disabled={busy || loading || selectedPasses.size === 0}
          >
            Открыть пропуска ({selectedPasses.size})
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApproveSubmissionModal;
