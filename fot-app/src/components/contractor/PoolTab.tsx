import { useState, useMemo, useEffect, useRef, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useStructureTree } from '../../hooks/useStructure';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useCardReaderAgent } from '../../contexts/CardReaderAgentContext';
import { contractorAdminService, type IPoolAnomaly, type IPoolCardConflict, type IPoolCell, type IPoolFail, type ISigurDepartmentNode } from '../../services/contractorService';
import { formatCardW26 } from '../../utils/cardW26';
import { DepartmentTreeSelect } from '../staff/DepartmentTreeSelect';
import type { OrgDepartmentNode } from '../../types/organization';
import styles from '../../pages/contractor/Contractor.module.css';

const CHUNK = 4;

interface IScanRow {
  uid: string;
  /** Полный серийник карты с ридера (CSN) — для дедупа по уникальному ключу, а не по 24-бит W26. */
  hexUid?: string;
  /** Весь payload ридера — сохраняем в БД для анализа коллизий. */
  reader?: Record<string, unknown>;
  /** Результат универсальной проверки (БД+Sigur): undefined — ещё проверяется/не проверяли. */
  conflict?: IPoolCardConflict;
}

/** Бейдж результата проверки карты (БД пула + Sigur) в таблице считанных карт. */
const renderCardCheck = (c?: IPoolCardConflict) => {
  if (!c) return <span className={styles.checkMuted}>проверка…</span>;
  if (!c.has_conflict) {
    return (
      <span
        className={styles.checkOk}
        title={c.sigur_error ? `Sigur недоступен: ${c.sigur_error} (проверена только БД)` : 'Свободна: в БД пула и в Sigur не найдена'}
      >
        ✓ свободна
      </span>
    );
  }
  const parts: string[] = [];
  if (c.db.length > 0) parts.push(`в пуле: № ${c.db.map(d => d.pass_number).join(', ')}`);
  if (c.sigur?.bound_employee_id) {
    parts.push(c.sigur.is_pool_placeholder
      ? `в Sigur: ${c.sigur.bound_employee_name ?? 'пул'}`
      : `в Sigur у «${c.sigur.bound_employee_name ?? '—'}»`);
  }
  const short = c.db.length > 0
    ? `уже № ${c.db.map(d => d.pass_number).join(',')}`
    : (c.sigur?.bound_employee_name ?? 'занята');
  return <span className={styles.checkWarn} title={parts.join('; ')}>⚠ {short}</span>;
};

const SigurDepartmentPicker: FC<{
  nodes: ISigurDepartmentNode[];
  value: number | null;
  onChange: (id: number | null) => void;
}> = ({ nodes, value, onChange }) => {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('ru');
    if (!q) return nodes;
    return nodes.filter(n => n.name.toLocaleLowerCase('ru').includes(q));
  }, [nodes, search]);
  return (
    <div>
      <input
        className={`${styles.input} ${styles.fullInput}`}
        placeholder="Поиск папки Sigur…"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
        {filtered.map(n => (
          <label
            key={n.id}
            style={{
              display: 'flex', gap: 8, padding: '6px 10px', cursor: 'pointer',
              background: value === n.id ? 'var(--primary-light)' : 'transparent',
            }}
          >
            <input
              type="radio"
              name="sigur-dept"
              checked={value === n.id}
              onChange={() => onChange(n.id)}
            />
            <span>{n.name} <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>#{n.id}</span></span>
          </label>
        ))}
        {filtered.length === 0 && <div style={{ padding: 12 }}>Ничего не найдено</div>}
      </div>
    </div>
  );
};

