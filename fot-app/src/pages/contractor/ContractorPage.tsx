import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { contractorService, type IRosterRow, type IPassRow, type IPassDocuments } from '../../services/contractorService';
import { citizenshipRequiresPatent } from '../../services/citizenship';
import { ContractorDocumentsBlock } from '../../components/contractor/ContractorDocumentsBlock';
import { PassDocumentsModal } from '../../components/contractor/PassDocumentsModal';
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

/**
 * Все документы держателя заполнены (для зелёной галочки на кнопке).
 * Паспорт, даты и гражданство — всегда; для патентных гражданств — патент,
 * НО ВНЖ его отменяет: с отметкой ВНЖ достаточно номера ВНЖ вместо патента.
 * Зеркало isDocsComplete на бэке (contractor-docs.service) — держать в синхроне.
 */
const hasAllDocs = (p: IPassRow): boolean => {
  const base = !!(p.passport_series_number?.trim() && p.passport_issue_date
    && p.birth_date && p.citizenship?.trim());
  if (!base) return false;
  if (!citizenshipRequiresPatent(p.citizenship)) return true;
  // ВНЖ отменяет патент: для патентной страны с ВНЖ нужен номер ВНЖ.
  if (p.has_residence_permit) return !!p.residence_permit_number?.trim();
  return !!(p.patent_number?.trim() && p.patent_issue_date && p.patent_blank_number?.trim());
};

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

  const changeOverlay = useOverlayDismiss(() => setChangeOwnerPass(null));

  const orgQuery = useQuery({ queryKey: ['contractor-org'], queryFn: contractorService.getMyOrg, staleTime: 5 * 60_000 });
  const rosterQuery = useQuery({ queryKey: ['contractor-roster'], queryFn: contractorService.getRoster, staleTime: 30_000 });
  const passesQuery = useQuery({ queryKey: ['contractor-passes'], queryFn: contractorService.getPasses, staleTime: 30_000, refetchInterval: 60_000, refetchOnWindowFocus: true });
  const subsQuery = useQuery({ queryKey: ['contractor-subs'], queryFn: contractorService.getSubmissions, staleTime: 30_000, refetchInterval: 60_000, refetchOnWindowFocus: true });
  // Сотрудники, прошедшие вводный инструктаж (реестр ОТиТБ) — подсказки ФИО для новых пропусков.
  const inductedQuery = useQuery({ queryKey: ['contractor-inducted'], queryFn: contractorService.getInductedPersons, staleTime: 60_000 });

  const inducted = inductedQuery.data ?? [];
  const roster = rosterQuery.data ?? [];
  const passes = passesQuery.data ?? [];
  const subs = subsQuery.data ?? [];
  const latest = subs[0];
  const hasPending = subs.some(s => s.status === 'pending');
  const filledCount = passes.filter(p => p.status === 'assigned' && !p.submission_id && (edited[p.id] ?? p.holder_name ?? '').trim().length >= 2).length;
  // Пропуска, готовые к отправке (ФИО есть), но без полного комплекта документов —
  // блокируют отправку всей заявки.
  const missingDocs = passes.filter(
    p => p.status === 'assigned' && !p.submission_id
      && (edited[p.id] ?? p.holder_name ?? '').trim().length >= 2
      && !hasAllDocs(p),
  );
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

  const saveDocs = (docs: IPassDocuments) => {
    if (!docsPass) return;
    const passId = docsPass.id;
    setBusy(true);
    contractorService
      .savePassDocuments(passId, docs)
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
                  disabled={busy || hasPending || filledCount === 0 || missingDocs.length > 0}
                  title={hasPending ? 'Уже есть заявка на согласовании'
                    : filledCount === 0 ? 'Впишите ФИО хотя бы в один пропуск'
                    : missingDocs.length > 0 ? `Заполните документы у пропусков: ${missingDocs.map(p => `№${p.pass_number}`).join(', ')}` : ''}
                >
                  Отправить на согласование ({filledCount})
                </button>
              </div>
              {missingDocs.length > 0 && (
                <div className={styles.warnNote}>
                  Нельзя отправить: у пропусков с вписанным ФИО не заполнены документы —{' '}
                  <b>{missingDocs.map(p => `№${p.pass_number}`).join(', ')}</b>. Откройте «Документы»
                  и заполните паспорт, патент и дату рождения.
                </div>
              )}
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
                <>
                {/* Подсказки ФИО из реестра ОТиТБ (прошедшие вводный инструктаж). Не ограничивает
                    ручной ввод — только подставляет заранее заведённых сотрудников. */}
                <datalist id="contractor-inducted-list">
                  {inducted.map(pers => (
                    <option key={pers.id} value={pers.full_name} />
                  ))}
                </datalist>
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
                                list="contractor-inducted-list"
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
                                onClick={() => setDocsPass(p)}
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
                </>
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
        <PassDocumentsModal
          documents={docsPass}
          holderName={docsPass.holder_name}
          passNumber={docsPass.pass_number}
          readOnly={docsPass.approval_status === 'approved' || docsPass.status === 'submitted'}
          readOnlyReason={
            docsPass.status === 'submitted'
              ? 'Пропуск на согласовании — изменения недоступны до решения'
              : undefined
          }
          busy={busy}
          onClose={() => setDocsPass(null)}
          onSave={saveDocs}
        />
      )}
    </div>
  );
};

export default ContractorPage;
