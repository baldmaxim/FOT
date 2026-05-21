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
    case 'submitted': return { cls: styles.badgePending, label: 'на согласовании' };
    case 'blocked': return { cls: styles.badgeRemove, label: 'заблокирован' };
    case 'revoked': return { cls: styles.badgeRemove, label: 'отозван' };
    case 'assigned': return { cls: styles.badgeAdd, label: 'ждёт ФИО' };
    default: return { cls: styles.badgeAdd, label: status };
  }
};

const approvalBadge = (status: IPassRow['approval_status']): { cls: string; label: string } | null => {
  switch (status) {
    case 'pending': return { cls: styles.badgePending, label: 'на рассмотрении' };
    case 'approved': return { cls: styles.badgeActive, label: 'одобрено' };
    case 'rejected': return { cls: styles.badgeRemove, label: 'не одобрено' };
    default: return null;
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
  const [changeOwnerPass, setChangeOwnerPass] = useState<IPassRow | null>(null);
  const [changeOwnerName, setChangeOwnerName] = useState('');
  const [changeOwnerDate, setChangeOwnerDate] = useState(new Date().toISOString().slice(0, 10));

  const overlay = useOverlayDismiss(() => setAddOpen(false));
  const changeOverlay = useOverlayDismiss(() => setChangeOwnerPass(null));

  const orgQuery = useQuery({ queryKey: ['contractor-org'], queryFn: contractorService.getMyOrg, staleTime: 5 * 60_000 });
  const rosterQuery = useQuery({ queryKey: ['contractor-roster'], queryFn: contractorService.getRoster, staleTime: 30_000 });
  const passesQuery = useQuery({ queryKey: ['contractor-passes'], queryFn: contractorService.getPasses, staleTime: 30_000 });
  const subsQuery = useQuery({ queryKey: ['contractor-subs'], queryFn: contractorService.getSubmissions, staleTime: 30_000 });

  const roster = rosterQuery.data ?? [];
  const passes = passesQuery.data ?? [];
  const subs = subsQuery.data ?? [];
  const latest = subs[0];
  const hasPending = subs.some(s => s.status === 'pending');
  const filledCount = passes.filter(p => p.status === 'assigned' && !p.submission_id && (edited[p.id] ?? p.holder_name ?? '').trim().length >= 2).length;

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
                  <th>Срок</th><th>ФИО</th><th>Статус</th><th></th>
                </tr>
              </thead>
              <tbody>
                {passes.map(p => {
                  const b = passBadge(p.status);
                  const ap = approvalBadge(p.approval_status);
                  const editable = p.status === 'assigned' && !p.submission_id;
                  const canChangeOwner = p.status === 'applied' || (p.status === 'blocked' && !p.submission_id);
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
                      <td>
                        <span className={`${styles.badge} ${b.cls}`}>{b.label}</span>
                        {ap && <>{' '}<span className={`${styles.badge} ${ap.cls}`}>{ap.label}</span></>}
                      </td>
                      <td>
                        {canChangeOwner && (
                          <button
                            className="btn-secondary"
                            disabled={busy}
                            onClick={() => {
                              setChangeOwnerPass(p);
                              setChangeOwnerName('');
                              setChangeOwnerDate(new Date().toISOString().slice(0, 10));
                            }}
                          >
                            Сменить владельца
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

      {changeOwnerPass && (
        <div
          className={styles.overlay}
          onMouseDown={changeOverlay.onMouseDown}
          onMouseUp={changeOverlay.onMouseUp}
          onMouseLeave={changeOverlay.onMouseLeave}
          onTouchStart={changeOverlay.onTouchStart}
          onTouchEnd={changeOverlay.onTouchEnd}
        >
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>Смена владельца пропуска № {changeOwnerPass.pass_number}</h2>
            <div className={styles.statusNote} style={{ marginBottom: 12 }}>
              Текущий владелец: <b>{changeOwnerPass.holder_name ?? '—'}</b>
              <br />
              Пропуск будет заблокирован в Sigur до повторного одобрения админом.
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Новое ФИО</span>
              <input
                className={styles.input}
                value={changeOwnerName}
                autoFocus
                placeholder="Фамилия Имя Отчество"
                onChange={e => setChangeOwnerName(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Дата вступления</span>
              <input
                className={`${styles.input} ${styles.numInput}`}
                type="date"
                value={changeOwnerDate}
                onChange={e => setChangeOwnerDate(e.target.value)}
              />
            </div>
            <div className={styles.modalActions}>
              <button
                className="btn-secondary"
                onClick={() => setChangeOwnerPass(null)}
                disabled={busy}
              >
                Отмена
              </button>
              <button
                className="btn-primary"
                disabled={busy || changeOwnerName.trim().length < 2}
                onClick={() => {
                  const passId = changeOwnerPass.id;
                  const name = changeOwnerName.trim();
                  const date = changeOwnerDate;
                  setChangeOwnerPass(null);
                  void run(
                    () => contractorService.changeHolder(passId, name, date).then(() => undefined),
                    'Отправлено админу на согласование',
                  );
                }}
              >
                Сменить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContractorPage;
