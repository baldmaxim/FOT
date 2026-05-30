import { useState, useMemo, useEffect, useRef, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useStructureTree } from '../../hooks/useStructure';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useCardReaderAgent } from '../../contexts/CardReaderAgentContext';
import { contractorAdminService, type IFreePass, type ISigurDepartmentNode } from '../../services/contractorService';
import { DepartmentTreeSelect } from '../staff/DepartmentTreeSelect';
import { PoolRangesHeader } from './PoolRangesHeader';
import type { OrgDepartmentNode } from '../../types/organization';
import styles from '../../pages/contractor/Contractor.module.css';

const CHUNK = 10;

interface IScanRow {
  uid: string;
}

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
  const lastSeqRef = useRef(0);

  const settingsOverlay = useOverlayDismiss(() => setSelectFolderOpen(false));

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
  const freeQuery = useQuery({
    queryKey: ['contractor-pool-free'],
    queryFn: contractorAdminService.getFreePasses,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  const folderId = settingsQuery.data?.sigur_department_id ?? null;
  const folderName = settingsQuery.data?.name ?? null;
  const freePasses: IFreePass[] = useMemo(() => freeQuery.data ?? [], [freeQuery.data]);
  const freeIds = useMemo(() => new Set(freePasses.map(p => p.id)), [freePasses]);

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
  }, [freeQuery.dataUpdatedAt]);

  // Считывание карт.
  useEffect(() => {
    if (cardSeq === 0 || cardSeq === lastSeqRef.current) return;
    lastSeqRef.current = cardSeq;
    const uid = lastCard?.sigurCard?.trim();
    if (!uid) return;
    setRows(prev => {
      if (prev.some(r => r.uid === uid)) {
        toast.error(`Карта ${uid} уже считана`);
        return prev;
      }
      return [...prev, { uid }];
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardSeq]);

  const fromNum = Number(fromStr);
  const toNum = toStr ? Number(toStr) : null;
  const width = useMemo(() => {
    const maxNum = Math.max(toNum ?? 0, (Number.isFinite(fromNum) ? fromNum : 1) + Math.max(rows.length - 1, 0));
    return Math.max(2, String(maxNum || 1).length);
  }, [fromNum, toNum, rows.length]);
  const passNumberAt = (idx: number): string =>
    String((Number.isFinite(fromNum) ? fromNum : 1) + idx).padStart(width, '0');

  const canAddPool =
    folderId != null &&
    rows.length > 0 &&
    Number.isInteger(fromNum) && fromNum > 0 &&
    (toNum == null || (Number.isInteger(toNum) && toNum >= fromNum + rows.length - 1)) &&
    !busy;

  const refreshPool = async () => {
    await qc.invalidateQueries({ queryKey: ['contractor-pool-free'] });
    await qc.invalidateQueries({ queryKey: ['contractor-pool-ranges'] });
  };

  const handleAddToPool = async () => {
    if (!canAddPool) return;
    setBusy(true);
    const cards = rows.map((r, i) => ({ uid: r.uid, sequence: i }));
    const chunks: Array<typeof cards> = [];
    for (let i = 0; i < cards.length; i += CHUNK) chunks.push(cards.slice(i, i + CHUNK));
    setProgress({ done: 0, total: cards.length });

    const agg = { created: [] as string[], failed: [] as Array<{ pass_number: string; error: string }>, warnings: [] as string[] };
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
      if (agg.failed.length === 0) {
        toast.success(`Добавлено в пул: ${agg.created.length}`);
        setRows([]);
        lastSeqRef.current = cardSeq;
      } else {
        toast.error(`Добавлено ${agg.created.length}, ошибок ${agg.failed.length}`);
      }
      await refreshPool();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка добавления');
    } finally {
      setBusy(false);
      setProgress(null);
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

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
    if (count > freePasses.length) {
      toast.error(`Свободно только ${freePasses.length} пропусков`);
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
            <thead><tr><th>№</th><th>UID</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.uid}>
                  <td>{passNumberAt(i)}</td>
                  <td>{r.uid}</td>
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

      <PoolRangesHeader />

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
          Свободно: {freePasses.length}
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

      {freeQuery.isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : freePasses.length === 0 ? (
        <div className={styles.empty}>Свободных пропусков нет</div>
      ) : (
        <div className={styles.matrix}>
          {freePasses.map(p => {
            const on = selected.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`${styles.matrixCell} ${on ? styles.matrixCellOn : ''}`}
                onClick={() => toggleSelect(p.id)}
                disabled={busy}
                title={on ? 'Снять' : 'Выбрать'}
              >
                {p.pass_number}
              </button>
            );
          })}
        </div>
      )}

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
    </div>
  );
};

export default PoolTab;
