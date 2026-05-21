import { useMemo, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { contractorAdminService, type ISentPassRow } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

const passLabel: Record<string, { cls: string; label: string }> = {
  assigned: { cls: '', label: 'ждёт ФИО' },
  submitted: { cls: '', label: 'на согласовании' },
  blocked: { cls: '', label: 'заблокирован' },
};

const approvalLabel: Record<string, string> = {
  not_submitted: 'не подано',
  pending: 'на рассмотрении',
  approved: 'одобрено',
  rejected: 'не одобрено',
};

export const SentTab: FC = () => {
  const query = useQuery({
    queryKey: ['contractor-sent-passes'],
    queryFn: () => contractorAdminService.listSentPasses(),
    staleTime: 15_000,
  });

  const grouped = useMemo(() => {
    const map = new Map<string, { org_name: string; rows: ISentPassRow[] }>();
    for (const row of query.data ?? []) {
      if (!map.has(row.org_department_id)) {
        map.set(row.org_department_id, { org_name: row.org_name, rows: [] });
      }
      map.get(row.org_department_id)!.rows.push(row);
    }
    return Array.from(map.entries()).map(([id, v]) => ({ id, ...v }));
  }, [query.data]);

  if (query.isLoading) return <div className={styles.empty}>Загрузка…</div>;
  if (grouped.length === 0) return <div className={styles.empty}>Нет отправленных пропусков</div>;

  return (
    <div>
      {grouped.map(g => (
        <div key={g.id} style={{ marginBottom: 24 }}>
          <h3 className={styles.title}>{g.org_name}</h3>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>№</th><th>UID</th><th>ФИО</th><th>Статус</th>
                <th>Согласование</th><th>Активен</th><th>Обновлён</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map(r => {
                const sl = passLabel[r.status] ?? { cls: '', label: r.status };
                return (
                  <tr key={r.id}>
                    <td>{r.pass_number}</td>
                    <td>{r.card_uid ?? '—'}</td>
                    <td>{r.holder_name ?? '—'}</td>
                    <td><span className={`${styles.badge} ${styles.badgePending}`}>{sl.label}</span></td>
                    <td>{approvalLabel[r.approval_status] ?? r.approval_status}</td>
                    <td>{r.is_active ? '✓' : '—'}</td>
                    <td>{new Date(r.updated_at).toLocaleString('ru')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
};

export default SentTab;
