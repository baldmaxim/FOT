import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { contractorService, type IRosterRow } from '../../services/contractorService';
import styles from './Contractor.module.css';

type Tab = 'roster' | 'passes';

const stateBadge = (state: IRosterRow['state']): { cls: string; label: string } => {
  switch (state) {
    case 'pending_add': return { cls: styles.badgeAdd, label: 'Добавлен' };
    case 'pending_remove': return { cls: styles.badgeRemove, label: 'На удаление' };
    default: return { cls: styles.badgeActive, label: 'Активен' };
  }
};

export const ContractorPage: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('roster');
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const overlay = useOverlayDismiss(() => setAddOpen(false));

  const orgQuery = useQuery({ queryKey: ['contractor-org'], queryFn: contractorService.getMyOrg, staleTime: 5 * 60_000 });
  const rosterQuery = useQuery({ queryKey: ['contractor-roster'], queryFn: contractorService.getRoster, staleTime: 30_000 });
  const passesQuery = useQuery({ queryKey: ['contractor-passes'], queryFn: contractorService.getPasses, staleTime: 30_000 });
  const subsQuery = useQuery({ queryKey: ['contractor-subs'], queryFn: contractorService.getSubmissions, staleTime: 30_000 });

  const roster = rosterQuery.data ?? [];
  const passes = passesQuery.data ?? [];
  const subs = subsQuery.data ?? [];
  const latest = subs[0];
  const hasPending = subs.some(s => s.status === 'pending');
  const assignable = roster.filter(r => r.state !== 'pending_remove');

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['contractor-roster'] }),
      qc.invalidateQueries({ queryKey: ['contractor-passes'] }),
      qc.invalidateQueries({ queryKey: ['contractor-subs'] }),
    ]);
  };

  const run = async (fn: () => Promise<void>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async () => {
    const name = newName.trim();
    if (name.length < 2) {
      toast.error('Введите ФИО');
      return;
    }
    await run(() => contractorService.addPerson(name), 'Человек добавлен');
    setNewName('');
    setAddOpen(false);
  };

  const statusLabel: Record<string, string> = {
    pending: 'на согласовании',
    approved: 'согласовано',
    rejected: 'отклонено',
    partially_applied: 'частично применено',
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        {orgQuery.data && (
          <span className={styles.orgName}>{orgQuery.data.name}</span>
        )}
        {latest && (
          <span className={styles.statusNote}>
            Заявка: <b>{statusLabel[latest.status] ?? latest.status}</b>
            {latest.comment ? ` — ${latest.comment}` : ''}
          </span>
        )}
      </div>

      {latest?.apply_error && (
        <div className={styles.errorNote}>Ошибки применения: {latest.apply_error}</div>
      )}

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'roster' ? styles.tabActive : ''}`}
          onClick={() => setTab('roster')}
        >
          Сотрудники
        </button>
        <button
          className={`${styles.tab} ${tab === 'passes' ? styles.tabActive : ''}`}
          onClick={() => setTab('passes')}
        >
          Назначение пропусков
        </button>
      </div>

      {tab === 'roster' && (
        <>
          <div className={styles.toolbar}>
            <button className="btn-primary" onClick={() => setAddOpen(true)} disabled={busy}>
              Добавить
            </button>
            <button
              className="btn-secondary"
              onClick={() => run(() => contractorService.submit(), 'Отправлено на согласование')}
              disabled={busy || hasPending}
              title={hasPending ? 'Уже есть заявка на согласовании' : ''}
            >
              Отправить на согласование
            </button>
          </div>
          {rosterQuery.isLoading ? (
            <div className={styles.empty}>Загрузка…</div>
          ) : roster.length === 0 ? (
            <div className={styles.empty}>Список пуст</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr><th>ФИО</th><th>Статус</th><th>Пропуск</th><th></th></tr>
              </thead>
              <tbody>
                {roster.map(r => {
                  const b = stateBadge(r.state);
                  const locked = !!r.submission_id;
                  return (
                    <tr key={r.id}>
                      <td>{r.full_name}</td>
                      <td><span className={`${styles.badge} ${b.cls}`}>{b.label}</span></td>
                      <td>{r.assigned_pass_number ?? '—'}</td>
                      <td>
                        {!locked && r.state === 'active' && (
                          <button
                            className="btn-secondary"
                            onClick={() => run(() => contractorService.markRemoval(r.id))}
                            disabled={busy}
                          >
                            Удалить
                          </button>
                        )}
                        {!locked && (r.state === 'pending_add' || r.state === 'pending_remove') && (
                          <button
                            className="btn-secondary"
                            onClick={() => run(() => contractorService.unmark(r.id))}
                            disabled={busy}
                          >
                            Отменить
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}

      {tab === 'passes' && (
        passesQuery.isLoading ? (
          <div className={styles.empty}>Загрузка…</div>
        ) : passes.length === 0 ? (
          <div className={styles.empty}>Пропуска ещё не выпущены администратором</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr><th>№ пропуска</th><th>Статус</th><th>Назначен</th><th>Назначить</th></tr>
            </thead>
            <tbody>
              {passes.map(p => {
                const applied = p.status === 'applied';
                return (
                  <tr key={p.id}>
                    <td>{p.pass_number}</td>
                    <td>
                      <span className={`${styles.badge} ${applied ? styles.badgeActive : styles.badgePending}`}>
                        {applied ? 'выдан' : p.status === 'assigned' ? 'назначен' : 'свободен'}
                      </span>
                    </td>
                    <td>{p.assigned_full_name ?? '—'}</td>
                    <td>
                      <select
                        className={styles.select}
                        value={p.assigned_roster_id ?? ''}
                        disabled={busy || applied}
                        onChange={e => {
                          const rosterId = e.target.value;
                          if (rosterId) run(() => contractorService.assignPass(p.id, rosterId), 'Назначено');
                        }}
                      >
                        <option value="">— выбрать —</option>
                        {assignable.map(r => (
                          <option key={r.id} value={r.id}>{r.full_name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}

      {addOpen && (
        <div
          className={styles.overlay}
          onMouseDown={overlay.onMouseDown}
          onMouseUp={overlay.onMouseUp}
          onMouseLeave={overlay.onMouseLeave}
          onTouchStart={overlay.onTouchStart}
          onTouchEnd={overlay.onTouchEnd}
        >
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>Новый человек</h2>
            <div className={styles.field}>
              <span className={styles.label}>ФИО</span>
              <input
                className={styles.input}
                value={newName}
                autoFocus
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleAdd(); }}
              />
            </div>
            <div className={styles.modalActions}>
              <button className="btn-secondary" onClick={() => setAddOpen(false)} disabled={busy}>Отмена</button>
              <button className="btn-primary" onClick={() => void handleAdd()} disabled={busy}>Добавить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContractorPage;
