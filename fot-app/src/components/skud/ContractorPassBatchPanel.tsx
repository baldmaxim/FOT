import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { contractorAdminService } from '../../services/contractorService';
import { adminService } from '../../services/adminService';
import styles from '../../pages/contractor/Contractor.module.css';

export const ContractorPassBatchPanel: FC = () => {
  const toast = useToast();
  const [orgId, setOrgId] = useState('');
  const [objectId, setObjectId] = useState('');
  const [count, setCount] = useState('10');
  const [cardUids, setCardUids] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: string[]; failed: Array<{ pass_number: string; error: string }> } | null>(null);

  const orgsQuery = useQuery({
    queryKey: ['contractor-admin-orgs'],
    queryFn: contractorAdminService.listOrgs,
    staleTime: 5 * 60_000,
  });

  const objectsQuery = useQuery({
    queryKey: ['skud-objects-for-assignment'],
    queryFn: () => adminService.listSkudObjectsForAssignment(),
    staleTime: 5 * 60_000,
  });

  const handleIssue = async () => {
    const n = Number(count);
    if (!orgId) { toast.error('Выберите организацию'); return; }
    if (!Number.isInteger(n) || n <= 0 || n > 500) { toast.error('Количество 1–500'); return; }
    setBusy(true);
    setResult(null);
    try {
      const uids = cardUids.split('\n').map(s => s.trim()).filter(Boolean);
      const data = await contractorAdminService.issuePassBatch({
        org_department_id: orgId,
        count: n,
        card_uids: uids.length ? uids : undefined,
        skud_object_id: objectId || null,
      });
      setResult({ created: data.created, failed: data.failed });
      toast.success(`Создано пропусков: ${data.created.length}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка выпуска');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <div className={styles.field}>
        <span className={styles.label}>Подрядная организация</span>
        <select
          className={styles.select}
          value={orgId}
          onChange={e => setOrgId(e.target.value)}
          disabled={busy || orgsQuery.isLoading}
        >
          <option value="">— выбрать —</option>
          {(orgsQuery.data ?? []).map(o => (
            <option key={o.id} value={o.id} disabled={o.sigur_department_id == null}>
              {o.name}{o.sigur_department_id == null ? ' (нет в Sigur)' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Объект (точки доступа) — опционально</span>
        <select
          className={styles.select}
          value={objectId}
          onChange={e => setObjectId(e.target.value)}
          disabled={busy || objectsQuery.isLoading}
        >
          <option value="">— без объекта —</option>
          {(objectsQuery.data ?? []).map(o => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Количество пропусков</span>
        <input
          className={styles.input}
          type="number"
          min={1}
          max={500}
          value={count}
          onChange={e => setCount(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>UID карт (по одному в строке, по порядку — опционально)</span>
        <textarea
          className={styles.textarea}
          value={cardUids}
          onChange={e => setCardUids(e.target.value)}
          disabled={busy}
          placeholder={'04A1B2C3\n04A1B2C4'}
        />
      </div>

      <button className={styles.btnPrimary} onClick={() => void handleIssue()} disabled={busy}>
        {busy ? 'Выпускаю…' : 'Выпустить пропуска'}
      </button>

      {result && (
        <div style={{ marginTop: 16 }}>
          <div className={styles.statusNote}>
            Создано: {result.created.length ? result.created.join(', ') : '—'}
          </div>
          {result.failed.length > 0 && (
            <div className={styles.errorNote}>
              Ошибки:
              {result.failed.map(f => `\n${f.pass_number}: ${f.error}`).join('')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
