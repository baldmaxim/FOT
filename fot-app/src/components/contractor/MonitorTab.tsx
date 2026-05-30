import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { contractorAdminService, type IPassHistory } from '../../services/contractorService';
import { ContractorOrgSelect } from './ContractorOrgSelect';
import styles from '../../pages/contractor/Contractor.module.css';

/** Застрявшие отзывы: вернулись в пул в БД, но Sigur не подтвердил перенос/блокировку. */
const SyncFailedPanel: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['contractor-sync-failed'],
    queryFn: contractorAdminService.listSyncFailed,
    staleTime: 15_000,
    refetchInterval: 20_000,
  });
  const rows = q.data ?? [];
  if (rows.length === 0) return null;

  const retry = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await contractorAdminService.retrySync(id);
      toast.success('Повтор синхронизации запущен');
      await qc.invalidateQueries({ queryKey: ['contractor-sync-failed'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={styles.docsBlock} style={{ borderColor: 'var(--error)', marginBottom: 20 }}>
      <h3 className={styles.title} style={{ color: 'var(--error)' }}>
        Проблемы синхронизации отзыва с Sigur ({rows.length})
      </h3>
      <div className={styles.statusNote} style={{ margin: '8px 0' }}>
        Пропуска вернулись в пул в системе, но Sigur не подтвердил перенос/блокировку после
        нескольких попыток. Профиль в Sigur может остаться в чужой папке, под прежним ФИО или
        разблокированным — проверьте вручную и нажмите «Повторить».
      </div>
      <table className={styles.table}>
        <thead>
          <tr><th>№</th><th>Ошибка</th><th>Попыток</th><th>Обновлён</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.pass_number}</td>
              <td style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{r.sigur_sync_error ?? '—'}</td>
              <td>{r.sigur_sync_attempts}</td>
              <td>{r.sigur_sync_updated_at ? new Date(r.sigur_sync_updated_at).toLocaleString('ru') : '—'}</td>
              <td>
                <button className="btn-secondary" disabled={busyId === r.id} onClick={() => void retry(r.id)}>
                  {busyId === r.id ? '…' : 'Повторить'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const PassHistoryModal: FC<{ passId: string; onClose: () => void }> = ({ passId, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const query = useQuery<IPassHistory>({
    queryKey: ['contractor-pass-history', passId],
    queryFn: () => contractorAdminService.getPassHistoryAdmin(passId),
  });
  const data = query.data;
  return (
    <div
      className={styles.overlay}
      onMouseDown={overlay.onMouseDown}
      onMouseUp={overlay.onMouseUp}
      onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart}
      onTouchEnd={overlay.onTouchEnd}
    >
      <div className={styles.modal} style={{ maxWidth: 640 }}>
        <h2 className={styles.modalTitle}>История пропуска</h2>
        {query.isLoading && <div className={styles.detailRow}>Загрузка…</div>}
        {data && (
          <>
            <h3 className={styles.title}>Владельцы</h3>
            <table className={styles.table}>
              <thead>
                <tr><th>С</th><th>По</th><th>ФИО</th><th>Кто записал</th><th>Кто одобрил</th></tr>
              </thead>
              <tbody>
                {data.holders.map(h => (
                  <tr key={h.id}>
                    <td>{h.valid_from}</td>
                    <td>{h.valid_until ?? '—'}</td>
                    <td>{h.holder_name}</td>
                    <td>{h.changed_by_name ?? '—'}</td>
                    <td>
                      {h.approved_by_name
                        ? `${h.approved_by_name}${h.approved_at ? ` (${new Date(h.approved_at).toLocaleString('ru')})` : ''}`
                        : '—'}
                    </td>
                  </tr>
                ))}
                {data.holders.length === 0 && <tr><td colSpan={5}>—</td></tr>}
              </tbody>
            </table>
            <h3 className={styles.title} style={{ marginTop: 16 }}>Решения</h3>
            <table className={styles.table}>
              <thead>
                <tr><th>Когда</th><th>Решение</th><th>Кто</th><th>Точки</th><th>Причина</th></tr>
              </thead>
              <tbody>
                {data.decisions.map(d => (
                  <tr key={d.id}>
                    <td>{new Date(d.decided_at).toLocaleString('ru')}</td>
                    <td>{d.decision === 'approved' ? 'одобрено' : 'отклонено'}</td>
                    <td>{d.decided_by_name ?? '—'}</td>
                    <td>{(d.access_point_names ?? []).join(', ') || '—'}</td>
                    <td>{d.reason ?? '—'}</td>
                  </tr>
                ))}
                {data.decisions.length === 0 && <tr><td colSpan={5}>—</td></tr>}
              </tbody>
            </table>
          </>
        )}
        <div className={styles.modalActions}>
          <button className="btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
};

export const MonitorTab: FC = () => {
  const [orgId, setOrgId] = useState('');
  const [historyPassId, setHistoryPassId] = useState<string | null>(null);

  const orgsQuery = useQuery({
    queryKey: ['contractor-orgs'],
    queryFn: contractorAdminService.listOrgs,
    staleTime: 5 * 60_000,
  });
  const passesQuery = useQuery({
    queryKey: ['contractor-monitor', orgId],
    queryFn: () => contractorAdminService.listMonitor(orgId),
    enabled: !!orgId,
    staleTime: 15_000,
  });

  const orgs = orgsQuery.data ?? [];
  const passes = passesQuery.data ?? [];

  return (
    <div>
      <SyncFailedPanel />
      <div className={styles.field}>
        <span className={styles.label}>Подрядчик</span>
        <ContractorOrgSelect
          orgs={orgs}
          value={orgId}
          onChange={setOrgId}
          emptyOptionLabel="— выбрать —"
          loading={orgsQuery.isLoading}
        />
      </div>

      {!orgId && <div className={styles.empty}>Выберите подрядчика</div>}

      {orgId && passesQuery.isLoading && <div className={styles.empty}>Загрузка…</div>}

      {orgId && !passesQuery.isLoading && passes.length === 0 && (
        <div className={styles.empty}>Нет пропусков</div>
      )}

      {orgId && passes.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>№</th><th>UID</th><th>ФИО</th><th>Статус</th><th>Согласование</th>
              <th>Активен</th><th>Объекты</th><th>Точки</th><th>Срок</th><th></th>
            </tr>
          </thead>
          <tbody>
            {passes.map(p => (
              <tr key={p.id}>
                <td>{p.pass_number}</td>
                <td>{p.card_uid ?? '—'}</td>
                <td>{p.holder_name ?? '—'}</td>
                <td>{p.status}</td>
                <td>{p.approval_status}</td>
                <td>
                  <span className={`${styles.badge} ${p.is_active ? styles.badgeActive : styles.badgeRemove}`}>
                    {p.is_active ? 'активен' : 'не активен'}
                  </span>
                </td>
                <td>{p.object_label || '—'}</td>
                <td>{(p.access_point_names ?? []).join(', ') || '—'}</td>
                <td>{p.expires_at ?? '—'}</td>
                <td>
                  <button className="btn-secondary" onClick={() => setHistoryPassId(p.id)}>
                    История
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {historyPassId && (
        <PassHistoryModal passId={historyPassId} onClose={() => setHistoryPassId(null)} />
      )}
    </div>
  );
};

export default MonitorTab;
