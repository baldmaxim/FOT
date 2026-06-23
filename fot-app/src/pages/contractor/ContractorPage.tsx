import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { contractorService, type IRosterRow, type IPassRow } from '../../services/contractorService';
import { ContractorDocumentsBlock } from '../../components/contractor/ContractorDocumentsBlock';
import styles from './Contractor.module.css';

type Tab = 'roster' | 'passes' | 'removals';

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

/** Маска номера патента: «77 №2600295204» (2 цифры серии + 10 цифр номера). */
const formatPatentNumber = (raw: string): string => {
  const digits = raw.replace(/\D/g, '').slice(0, 12);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)} №${digits.slice(2)}`;
};

/** Все документы держателя заполнены (для зелёной галочки на кнопке). */
const hasAllDocs = (p: IPassRow): boolean =>
  !!(p.passport_series_number?.trim() && p.passport_issue_date
    && p.patent_number?.trim() && p.patent_issue_date);

export const ContractorPage: FC = () => {
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('passes');
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [changeOwnerPass, setChangeOwnerPass] = useState<IPassRow | null>(null);
  const [changeOwnerName, setChangeOwnerName] = useState('');
  const [changeOwnerDate, setChangeOwnerDate] = useState(new Date().toISOString().slice(0, 10));
  const [docsPass, setDocsPass] = useState<IPassRow | null>(null);
  const [docForm, setDocForm] = useState({
    passport_series_number: '',
    passport_issue_date: '',
    patent_number: '',
    patent_issue_date: '',
    patent_blank_number: '',
  });

  const changeOverlay = useOverlayDismiss(() => setChangeOwnerPass(null));
  const docsOverlay = useOverlayDismiss(() => setDocsPass(null));

  const orgQuery = useQuery({ queryKey: ['contractor-org'], queryFn: contractorService.getMyOrg, staleTime: 5 * 60_000 });
  const rosterQuery = useQuery({ queryKey: ['contractor-roster'], queryFn: contractorService.getRoster, staleTime: 30_000 });
  const passesQuery = useQuery({ queryKey: ['contractor-passes'], queryFn: contractorService.getPasses, staleTime: 30_000, refetchInterval: 60_000, refetchOnWindowFocus: true });
  const subsQuery = useQuery({ queryKey: ['contractor-subs'], queryFn: contractorService.getSubmissions, staleTime: 30_000, refetchInterval: 60_000, refetchOnWindowFocus: true });

  const roster = rosterQuery.data ?? [];
  const passes = passesQuery.data ?? [];
  const subs = subsQuery.data ?? [];
  const latest = subs[0];
  const hasPending = subs.some(s => s.status === 'pending');
  const filledCount = passes.filter(p => p.status === 'assigned' && !p.submission_id && (edited[p.id] ?? p.holder_name ?? '').trim().length >= 2).length;
  // Сохранённые, но ещё не отправленные на согласование пропуска (по данным сервера, без черновиков).
  const unsentCount = passes.filter(p => p.status === 'assigned' && !p.submission_id && (p.holder_name ?? '').trim().length >= 2).length;
  const removals = roster.filter(r => r.state === 'pending_remove');

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

  const saveHolder = async (p: IPassRow) => {
    const value = (edited[p.id] ?? p.holder_name ?? '').trim();
    if (value === (p.holder_name ?? '')) return;
    if (value && value.length < 2) {
      toast.error('ФИО — минимум 2 символа');
      return;
    }
    await run(() => contractorService.setPassHolder(p.id, value || null));
  };

  const openDocs = (p: IPassRow) => {
    setDocForm({
      passport_series_number: p.passport_series_number ?? '',
      passport_issue_date: (p.passport_issue_date ?? '').slice(0, 10),
      patent_number: p.patent_number ?? '',
      patent_issue_date: (p.patent_issue_date ?? '').slice(0, 10),
      patent_blank_number: p.patent_blank_number ?? '',
    });
    setDocsPass(p);
  };

  const saveDocs = () => {
    if (!docsPass) return;
    const passId = docsPass.id;
    setBusy(true);
    contractorService
      .savePassDocuments(passId, {
        passport_series_number: docForm.passport_series_number.trim() || null,
        passport_issue_date: docForm.passport_issue_date || null,
        patent_number: docForm.patent_number.trim() || null,
        patent_issue_date: docForm.patent_issue_date || null,
        patent_blank_number: docForm.patent_blank_number.trim() || null,
      })
      .then(async () => {
        toast.success('Документы сохранены');
        setDocsPass(null);
        await refresh();
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Не удалось сохранить'))
      .finally(() => setBusy(false));
  };

  const statusLabel: Record<string, string> = {
    pending: 'на согласовании',
    approved: 'согласовано',
    rejected: 'отклонено',
    partially_applied: 'частично применено',
  };

  const menu: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: 'passes', label: 'Заявки на пропуска', badge: unsentCount },
    { id: 'roster', label: 'Сотрудники' },
    { id: 'removals', label: 'Заявки на удаление', badge: removals.length },
  ];

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

      <div className={styles.cabinetLayout}>
        <nav className={styles.sideMenu}>
          {menu.map(m => (
            <button
              key={m.id}
              className={`${styles.sideMenuItem} ${tab === m.id ? styles.sideMenuItemActive : ''}`}
              onClick={() => setTab(m.id)}
            >
              <span>{m.label}</span>
              {m.badge ? <span className={styles.tabBadge}>{m.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div className={styles.cabinetContent}>
          {tab === 'roster' && (
            <>
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
                            {!locked && r.state === 'pending_remove' && (
                              <button
                                className="btn-secondary"
                                onClick={() => run(() => contractorService.unmark(r.id))}
                                disabled={busy}
                              >
                                Вернуть
                              </button>
                            )}
                            {!locked && r.state === 'pending_add' && (
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

          {tab === 'removals' && (
            <>
              <div className={styles.statusNote} style={{ marginBottom: 12 }}>
                Сотрудники, отмеченные на удаление. Заявка уходит администратору —
                после одобрения сотрудник будет уволен.
              </div>
              {removals.length === 0 ? (
                <div className={styles.empty}>Нет заявок на удаление</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr><th>ФИО</th><th>Дата заявки</th><th>Статус</th><th></th></tr>
                  </thead>
                  <tbody>
                    {removals.map(r => (
                      <tr key={r.id}>
                        <td>{r.full_name}</td>
                        <td>{fmtDate(r.removal_requested_at)}</td>
                        <td><span className={`${styles.badge} ${styles.badgePending}`}>на рассмотрении</span></td>
                        <td>
                          {!r.submission_id && (
                            <button
                              className="btn-secondary"
                              onClick={() => run(() => contractorService.unmark(r.id))}
                              disabled={busy}
                            >
                              Вернуть
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {tab === 'passes' && (
            <>
              <ContractorDocumentsBlock />
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
              {hasPending && filledCount > 0 && (
                <div className={styles.warnNote}>
                  Пропуска с вписанным ФИО ({filledCount}) ещё <b>не отправлены</b>: они уйдут на
                  согласование только после одобрения текущей заявки. Как только её одобрят —
                  вернитесь сюда и нажмите «Отправить на согласование» ещё раз.
                </div>
              )}
              {passesQuery.isLoading ? (
                <div className={styles.empty}>Загрузка…</div>
              ) : passes.length === 0 ? (
                <div className={styles.empty}>Пропуска ещё не выпущены администратором</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>№ пропуска</th><th>Организация</th><th>Доступ к объектам</th>
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
                            <div className={styles.actionsCell}>
                              <button
                                className="btn-secondary"
                                disabled={busy}
                                onClick={() => openDocs(p)}
                                title={hasAllDocs(p) ? 'Документы заполнены' : 'Заполнить документы'}
                              >
                                Документы
                                {hasAllDocs(p) && (
                                  <span className={styles.docCheck} aria-hidden="true">✓</span>
                                )}
                              </button>
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
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>

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

      {docsPass && (
        <div
          className={styles.overlay}
          onMouseDown={docsOverlay.onMouseDown}
          onMouseUp={docsOverlay.onMouseUp}
          onMouseLeave={docsOverlay.onMouseLeave}
          onTouchStart={docsOverlay.onTouchStart}
          onTouchEnd={docsOverlay.onTouchEnd}
        >
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>
              Документы — {docsPass.holder_name ?? `пропуск № ${docsPass.pass_number}`}
            </h2>
            <div className={styles.field}>
              <span className={styles.label}>Паспорт серия номер</span>
              <input
                className={`${styles.input} ${styles.fullInput}`}
                value={docForm.passport_series_number}
                autoFocus
                placeholder="Серия и номер"
                onChange={e => setDocForm(prev => ({ ...prev, passport_series_number: e.target.value }))}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Дата выдачи документа, удостоверяющего личность</span>
              <input
                className={`${styles.input} ${styles.numInput}`}
                type="date"
                value={docForm.passport_issue_date}
                onChange={e => setDocForm(prev => ({ ...prev, passport_issue_date: e.target.value }))}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Номер патента</span>
              <input
                className={`${styles.input} ${styles.fullInput}`}
                value={docForm.patent_number}
                inputMode="numeric"
                placeholder="77 №2600295204"
                onChange={e => setDocForm(prev => ({ ...prev, patent_number: formatPatentNumber(e.target.value) }))}
              />
            </div>
            <div className={styles.docRow}>
              <div className={styles.field}>
                <span className={styles.label}>Дата выдачи патента</span>
                <input
                  className={`${styles.input} ${styles.numInput}`}
                  type="date"
                  value={docForm.patent_issue_date}
                  onChange={e => setDocForm(prev => ({ ...prev, patent_issue_date: e.target.value }))}
                />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Номер бланка</span>
                <input
                  className={`${styles.input} ${styles.fullInput}`}
                  value={docForm.patent_blank_number}
                  placeholder="Например: ПР8048893"
                  onChange={e => setDocForm(prev => ({ ...prev, patent_blank_number: e.target.value }))}
                />
              </div>
            </div>
            <div className={styles.modalActions}>
              <button
                className="btn-secondary"
                onClick={() => setDocsPass(null)}
                disabled={busy}
              >
                Отмена
              </button>
              <button
                className="btn-primary"
                onClick={saveDocs}
                disabled={busy}
              >
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContractorPage;
