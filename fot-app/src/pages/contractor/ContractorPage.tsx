import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { contractorService, type IRosterRow, type IPassRow } from '../../services/contractorService';
import styles from './Contractor.module.css';

type Tab = 'roster' | 'passes';

const stateBadge = (state: IRosterRow['state']): { cls: string; label: string } => {
  switch (state) {
    case 'pending_add': return { cls: styles.badgeAdd, label: 'Добавлен' };
    case 'pending_remove': return { cls: styles.badgeRemove, label: 'На удаление' };
    default: return { cls: styles.badgeActive, label: 'Активен' };
  }
};

const passBadge = (status: IPassRow['status']): { cls: string; label: string } => {
  switch (status) {
    case 'applied': return { cls: styles.badgeActive, label: 'выдан' };
    case 'assigned': return { cls: styles.badgePending, label: 'на согласовании' };
    case 'revoked': return { cls: styles.badgeRemove, label: 'отозван' };
    default: return { cls: styles.badgeAdd, label: 'свободен' };
  }
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('ru-RU'); } catch { return iso; }
};

export const ContractorPage: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('passes');
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState<Record<string, string>>({});

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
  const filledCount = passes.filter(p => p.status === 'issued' && !p.submission_id && (edited[p.id] ?? p.holder_name ?? '').trim().length >= 2).length;

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

  const saveHolder = async (p: IPassRow) => {
    const value = (edited[p.id] ?? p.holder_name ?? '').trim();
    if (value === (p.holder_name ?? '')) return;
    if (value && value.length < 2) {
      toast.error('ФИО — минимум 2 символа');
      return;
    }
    await run(() => contractorService.setPassHolder(p.id, value || null));
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
          className={`${styles.tab} ${tab === 'passes' ? styles.tabActive : ''}`}
          onClick={() => setTab('passes')}
        >
          Назначение пропусков
        </button>
        <button
          className={`${styles.tab} ${tab === 'roster' ? styles.tabActive : ''}`}
          onClick={() => setTab('roster')}
        >
          Сотрудники
        </button>
      </div>

      {tab === 'roster' && (
        <>
          <div className={styles.toolbar}>
            <button className="btn-primary" onClick={() => setAddOpen(true)} disabled={busy}>
              Добавить
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
        <>
          <div className={styles.toolbar}>
            <button
              className="btn-primary"
              onClick={() => run(() => contractorService.submit(), 'Отправлено на согласование')}
              disabled={busy || hasPending || filledCount === 0}
              title={hasPending ? 'Уже есть заявка на согласовании'
                : filledCount === 0 ? 'Впишите ФИО хотя бы в один пропуск' : ''}
            >
              Отправить на согласование ({filledCount})
            </button>
          </div>
          {passesQuery.isLoading ? (
            <div className={styles.empty}>Загрузка…</div>
          ) : passes.length === 0 ? (
            <div className={styles.empty}>Пропуска ещё не выпущены администратором</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>№ пропуска</th><th>UID</th><th>Организация</th><th>Доступ к объектам</th>
                  <th>Срок</th><th>ФИО</th><th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {passes.map(p => {
                  const b = passBadge(p.status);
                  const editable = p.status === 'issued' && !p.submission_id;
                  const value = edited[p.id] ?? p.holder_name ?? '';
                  return (
                    <tr key={p.id}>
                      <td>{p.pass_number}</td>
                      <td>{p.card_uid ?? '—'}</td>
                      <td>{orgQuery.data?.name ?? '—'}</td>
                      <td>{p.object_label || '—'}</td>
                      <td>{fmtDate(p.expires_at)}</td>
                      <td>
                        {editable ? (
                          <input
                            className={`${styles.input} ${styles.fullInput}`}
                            value={value}
                            placeholder="Фамилия Имя Отчество"
                            disabled={busy}
                            onChange={e => setEdited(prev => ({ ...prev, [p.id]: e.target.value }))}
                            onBlur={() => void saveHolder(p)}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          />
                        ) : (
                          p.holder_name ?? '—'
                        )}
                      </td>
                      <td><span className={`${styles.badge} ${b.cls}`}>{b.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
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
