import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  contractorAdminService,
  type IContractorDocument,
  type IDecideItem,
  type IDuplicateRow,
  type ISubmissionDetailRow,
  type ISigurAccessPointOption,
} from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

/** Локальная YYYY-MM-DD (без сдвига по UTC). */
const toYmd = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** Максимум сотрудников за одну активацию (синхронно с бэком). */
const MAX_ACTIVATION_BATCH = 50;

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

  const minDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return toYmd(d);
  }, []);
  // Дефолт срока — 31.12 текущего года, но не раньше завтрашней даты.
  const defaultExpiry = useMemo(() => {
    const endOfYear = `${new Date().getFullYear()}-12-31`;
    return endOfYear >= minDate ? endOfYear : minDate;
  }, [minDate]);

  // Map: passId -> выбранные имена точек доступа (предзаполняется текущими).
  const [points, setPoints] = useState<Map<string, string[]>>(new Map());
  const [expandedPass, setExpandedPass] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Общий срок (режим «Для всех»). Дефолт — 31.12 текущего года.
  const [expiresAt, setExpiresAt] = useState<string>(defaultExpiry);
  // «Для всех» включён по умолчанию. При снятии — срок на каждого сотрудника.
  const [forAll, setForAll] = useState(true);
  const [perPassExpires, setPerPassExpires] = useState<Map<string, string>>(new Map());
  // «Точки доступа — для всех»: чекбокс активен, общий список пуст. При активации точки
  // распространяются на всех; при снятии чекбокса — перезаписываются в каждый пропуск.
  const [apForAll, setApForAll] = useState(true);
  const [apForAllPoints, setApForAllPoints] = useState<string[]>([]);
  // По умолчанию все pending-пропуска выбраны (если родитель не передал initialSelected).
  const [selectedPasses, setSelectedPasses] = useState<Set<string>>(initialSelected ?? new Set());

  // Этап после активации: показ дублей-однофамильцев.
  const [view, setView] = useState<'apply' | 'duplicates'>('apply');
  const [batchId, setBatchId] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<IDuplicateRow[]>([]);
  const [blockingKey, setBlockingKey] = useState<number | null>(null);
  // Усиленное подтверждение увольнения штатного дубля.
  const [staffConfirm, setStaffConfirm] = useState<IDuplicateRow | null>(null);
  const [confirmText, setConfirmText] = useState('');

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
    setPerPassExpires(prev => {
      const next = new Map(prev);
      for (const r of detailQuery.data) {
        if (r.approval_status === 'pending' && !next.has(r.id)) {
          next.set(r.id, defaultExpiry);
        }
      }
      return next;
    });
    setSelectedPasses(prev => {
      if (prev.size > 0) return prev;
      if (initialSelected && initialSelected.size > 0) return new Set(initialSelected);
      return new Set(detailQuery.data.filter(r => r.approval_status === 'pending').map(r => r.id));
    });
  }, [detailQuery.data, initialSelected, defaultExpiry]);

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

  const setPassExpiry = (passId: string, value: string) => {
    setPerPassExpires(prev => {
      const next = new Map(prev);
      next.set(passId, value);
      return next;
    });
  };

  const toggleSharedPoint = (name: string) => {
    setApForAllPoints(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  };

  // При снятии «Для всех» переносим общий список точек во ВСЕ пропуска (перезапись),
  // после чего доступно индивидуальное редактирование в колонке.
  const handleApForAllToggle = (checked: boolean) => {
    if (!checked) {
      setPoints(prev => {
        const next = new Map(prev);
        for (const r of pendingRows) next.set(r.id, [...apForAllPoints]);
        return next;
      });
      setExpandedPass(null);
    }
    setApForAll(checked);
  };

  const handleApply = async () => {
    const targets = pendingRows.filter(r => selectedPasses.has(r.id));
    if (targets.length === 0) {
      toast.error('Выберите пропуска для одобрения');
      return;
    }
    if (targets.length > MAX_ACTIVATION_BATCH) {
      toast.error(`За один раз можно активировать не более ${MAX_ACTIVATION_BATCH} сотрудников. Разбейте на партии.`);
      return;
    }
    if (forAll) {
      if (!expiresAt || expiresAt < minDate) {
        toast.error('Укажите дату окончания пропуска (в будущем)');
        return;
      }
    } else {
      const bad = targets.find(r => {
        const v = perPassExpires.get(r.id);
        return !v || v < minDate;
      });
      if (bad) {
        toast.error(`Укажите корректный срок для пропуска ${bad.pass_number}`);
        return;
      }
    }
    const decisions: IDecideItem[] = targets.map(r => ({
      pass_id: r.id,
      decision: 'approved',
      access_point_names: apForAll
        ? apForAllPoints
        : (points.get(r.id) ?? r.access_point_names ?? []),
      expires_at: forAll ? undefined : perPassExpires.get(r.id),
    }));
    setBusy(true);
    try {
      const res = await contractorAdminService.decideSubmissionItems(
        submissionId,
        decisions,
        forAll ? expiresAt : undefined,
      );
      if (res.failed === 0) {
        toast.success(`Открыто пропусков: ${res.applied}`);
      } else {
        toast.error(`Открыто: ${res.applied}, ошибок: ${res.failed}. ${res.errors.slice(0, 1).join('; ')}`);
      }
      await Promise.all([
        qc.refetchQueries({ queryKey: ['contractor-pending-subs'] }),
        qc.refetchQueries({ queryKey: ['contractor-sub-detail', submissionId] }),
      ]);
      // Если найдены дубли-однофамильцы — показываем их в той же модалке.
      if (res.batch_id && res.duplicates.length > 0) {
        setBatchId(res.batch_id);
        setDuplicates(res.duplicates);
        setView('duplicates');
      } else {
        onApplied();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const runBlock = async (row: IDuplicateRow) => {
    if (!batchId) return;
    setBlockingKey(row.sigur_employee_id);
    try {
      const res = await contractorAdminService.blockDuplicate(batchId, row.sigur_employee_id);
      const label = res.action === 'returned_to_pool'
        ? 'Старый пропуск возвращён в пул'
        : res.action === 'deleted'
          ? 'Старый пропуск удалён'
          : 'Сотрудник заблокирован и уволен';
      toast.success(res.dry_run ? `${label} (dry-run)` : label);
      setDuplicates(prev => prev.filter(d => d.sigur_employee_id !== row.sigur_employee_id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось заблокировать');
    } finally {
      setBlockingKey(null);
    }
  };

  const handleBlockClick = (row: IDuplicateRow) => {
    if (row.source === 'employee') {
      setStaffConfirm(row);
      setConfirmText('');
      return;
    }
    const what = row.card_uid ? 'возвращён в пул' : 'удалён';
    if (window.confirm(`Старый пропуск ${row.pass_number ?? ''} (${row.full_name}) будет ${what}. Продолжить?`)) {
      void runBlock(row);
    }
  };

  const loading = detailQuery.isLoading || apQuery.isLoading;

  const contractorDups = duplicates.filter(d => d.source === 'contractor_pass');
  const staffDups = duplicates.filter(d => d.source === 'employee');

  return (
    <div
      className={styles.overlay}
      onMouseDown={overlay.onMouseDown}
      onMouseUp={overlay.onMouseUp}
      onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart}
      onTouchEnd={overlay.onTouchEnd}
    >
      <div className={styles.modal} style={{ maxWidth: 760 }}>
        {view === 'apply' && (
          <>
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
                      {!forAll && <th>Срок действия</th>}
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
                            {apForAll ? (
                              <div style={{ color: 'var(--text-primary)' }}>
                                {apForAllPoints.length > 0
                                  ? apForAllPoints.join(', ')
                                  : <span style={{ color: 'var(--text-tertiary)' }}>не выбрано</span>}
                              </div>
                            ) : (
                              <>
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
                              </>
                            )}
                          </td>
                          {!forAll && (
                            <td>
                              <input
                                type="date"
                                value={perPassExpires.get(r.id) ?? defaultExpiry}
                                min={minDate}
                                onChange={e => setPassExpiry(r.id, e.target.value)}
                                disabled={busy || !isChecked}
                                style={{ padding: '4px 8px', fontSize: 16 }}
                              />
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && pendingRows.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)' }}>
                  <input
                    type="checkbox"
                    checked={forAll}
                    onChange={e => setForAll(e.target.checked)}
                    disabled={busy}
                  />
                  Для всех
                </label>
                {forAll && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label htmlFor="pass-expires" style={{ color: 'var(--text-primary)' }}>
                      Срок действия пропуска до:
                    </label>
                    <input
                      id="pass-expires"
                      type="date"
                      value={expiresAt}
                      min={minDate}
                      onChange={e => setExpiresAt(e.target.value)}
                      disabled={busy}
                      style={{ padding: '4px 8px', fontSize: 16 }}
                    />
                  </div>
                )}
                {!forAll && (
                  <span className={styles.statusNote}>Срок задаётся в колонке «Срок действия» для каждого сотрудника</span>
                )}
              </div>
            )}

            {!loading && pendingRows.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)' }}>
                  <input
                    type="checkbox"
                    checked={apForAll}
                    onChange={e => handleApForAllToggle(e.target.checked)}
                    disabled={busy}
                  />
                  Точки доступа — для всех
                </label>
                {apForAll ? (
                  <div className={styles.checkList} style={{ marginTop: 8 }}>
                    {allOptions.length === 0 && (
                      <span className={styles.statusNote}>Список точек Sigur пуст</span>
                    )}
                    {allOptions.map(opt => {
                      const on = apForAllPoints.includes(opt.name);
                      return (
                        <label
                          key={opt.id}
                          className={`${styles.checkItem} ${on ? styles.checkItemOn : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleSharedPoint(opt.name)}
                            disabled={busy}
                          />
                          {opt.name}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <span className={styles.statusNote} style={{ display: 'block', marginTop: 6 }}>
                    Точки задаются в колонке «Точки доступа» для каждого сотрудника
                  </span>
                )}
              </div>
            )}

            {!loading && selectedPasses.size > MAX_ACTIVATION_BATCH && (
              <div className={styles.statusNote} style={{ marginTop: 8, color: 'var(--danger, #c0392b)' }}>
                Выбрано {selectedPasses.size} — за раз не более {MAX_ACTIVATION_BATCH}, разбейте на партии.
              </div>
            )}

            <div className={styles.modalActions}>
              <button className="btn-secondary" onClick={onClose} disabled={busy}>
                Отмена
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleApply()}
                disabled={busy || loading || selectedPasses.size === 0 || selectedPasses.size > MAX_ACTIVATION_BATCH}
              >
                Открыть пропуска ({selectedPasses.size})
              </button>
            </div>
          </>
        )}

        {view === 'duplicates' && (
          <>
            <h2 className={styles.modalTitle}>Найдены однофамильцы</h2>
            <div className={styles.statusNote} style={{ marginBottom: 12 }}>
              Это ранее созданные сотрудники с тем же ФИО. Заблокируйте старые пропуска, если это один и тот же человек.
            </div>

            {duplicates.length === 0 && (
              <div className={styles.empty}>Все дубли обработаны</div>
            )}

            {contractorDups.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div className={styles.statusNote} style={{ marginBottom: 6 }}>Подрядные пропуска:</div>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>ФИО</th>
                      <th>Подрядчик</th>
                      <th>Точки доступа</th>
                      <th>№ пропуска</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {contractorDups.map(d => (
                      <tr key={d.sigur_employee_id}>
                        <td>{d.full_name}</td>
                        <td>{d.place_name ?? '—'}</td>
                        <td>{(d.access_point_names ?? []).join(', ') || '—'}</td>
                        <td>{d.pass_number ?? '—'}</td>
                        <td>
                          <button
                            className="btn-secondary"
                            onClick={() => handleBlockClick(d)}
                            disabled={blockingKey === d.sigur_employee_id}
                          >
                            Заблокировать
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {staffDups.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div className={styles.statusNote} style={{ marginBottom: 6, color: 'var(--danger, #c0392b)' }}>
                  ⚠ Штатные сотрудники (точное совпадение ФИО ≠ тот же человек):
                </div>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>ФИО</th>
                      <th>Отдел</th>
                      <th>ID</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffDups.map(d => (
                      <tr key={d.sigur_employee_id}>
                        <td>{d.full_name}</td>
                        <td>{d.place_name ?? '—'}</td>
                        <td>{d.employee_id ?? '—'}</td>
                        <td>
                          <button
                            className="btn-secondary"
                            onClick={() => handleBlockClick(d)}
                            disabled={blockingKey === d.sigur_employee_id}
                          >
                            Заблокировать
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className={styles.modalActions}>
              <button className="btn-primary" onClick={onApplied} disabled={blockingKey !== null}>
                Готово
              </button>
            </div>
          </>
        )}

        {staffConfirm && (
          <div
            className={styles.overlay}
            onMouseDown={e => { if (e.target === e.currentTarget) setStaffConfirm(null); }}
          >
            <div className={styles.modal} style={{ maxWidth: 460 }}>
              <h2 className={styles.modalTitle}>Уволить штатного сотрудника?</h2>
              <div className={styles.statusNote} style={{ marginBottom: 8 }}>
                {staffConfirm.full_name} — {staffConfirm.place_name ?? 'отдел не указан'} (ID {staffConfirm.employee_id ?? '—'}).
                <br />
                Сотрудник будет заблокирован в Sigur и перенесён в «Уволенные».
                Точное совпадение ФИО не гарантирует, что это тот же человек.
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Для подтверждения введите слово «УВОЛИТЬ»</span>
                <input
                  className={styles.input}
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder="УВОЛИТЬ"
                />
              </div>
              <div className={styles.modalActions}>
                <button className="btn-secondary" onClick={() => setStaffConfirm(null)}>
                  Отмена
                </button>
                <button
                  className="btn-primary"
                  disabled={confirmText.trim() !== 'УВОЛИТЬ' || blockingKey !== null}
                  onClick={() => {
                    const row = staffConfirm;
                    setStaffConfirm(null);
                    void runBlock(row);
                  }}
                >
                  Уволить
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ApproveSubmissionModal;
