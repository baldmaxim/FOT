import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { contractorAdminService, type IPassHistory } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

/** История пропуска: владельцы, решения, точки доступа, исправления ФИО. */
export const PassHistoryModal: FC<{ passId: string; onClose: () => void }> = ({ passId, onClose }) => {
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
            {(data.renameEvents?.length ?? 0) > 0 && (
              <>
                <h3 className={`${styles.title} ${styles.historySectionTitle}`}>Исправления ФИО</h3>
                <table className={styles.table}>
                  <thead>
                    <tr><th>Когда</th><th>Кто</th><th>Было</th><th>Стало</th></tr>
                  </thead>
                  <tbody>
                    {(data.renameEvents ?? []).map(e => (
                      <tr key={e.id}>
                        <td>{new Date(e.created_at).toLocaleString('ru')}</td>
                        <td>{e.changed_by_name ?? '—'}</td>
                        <td>{e.old_name ?? '—'}</td>
                        <td>{e.new_name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
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
            {(data.accessPointEvents?.length ?? 0) > 0 && (
              <>
                <h3 className={styles.title} style={{ marginTop: 16 }}>Изменения точек доступа</h3>
                <table className={styles.table}>
                  <thead>
                    <tr><th>Когда</th><th>Кто</th><th>Добавлены</th><th>Итог</th></tr>
                  </thead>
                  <tbody>
                    {data.accessPointEvents!.map(e => (
                      <tr key={e.id}>
                        <td>{new Date(e.created_at).toLocaleString('ru')}</td>
                        <td>{e.changed_by_name ?? '—'}</td>
                        <td>{(e.details?.added_names ?? []).join(', ') || '—'}</td>
                        <td>{(e.details?.total_names ?? []).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
        <div className={styles.modalActions}>
          <button className="btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
};
