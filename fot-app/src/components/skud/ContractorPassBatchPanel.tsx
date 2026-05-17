import { useState, useMemo, useEffect, useRef, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useStructureTree } from '../../hooks/useStructure';
import { useCardReaderAgent } from '../../contexts/CardReaderAgentContext';
import { contractorAdminService, type IIssuePassBatchResult } from '../../services/contractorService';
import { DepartmentTreeSelect } from '../staff/DepartmentTreeSelect';
import { findDepartmentName } from '../../utils/departmentUtils';
import type { OrgDepartmentNode } from '../../types/organization';
import styles from '../../pages/contractor/Contractor.module.css';

const CHUNK = 10;

const defaultExpiry = (): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 5);
  return d.toISOString().slice(0, 10);
};

interface IScanRow {
  uid: string;
}

export const ContractorPassBatchPanel: FC = () => {
  const toast = useToast();
  const { connected, lastCard, cardSeq } = useCardReaderAgent();

  const [orgId, setOrgId] = useState('');
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [pointNames, setPointNames] = useState<string[]>([]);
  const [fromStr, setFromStr] = useState('');
  const [toStr, setToStr] = useState('');
  const [expiresAt, setExpiresAt] = useState(defaultExpiry());
  const [rows, setRows] = useState<IScanRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<IIssuePassBatchResult | null>(null);
  const lastSeqRef = useRef(0);

  const structureQuery = useStructureTree();
  const departments = useMemo<OrgDepartmentNode[]>(
    () => structureQuery.data?.departments ?? [],
    [structureQuery.data?.departments],
  );

  const objectsQuery = useQuery({
    queryKey: ['contractor-issue-objects'],
    queryFn: () => contractorAdminService.listIssueObjects(),
    staleTime: 5 * 60_000,
  });

  const apQuery = useQuery({
    queryKey: ['contractor-issue-access-points', [...objectIds].sort().join(',')],
    queryFn: () => contractorAdminService.listObjectAccessPoints(objectIds),
    enabled: objectIds.length > 0,
    staleTime: 5 * 60_000,
  });

  // Прешник стартового номера при выборе организации.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    contractorAdminService.getNextPassNumber(orgId)
      .then(n => { if (!cancelled) setFromStr(String(n)); })
      .catch(() => { /* пользователь введёт вручную */ });
    return () => { cancelled = true; };
  }, [orgId]);

  // Уникальные имена точек выбранных объектов; по умолчанию все отмечены.
  const allPointNames = useMemo(
    () => [...new Set((apQuery.data ?? []).map(p => p.access_point_name))],
    [apQuery.data],
  );
  useEffect(() => {
    setPointNames(allPointNames);
  }, [allPointNames]);

  const objectLabel = useMemo(
    () => (objectsQuery.data ?? [])
      .filter(o => objectIds.includes(o.id))
      .map(o => o.name)
      .join(', '),
    [objectsQuery.data, objectIds],
  );
  const orgName = useMemo(
    () => (orgId ? findDepartmentName(departments, orgId) ?? '' : ''),
    [departments, orgId],
  );

  const fromNum = Number(fromStr);
  const toNum = toStr ? Number(toStr) : null;
  const width = useMemo(() => {
    const maxNum = Math.max(toNum ?? 0, (Number.isFinite(fromNum) ? fromNum : 1) + Math.max(rows.length - 1, 0));
    return Math.max(2, String(maxNum || 1).length);
  }, [fromNum, toNum, rows.length]);
  const passNumberAt = (idx: number): string =>
    String((Number.isFinite(fromNum) ? fromNum : 1) + idx).padStart(width, '0');

  // Считывание карт: каждая новая карта — новая строка (дедуп по UID).
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

  const clearRows = () => {
    setRows([]);
    setResult(null);
    lastSeqRef.current = cardSeq;
  };

  const removeRow = (idx: number) => {
    setRows(prev => prev.filter((_, i) => i !== idx));
  };

  const canIssue =
    !!orgId &&
    objectIds.length > 0 &&
    pointNames.length > 0 &&
    rows.length > 0 &&
    Number.isInteger(fromNum) && fromNum > 0 &&
    (toNum == null || (Number.isInteger(toNum) && toNum >= fromNum + rows.length - 1)) &&
    !busy;

  const handleIssue = async () => {
    if (!canIssue) return;
    setBusy(true);
    setResult(null);
    const cards = rows.map((r, i) => ({ uid: r.uid, sequence: i }));
    const chunks: Array<typeof cards> = [];
    for (let i = 0; i < cards.length; i += CHUNK) chunks.push(cards.slice(i, i + CHUNK));
    setProgress({ done: 0, total: cards.length });

    const agg: IIssuePassBatchResult = { created: [], failed: [], warnings: [] };
    try {
      for (let k = 0; k < chunks.length; k += 1) {
        const data = await contractorAdminService.issuePassBatch({
          org_department_id: orgId,
          from: fromNum,
          to: toNum ?? undefined,
          object_ids: objectIds,
          access_point_names: pointNames,
          expires_at: expiresAt || undefined,
          cards: chunks[k],
          notify: k === chunks.length - 1,
        });
        agg.created.push(...data.created);
        agg.failed.push(...data.failed);
        agg.warnings.push(...data.warnings);
        setProgress({ done: Math.min((k + 1) * CHUNK, cards.length), total: cards.length });
      }
      setResult(agg);
      if (agg.failed.length === 0) {
        toast.success(`Выпущено пропусков: ${agg.created.length}`);
        clearRows();
      } else {
        toast.error(`Создано ${agg.created.length}, ошибок ${agg.failed.length}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка выпуска');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const toggleObject = (id: string) => {
    setObjectIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const togglePoint = (name: string) => {
    setPointNames(prev => prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]);
  };

  return (
    <div>
      <div className={styles.field}>
        <span className={styles.label}>Подрядчик (папка Sigur)</span>
        <DepartmentTreeSelect
          departments={departments}
          value={orgId}
          onChange={setOrgId}
          isLoading={structureQuery.isLoading}
          isError={structureQuery.isError}
          onRetry={() => void structureQuery.refetch()}
          showAllOption={false}
          placeholder="Поиск папки Sigur..."
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Объекты</span>
        {objectsQuery.isLoading ? (
          <div className={styles.statusNote}>Загрузка…</div>
        ) : (
          <div className={styles.checkList}>
            {(objectsQuery.data ?? []).map(o => (
              <label
                key={o.id}
                className={`${styles.checkItem} ${objectIds.includes(o.id) ? styles.checkItemOn : ''}`}
              >
                <input
                  type="checkbox"
                  checked={objectIds.includes(o.id)}
                  onChange={() => toggleObject(o.id)}
                  disabled={busy}
                />
                {o.name}
              </label>
            ))}
            {(objectsQuery.data ?? []).length === 0 && (
              <span className={styles.statusNote}>Нет активных объектов</span>
            )}
          </div>
        )}
      </div>

      {objectIds.length > 0 && (
        <div className={styles.field}>
          <span className={styles.label}>Точки доступа</span>
          {apQuery.isLoading ? (
            <div className={styles.statusNote}>Загрузка…</div>
          ) : (
            <div className={styles.checkList}>
              {allPointNames.map(name => (
                <label
                  key={name}
                  className={`${styles.checkItem} ${pointNames.includes(name) ? styles.checkItemOn : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={pointNames.includes(name)}
                    onChange={() => togglePoint(name)}
                    disabled={busy}
                  />
                  {name}
                </label>
              ))}
              {allPointNames.length === 0 && (
                <span className={styles.statusNote}>У выбранных объектов нет точек доступа</span>
              )}
            </div>
          )}
        </div>
      )}

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
            disabled={busy}
          />
          <input
            className={`${styles.input} ${styles.numInput}`}
            type="number"
            min={1}
            placeholder="по"
            value={toStr}
            onChange={e => setToStr(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Срок действия пропуска</span>
        <input
          className={`${styles.input} ${styles.numInput}`}
          type="date"
          value={expiresAt}
          onChange={e => setExpiresAt(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className={styles.statusNote}>
        {connected
          ? 'Считыватель готов — прикладывайте карты по порядку.'
          : 'Агент не запущен — запустите Sigur Reader EH (вкладка «Считыватель»).'}
      </div>

      {rows.length > 0 && (
        <>
          <div className={styles.scanActions}>
            <span className={styles.statusNote}>Считано карт: {rows.length}</span>
            <button className="btn-secondary" onClick={clearRows} disabled={busy}>
              Очистить всё
            </button>
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Порядковый №</th><th>UID</th><th>Организация</th><th>Доступ к объектам</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.uid}>
                  <td>{passNumberAt(i)}</td>
                  <td>{r.uid}</td>
                  <td>{orgName || '—'}</td>
                  <td>{objectLabel || '—'}</td>
                  <td>
                    <button className="btn-secondary" onClick={() => removeRow(i)} disabled={busy}>
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
          <div className={styles.progressLabel}>
            Выпуск: {progress.done} / {progress.total}
          </div>
        </div>
      )}

      <div className={styles.scanActions}>
        <button className="btn-primary" onClick={() => void handleIssue()} disabled={!canIssue}>
          {busy ? 'Выпускаю…' : 'Выпустить пропуска'}
        </button>
      </div>

      {result && (
        <div style={{ marginTop: 12 }}>
          <div className={styles.statusNote}>
            Создано: {result.created.length ? result.created.join(', ') : '—'}
          </div>
          {result.failed.length > 0 && (
            <div className={styles.errorNote}>
              Ошибки:
              {result.failed.map(f => `\n${f.pass_number}: ${f.error}`).join('')}
            </div>
          )}
          {result.warnings.length > 0 && (
            <div className={styles.errorNote}>
              Предупреждения:
              {result.warnings.map(w => `\n${w}`).join('')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
