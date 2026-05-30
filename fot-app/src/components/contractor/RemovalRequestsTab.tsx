import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { contractorAdminService, type IRemovalRequest } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

const fmtDate = (iso: string | null): string => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('ru-RU'); } catch { return iso; }
};

export const RemovalRequestsTab: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ['contractor-removals'],
    queryFn: () => contractorAdminService.listRemovals(),
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  const grouped = useMemo(() => {
    const map = new Map<string, { org_name: string; rows: IRemovalRequest[] }>();
    for (const row of query.data ?? []) {
      if (!map.has(row.org_department_id)) {
        map.set(row.org_department_id, { org_name: row.org_name, rows: [] });
      }
      map.get(row.org_department_id)!.rows.push(row);
    }
    return Array.from(map.entries()).map(([id, v]) => ({ id, ...v }));
  }, [query.data]);

  const toggleOrg = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleApprove = async (r: IRemovalRequest) => {
    if (busyId) return;
    setBusyId(r.roster_id);
    try {
      await contractorAdminService.approveRemoval(r.roster_id);
      qc.setQueryData<IRemovalRequest[]>(['contractor-removals'], prev =>
        (prev ?? []).filter(row => row.roster_id !== r.roster_id),
      );
      toast.success(`${r.full_name}: уволен`);
      await qc.invalidateQueries({ queryKey: ['contractor-removals'] });
      await qc.invalidateQueries({ queryKey: ['contractor-removals-count'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось уволить');
    } finally {
      setBusyId(null);
    }
  };

  if (query.isLoading) return <div className={styles.empty}>Загрузка…</div>;
  if (grouped.length === 0) return <div className={styles.empty}>Нет заявок на удаление</div>;

  return (
    <div>
      {grouped.map(g => {
        const open = !collapsed.has(g.id);
        return (
          <div key={g.id} style={{ marginBottom: 24 }}>
            <button
              className={styles.sideMenuItem}
              style={{ width: '100%', justifyContent: 'flex-start', gap: 8 }}
              onClick={() => toggleOrg(g.id)}
            >
              <span style={{ width: 14 }}>{open ? '▾' : '▸'}</span>
              <span className={styles.title} style={{ fontSize: 15 }}>{g.org_name}</span>
              <span className={styles.tabBadge}>{g.rows.length}</span>
            </button>
            {open && (
              <table className={styles.table}>
                <thead>
                  <tr><th>ФИО</th><th>Дата заявки</th><th>Сотрудник</th><th></th></tr>
                </thead>
                <tbody>
                  {g.rows.map(r => {
                    const notSynced = r.employee_id == null;
                    const fired = r.employment_status === 'fired';
                    return (
                      <tr key={r.roster_id}>
                        <td>{r.full_name}</td>
                        <td>{fmtDate(r.removal_requested_at)}</td>
                        <td>
                          {notSynced
                            ? <span className={`${styles.badge} ${styles.badgeRemove}`}>не синхронизирован</span>
                            : fired
                              ? <span className={`${styles.badge} ${styles.badgePending}`}>уже уволен</span>
                              : '—'}
                        </td>
                        <td>
                          <button
                            className="btn-primary"
                            onClick={() => void handleApprove(r)}
                            disabled={busyId === r.roster_id || notSynced}
                            title={notSynced ? 'Сотрудник ещё не синхронизирован из Sigur' : 'Уволить сотрудника'}
                          >
                            {busyId === r.roster_id ? '…' : 'Одобрить удаление'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default RemovalRequestsTab;