export const PoolTab: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const { connected, lastCard, cardSeq } = useCardReaderAgent();

  const [selectFolderOpen, setSelectFolderOpen] = useState(false);
  const [draftFolderId, setDraftFolderId] = useState<number | null>(null);
  const [fromStr, setFromStr] = useState('');
  const [toStr, setToStr] = useState('');
  const [rows, setRows] = useState<IScanRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignOrgId, setAssignOrgId] = useState<string>('');
  const [countStr, setCountStr] = useState('');
  const [matrixSearch, setMatrixSearch] = useState(''); // поиск по номеру в матрице пула
  const lastSeqRef = useRef(0);
  const dragRef = useRef<null | { mode: 'add' | 'remove' }>(null);

  // Удаление из пула: режим-тумблер + выбор строк (по id) + подтверждение.
  const [deleteMode, setDeleteMode] = useState(false);
  const [delSel, setDelSel] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<null | { ids: string[]; labels: string[] }>(null);
  // Карты, отклонённые анти-сдвигом при последнем добавлении (stage='duplicate_card').
  const [dupCardIssues, setDupCardIssues] = useState<IPoolFail[]>([]);

  const settingsOverlay = useOverlayDismiss(() => setSelectFolderOpen(false));
  const confirmOverlay = useOverlayDismiss(() => setConfirmDelete(null));

  const structureQuery = useStructureTree();
  const departments = useMemo<OrgDepartmentNode[]>(
    () => structureQuery.data?.departments ?? [],
    [structureQuery.data?.departments],
  );

  const settingsQuery = useQuery({
    queryKey: ['contractor-pool-settings'],
    queryFn: contractorAdminService.getPoolSettings,
    staleTime: 60_000,
  });
  const sigurDeptsQuery = useQuery({
    queryKey: ['contractor-sigur-departments'],
    queryFn: contractorAdminService.listSigurDepartments,
    enabled: selectFolderOpen,
    staleTime: 5 * 60_000,
  });
  const matrixQuery = useQuery({
    queryKey: ['contractor-pool-matrix'],
    queryFn: contractorAdminService.getPoolMatrix,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const anomaliesQuery = useQuery({
    queryKey: ['contractor-pool-anomalies'],
    queryFn: contractorAdminService.getPoolAnomalies,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const anomalies: IPoolAnomaly[] = useMemo(() => anomaliesQuery.data ?? [], [anomaliesQuery.data]);

  const folderId = settingsQuery.data?.sigur_department_id ?? null;
  const folderName = settingsQuery.data?.name ?? null;
  const cells: IPoolCell[] = useMemo(() => matrixQuery.data?.cells ?? [], [matrixQuery.data]);
  // Отфильтрованные для отображения: если задан поиск — показываем только совпавшие
  // по номеру пропуска (подстрока). На выделение/удаление/тоталы не влияет.
  const visibleCells: IPoolCell[] = useMemo(() => {
    const q = matrixSearch.trim();
    if (!q) return cells;
    return cells.filter(c => c.pass_number.includes(q));
  }, [cells, matrixSearch]);
  const totals = matrixQuery.data?.totals ?? { free: 0, occupied: 0, provisioning: 0, failed: 0 };
  // Реальные сбои выпуска берём из матрицы (status='failed' = строка provisioning_failed).
  // Шум reserve-фазы ('уже в пуле' / 'нет карты во входных') строкой не материализуется
  // и сюда не попадает — оператор видит только то, что требует действия.
  const failedCells: IPoolCell[] = useMemo(() => cells.filter(c => c.status === 'failed'), [cells]);
  const freeCells = useMemo(() => cells.filter(c => c.status === 'free' && c.id), [cells]);
  const freeIds = useMemo(() => new Set(freeCells.map(c => c.id as string)), [freeCells]);

  // Снимаем из выделения пропуска, которых больше нет среди свободных (после авто-рефетча).
  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (freeIds.has(id)) next.add(id); else changed = true;
      }
      return changed ? next : prev;
    });
  }, [freeIds]);

  // Прешник стартового номера при первом открытии (или после выпуска).
  useEffect(() => {
    let cancelled = false;
    contractorAdminService.getPoolNextNumber()
      .then(n => { if (!cancelled && fromStr === '') setFromStr(String(n)); })
      .catch(() => { /* пользователь введёт вручную */ });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrixQuery.dataUpdatedAt]);

  // Глобальный mouseup завершает протяжку-выделение, даже если курсор ушёл из матрицы.
  useEffect(() => {
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  // Считывание карт.
  useEffect(() => {
    if (cardSeq === 0 || cardSeq === lastSeqRef.current) return;
    lastSeqRef.current = cardSeq;
    // W26 (facility,number) надёжнее сырого UID для создания карты в Sigur —
    // отдаём его приоритетно, с откатом на UID, если ридер W26 не прислал.
    const uid = lastCard?.w26?.trim() || lastCard?.sigurCard?.trim();
    if (!uid) return;
    // Полный CSN карты — сохраняем отдельно: две физически разные карты могут дать
    // один и тот же 24-бит W26, но hexUid у них различается (ловим дубли по нему).
    const hexUid = lastCard?.hexUid?.trim() || undefined;
    const reader = lastCard ? { ...lastCard } : undefined;
    let added = false;
    setRows(prev => {
      if (prev.some(r => r.uid === uid)) {
        toast.error(`Карта ${uid} уже считана`);
        return prev;
      }
      added = true;
      return [...prev, { uid, hexUid, reader }];
    });
    // Универсальная проверка (БД пула + Sigur) — сразу после скана, чтобы предупредить
    // об ошибке ДО добавления. Не критично: при сбое просто не покажем бейдж.
    if (added) {
      void contractorAdminService.checkPoolCard(uid)
        .then(res => setRows(prev => prev.map(r => (r.uid === uid ? { ...r, conflict: res } : r))))
        .catch(() => { /* проверка не обязательна */ });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardSeq]);

  const fromNum = Number(fromStr);
  const toNum = toStr ? Number(toStr) : null;
  // Канонический формат номера — без ведущих нулей (как пишет бэкенд при reserve).
  const passNumberAt = (idx: number): string =>
    String((Number.isFinite(fromNum) ? fromNum : 1) + idx);

  const canAddPool =
    folderId != null &&
    rows.length > 0 &&
    Number.isInteger(fromNum) && fromNum > 0 &&
    (toNum == null || (Number.isInteger(toNum) && toNum >= fromNum + rows.length - 1)) &&
    !busy;

  const refreshPool = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['contractor-pool-matrix'] }),
      qc.invalidateQueries({ queryKey: ['contractor-pool-anomalies'] }),
    ]);
  };

  // id строки, которую можно удалить из данной ячейки (по её статусу).
  // provisioning не трогаем — выпуск ещё идёт (для него есть «Отменить выпуск»).
  const cellDeletableId = (c: IPoolCell): string | null => {
    if (c.status === 'free') return c.id;
    if (c.status === 'occupied') return c.occupied_id;
    if (c.status === 'failed') return c.failed_id;
    return null;
  };

  const toggleDelSel = (id: string) => {
    setDelSel(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Человекочитаемые метки выбранных на удаление (номера пропусков) — для модалки.
  const delSelLabels = useMemo(() => {
    const byId = new Map<string, string>();
    for (const c of cells) {
      const id = cellDeletableId(c);
      if (id) byId.set(id, c.pass_number);
    }
    return Array.from(delSel).map(id => (byId.has(id) ? `№${byId.get(id)}` : id));
  }, [cells, delSel]);

  const exitDeleteMode = () => { setDeleteMode(false); setDelSel(new Set()); };

  const handleAddToPool = async () => {
    if (!canAddPool) return;
    setBusy(true);
    const cards = rows.map((r, i) => ({ uid: r.uid, sequence: i, hex_uid: r.hexUid, reader: r.reader }));
    const chunks: Array<typeof cards> = [];
    for (let i = 0; i < cards.length; i += CHUNK) chunks.push(cards.slice(i, i + CHUNK));
    setProgress({ done: 0, total: cards.length });

    const agg = { created: [] as string[], failed: [] as IPoolFail[], warnings: [] as string[] };
    try {
      for (let k = 0; k < chunks.length; k += 1) {
        const data = await contractorAdminService.addToPool({
          from: fromNum,
          to: toNum ?? undefined,
          cards: chunks[k],
        });
        agg.created.push(...data.created);
        agg.failed.push(...data.failed);
        agg.warnings.push(...data.warnings);
        setProgress({ done: Math.min((k + 1) * CHUNK, cards.length), total: cards.length });
      }
      // Реальные сбои выпуска — только Sigur (card/sigur); 'duplicate'/'input'/'range'
      // это норма ввода, оператора ими не тревожим. duplicate_card — анти-сдвиг:
      // карта уже привязана к другому пропуску, показываем отдельным блоком.
      const realFailed = agg.failed.filter(f => f.stage === 'card' || f.stage === 'sigur');
      const dupCards = agg.failed.filter(f => f.stage === 'duplicate_card');
      setDupCardIssues(dupCards);
      if (realFailed.length === 0 && dupCards.length === 0) {
        toast.success(`Добавлено в пул: ${agg.created.length}`);
        setRows([]);
        lastSeqRef.current = cardSeq;
      } else if (dupCards.length > 0) {
        toast.error(`Добавлено ${agg.created.length}; карт уже в пуле: ${dupCards.length}`);
      } else {
        // Не очищаем считанные карты; проблемные номера видны в блоке ниже (из матрицы).
        toast.error(`Добавлено ${agg.created.length}, проблем ${realFailed.length}`);
      }
      await refreshPool();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка добавления');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const runRetry = async (passNumbers?: string[]) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await contractorAdminService.retryProvisioning(passNumbers);
      if (res.failed.length === 0) {
        toast.success(`Повторно выпущено: ${res.created.length}`);
      } else {
        toast.error(`Выпущено ${res.created.length}, осталось проблем ${res.failed.length}`);
      }
      await refreshPool();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка повтора');
    } finally {
      setBusy(false);
    }
  };

  const runCancel = async (passNumbers: string[]) => {
    if (busy || passNumbers.length === 0) return;
    setBusy(true);
    try {
      const res = await contractorAdminService.cancelProvisioning(passNumbers);
      if (res.failed.length === 0) {
        toast.success(`Отменено выпусков: ${res.cancelled.length}`);
      } else {
        toast.error(`Отменено ${res.cancelled.length}, не удалось ${res.failed.length}`);
      }
      await refreshPool();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка отмены');
    } finally {
      setBusy(false);
    }
  };

  // Форсированное удаление из пула (+ профиль Sigur) по id строк. Освобождает номера.
  const runDelete = async (passIds: string[]) => {
    if (busy || passIds.length === 0) return;
    setBusy(true);
    try {
      const res = await contractorAdminService.deletePoolPasses(passIds);
      if (res.failed.length === 0) {
        toast.success(`Удалено из пула: ${res.deleted.length}`);
      } else {
        toast.error(`Удалено ${res.deleted.length}, не удалось ${res.failed.length}`);
      }
      setDelSel(new Set());
      setConfirmDelete(null);
      await refreshPool();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка удаления');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveFolder = async () => {
    setBusy(true);
    try {
      await contractorAdminService.setPoolSettings(draftFolderId);
      toast.success('Папка пула сохранена');
      setSelectFolderOpen(false);
      await qc.invalidateQueries({ queryKey: ['contractor-pool-settings'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const applySel = (id: string, mode: 'add' | 'remove') => {
    setSelected(prev => {
      if (mode === 'add') {
        if (prev.has(id)) return prev;
        const next = new Set(prev); next.add(id); return next;
      }
      if (!prev.has(id)) return prev;
      const next = new Set(prev); next.delete(id); return next;
    });
  };

  // Зажатие ЛКМ на свободной ячейке стартует протяжку; режим (add/remove)
  // определяется состоянием первой ячейки, затем применяется ко всем под курсором.
  const handleCellMouseDown = (id: string) => {
    const mode: 'add' | 'remove' = selected.has(id) ? 'remove' : 'add';
    dragRef.current = { mode };
    applySel(id, mode);
  };
  const handleCellMouseEnter = (id: string, buttons: number) => {
    if (!dragRef.current) return;
    if (buttons !== 1) { dragRef.current = null; return; }
    applySel(id, dragRef.current.mode);
  };

  const handleAssignSelected = async () => {
    if (!assignOrgId || selected.size === 0 || busy) return;
    setBusy(true);
    try {
      const res = await contractorAdminService.assignPool(Array.from(selected), assignOrgId);
      if (res.failed.length === 0) {
        toast.success(`Назначено пропусков: ${res.assigned.length}`);
      } else {
        toast.error(`Назначено ${res.assigned.length}, ошибок ${res.failed.length}`);
      }
      setSelected(new Set());
      await refreshPool();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка назначения');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignCount = async () => {
    const count = Number(countStr);
    if (!assignOrgId || !Number.isInteger(count) || count <= 0 || busy) return;
    if (count > freeCells.length) {
      toast.error(`Свободно только ${freeCells.length} пропусков`);
      return;
    }
    setBusy(true);
    try {
      const res = await contractorAdminService.assignPoolCount(count, assignOrgId);
      if (res.failed.length === 0) {
        toast.success(`Назначено пропусков: ${res.assigned.length}`);
      } else {
        toast.error(`Назначено ${res.assigned.length}, ошибок ${res.failed.length}`);
      }
      setCountStr('');
      await refreshPool();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка назначения');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className={styles.poolLayout}>
        <div className={styles.poolControls}>
      <div className={styles.field}>
        <span className={styles.label}>Папка общего пула в Sigur</span>
        <div className={styles.poolRow}>
          <span className={styles.statusNote}>
            {folderId == null
              ? 'Папка не настроена. Создайте её в Sigur вручную и выберите здесь.'
              : `Текущая: ${folderName ?? `#${folderId}`}`}
          </span>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => { setDraftFolderId(folderId); setSelectFolderOpen(true); }}
          >
            {folderId == null ? 'Выбрать папку' : 'Изменить'}
          </button>
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Пул пропусков (с — по)</span>
        <div className={styles.poolRow}>
          <input
            className={`${styles.input} ${styles.numInput}`}
            type="number"
            min={1}
            placeholder="с"
            value={fromStr}
            onChange={e => setFromStr(e.target.value)}
            disabled={busy || folderId == null}
          />
          <input
            className={`${styles.input} ${styles.numInput}`}
            type="number"
            min={1}
            placeholder="по"
            value={toStr}
            onChange={e => setToStr(e.target.value)}
            disabled={busy || folderId == null}
          />
        </div>
      </div>

      <div className={styles.statusNote}>
        {connected
          ? 'Считыватель готов — прикладывайте карты по порядку.'
          : 'Агент не запущен — запустите Sigur Reader EH.'}
      </div>

      {rows.length > 0 && (
        <>
          <div className={styles.scanActions}>
            <span className={styles.statusNote}>Считано карт: {rows.length}</span>
            <button
              className="btn-secondary"
              onClick={() => { setRows([]); lastSeqRef.current = cardSeq; }}
              disabled={busy}
            >
              Очистить
            </button>
          </div>
          <table className={styles.table}>
            <thead><tr><th>№</th><th>W26</th><th>Проверка</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.uid}>
                  <td>{passNumberAt(i)}</td>
                  <td title={r.uid}>{formatCardW26(r.uid)}</td>
                  <td>{renderCardCheck(r.conflict)}</td>
                  <td>
                    <button
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() => setRows(prev => prev.filter((_, j) => j !== i))}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {progress && (
        <div className={styles.progressWrap}>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
            />
          </div>
          <div className={styles.progressLabel}>Добавление: {progress.done} / {progress.total}</div>
        </div>
      )}

      <div className={styles.scanActions}>
        <button className="btn-primary" onClick={() => void handleAddToPool()} disabled={!canAddPool}>
          {busy ? 'Добавляю…' : 'Добавить в пул'}
        </button>
      </div>

      {dupCardIssues.length > 0 && (
        <div className={styles.issueProblems}>
          <div className={styles.issueProblemsHead}>
            <span>Карты уже в пуле — не добавлены ({dupCardIssues.length}):</span>
            <button className="btn-secondary" onClick={() => setDupCardIssues([])} disabled={busy}>
              Скрыть
            </button>
          </div>
          <ul className={styles.issueProblemsList}>
            {dupCardIssues.map(f => (
              <li key={f.pass_number}><b>{f.pass_number}</b> — {f.error}</li>
            ))}
          </ul>
        </div>
      )}

      {failedCells.length > 0 && (
        <div className={styles.issueProblems}>
          <div className={styles.issueProblemsHead}>
            <span>Ошибки выпуска ({failedCells.length}):</span>
            <button
              className="btn-secondary"
              onClick={() => void runRetry(failedCells.map(c => c.pass_number))}
              disabled={busy}
            >
              Повторить все
            </button>
          </div>
          <ul className={styles.issueProblemsList}>
            {failedCells.map(c => (
              <li key={c.pass_number}>
                <b>{c.pass_number}</b> — {c.error ?? 'ошибка выпуска'}
                <span className={styles.issueProblemActions}>
                  <button className="btn-secondary" onClick={() => void runRetry([c.pass_number])} disabled={busy}>
                    Повторить
                  </button>
                  <button className="btn-secondary" onClick={() => void runCancel([c.pass_number])} disabled={busy}>
                    Отменить выпуск
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {anomalies.length > 0 && (
        <div className={styles.issueProblems}>
          <div className={styles.issueProblemsHead}>
            <span>Проблемные пропуска в пуле ({anomalies.length}):</span>
            <button
              className="btn-secondary"
              onClick={() => setConfirmDelete({ ids: anomalies.map(a => a.id), labels: anomalies.map(a => `№${a.pass_number}`) })}
              disabled={busy}
            >
              Удалить все
            </button>
          </div>
          <ul className={styles.issueProblemsList}>
            {anomalies.map(a => (
              <li key={a.id}>
                <b>{a.pass_number}</b>{' — '}
                {a.reason === 'no_profile'
                  ? 'нет профиля в Sigur (карта никому не назначена)'
                  : `дубль карты${a.dup_with ? ` с № ${a.dup_with}` : ''}`}
                {a.card_uid ? ` · ${formatCardW26(a.card_uid)}` : ''}
                <span className={styles.issueProblemActions}>
                  <button
                    className="btn-secondary"
                    onClick={() => setConfirmDelete({ ids: [a.id], labels: [`№${a.pass_number}`] })}
                    disabled={busy}
                  >
                    Удалить из пула
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className={styles.title} style={{ marginTop: 24 }}>Назначение пропусков подрядчику</h3>
      <div className={styles.field}>
        <span className={styles.label}>Подрядная организация</span>
        <DepartmentTreeSelect
          departments={departments}
          value={assignOrgId}
          onChange={setAssignOrgId}
          isLoading={structureQuery.isLoading}
          isError={structureQuery.isError}
          onRetry={() => void structureQuery.refetch()}
          showAllOption={false}
          placeholder="Поиск папки подрядчика..."
        />
      </div>

      <div className={styles.toolbar}>
        <input
          className={`${styles.input} ${styles.numInput}`}
          type="number"
          min={1}
          placeholder="Сколько"
          value={countStr}
          onChange={e => setCountStr(e.target.value)}
          disabled={busy}
        />
        <button
          className="btn-primary"
          onClick={() => void handleAssignCount()}
          disabled={busy || !assignOrgId || !countStr}
          title={!assignOrgId ? 'Выберите подрядчика' : ''}
        >
          Назначить первые N свободных
        </button>
        <span className={styles.statusNote} style={{ marginLeft: 'auto' }}>
          Свободно: {totals.free}
        </span>
      </div>

      <div className={styles.toolbar}>
        <span className={styles.statusNote}>
          Или выберите конкретные пропуска в матрице ниже:
        </span>
        <button
          className="btn-primary"
          onClick={() => void handleAssignSelected()}
          disabled={busy || !assignOrgId || selected.size === 0}
          style={{ marginLeft: 'auto' }}
          title={!assignOrgId ? 'Выберите подрядчика' : ''}
        >
          Назначить выбранные ({selected.size})
        </button>
        {selected.size > 0 && (
          <button className="btn-secondary" onClick={() => setSelected(new Set())} disabled={busy}>
            Снять выделение
          </button>
        )}
      </div>

        </div>{/* /poolControls */}

        <div className={styles.poolMatrixSide}>
      <div className={styles.matrixHeader}>
        <span className={styles.title} style={{ fontSize: 14 }}>Матрица пула</span>
        <input
          type="search"
          inputMode="numeric"
          placeholder="Поиск по №"
          value={matrixSearch}
          onChange={e => setMatrixSearch(e.target.value)}
          className={styles.matrixSearch}
          title="Показать только пропуска с этим номером"
        />
        <span className={styles.statusNote}>
          Свободно: <b style={{ color: 'var(--success)' }}>{totals.free}</b>
          {' · '}
          Занято: <b style={{ color: 'var(--error)' }}>{totals.occupied}</b>
          {totals.provisioning > 0 && (
            <>{' · '}Выпускается: <b>{totals.provisioning}</b></>
          )}
          {totals.failed > 0 && (
            <>{' · '}Ошибки: <b style={{ color: 'var(--warning, #b8860b)' }}>{totals.failed}</b></>
          )}
        </span>
        {totals.failed > 0 && (
          <button
            className="btn-secondary"
            onClick={() => void runRetry()}
            disabled={busy}
            title="Повторить выпуск всех проблемных номеров"
          >
            Повторить ошибки ({totals.failed})
          </button>
        )}
        <label className={styles.deleteToggle} title="Режим удаления пропусков из пула (+ Sigur)">
          <input
            type="checkbox"
            checked={deleteMode}
            onChange={e => (e.target.checked ? setDeleteMode(true) : exitDeleteMode())}
            disabled={busy}
          />
          Режим удаления
        </label>
        {deleteMode && (
          <button
            className={styles.dangerBtn}
            onClick={() => setConfirmDelete({ ids: Array.from(delSel), labels: delSelLabels })}
            disabled={busy || delSel.size === 0}
          >
            Удалить выбранные ({delSel.size})
          </button>
        )}
      </div>

      {matrixQuery.isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : cells.length === 0 ? (
        <div className={styles.empty}>Пул пуст</div>
      ) : visibleCells.length === 0 ? (
        <div className={styles.empty}>Нет пропусков с номером «{matrixSearch.trim()}»</div>
      ) : (
        <div className={styles.matrix}>
          {visibleCells.map(c => {
            // Режим удаления: любая ячейка (кроме provisioning) кликается на пометку.
            if (deleteMode) {
              const delId = cellDeletableId(c);
              const base = c.status === 'free' ? styles.matrixCellFree
                : c.status === 'failed' ? styles.matrixCellFailed
                  : c.status === 'provisioning' ? styles.matrixCellProvisioning
                    : styles.matrixCellOccupied;
              if (!delId) {
                return (
                  <span key={c.pass_number} className={`${styles.matrixCell} ${base}`} aria-disabled title="Идёт выпуск — нельзя удалить">
                    {c.pass_number}
                  </span>
                );
              }
              const marked = delSel.has(delId);
              return (
                <button
                  key={c.pass_number}
                  type="button"
                  className={`${styles.matrixCell} ${base} ${marked ? styles.matrixCellDel : ''}`}
                  onClick={() => toggleDelSel(delId)}
                  disabled={busy}
                  title={marked ? 'Снять пометку удаления' : 'Пометить на удаление'}
                >
                  {c.pass_number}
                </button>
              );
            }
            // Ошибка выпуска — кликабельная ячейка: повтор по конкретному номеру.
            if (c.status === 'failed') {
              return (
                <button
                  key={c.pass_number}
                  type="button"
                  className={`${styles.matrixCell} ${styles.matrixCellFailed}`}
                  onClick={() => void runRetry([c.pass_number])}
                  disabled={busy}
                  title={`Ошибка выпуска${c.error ? `: ${c.error}` : ''}. Нажмите, чтобы повторить.`}
                >
                  {c.pass_number}
                </button>
              );
            }
            // Идёт выпуск (или завис) — нейтральная неактивная ячейка.
            if (c.status === 'provisioning') {
              return (
                <span
                  key={c.pass_number}
                  className={`${styles.matrixCell} ${styles.matrixCellProvisioning}`}
                  title="Выпускается…"
                  aria-disabled
                >
                  {c.pass_number}
                </span>
              );
            }
            const free = c.status === 'free' && c.id != null;
            const on = free ? selected.has(c.id as string) : false;
            const cls = `${styles.matrixCell} ${free ? styles.matrixCellFree : styles.matrixCellOccupied} ${on ? styles.matrixCellOn : ''}`;
            if (!free) {
              return (
                <span key={c.pass_number} className={cls} title="Занят" aria-disabled>
                  {c.pass_number}
                </span>
              );
            }
            const id = c.id as string;
            return (
              <button
                key={c.pass_number}
                type="button"
                className={cls}
                onMouseDown={e => { e.preventDefault(); if (!busy) handleCellMouseDown(id); }}
                onMouseEnter={e => { if (!busy) handleCellMouseEnter(id, e.buttons); }}
                disabled={busy}
                title={on ? 'Снять' : 'Выбрать'}
              >
                {c.pass_number}
              </button>
            );
          })}
        </div>
      )}
        </div>{/* /poolMatrixSide */}
      </div>{/* /poolLayout */}

      {selectFolderOpen && (
        <div
          className={styles.overlay}
          onMouseDown={settingsOverlay.onMouseDown}
          onMouseUp={settingsOverlay.onMouseUp}
          onMouseLeave={settingsOverlay.onMouseLeave}
          onTouchStart={settingsOverlay.onTouchStart}
          onTouchEnd={settingsOverlay.onTouchEnd}
        >
          <div className={styles.modal} style={{ maxWidth: 560 }}>
            <h2 className={styles.modalTitle}>Выбор папки общего пула</h2>
            <div className={styles.statusNote} style={{ marginBottom: 12 }}>
              Создайте папку в Sigur вручную, затем выберите её здесь.
            </div>
            {sigurDeptsQuery.isLoading ? (
              <div className={styles.empty}>Загрузка отделов Sigur…</div>
            ) : (
              <SigurDepartmentPicker
                nodes={sigurDeptsQuery.data ?? []}
                value={draftFolderId}
                onChange={setDraftFolderId}
              />
            )}
            <div className={styles.modalActions}>
              <button className="btn-secondary" onClick={() => setSelectFolderOpen(false)} disabled={busy}>Отмена</button>
              <button className="btn-primary" onClick={() => void handleSaveFolder()} disabled={busy || draftFolderId == null}>
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className={styles.overlay}
          onMouseDown={confirmOverlay.onMouseDown}
          onMouseUp={confirmOverlay.onMouseUp}
          onMouseLeave={confirmOverlay.onMouseLeave}
          onTouchStart={confirmOverlay.onTouchStart}
          onTouchEnd={confirmOverlay.onTouchEnd}
        >
          <div className={styles.modal} style={{ maxWidth: 480 }}>
            <h2 className={styles.modalTitle}>Удалить из пула?</h2>
            <div className={styles.statusNote} style={{ marginBottom: 12 }}>
              Будет удалено пропусков: <b>{confirmDelete.ids.length}</b>. Профили в Sigur будут
              снесены, номера освободятся. Назначенные подрядчику пропуска уйдут из заявки.
              Действие необратимо.
            </div>
            {confirmDelete.labels.length > 0 && (
              <div className={styles.statusNote} style={{ marginBottom: 12, maxHeight: 120, overflow: 'auto' }}>
                {confirmDelete.labels.join(', ')}
              </div>
            )}
            <div className={styles.modalActions}>
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)} disabled={busy}>Отмена</button>
              <button
                className={styles.dangerBtn}
                onClick={() => void runDelete(confirmDelete.ids)}
                disabled={busy || confirmDelete.ids.length === 0}
              >
                {busy ? 'Удаляю…' : `Удалить (${confirmDelete.ids.length})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PoolTab;
