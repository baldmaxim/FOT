import { useMemo, useRef, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  hiringRequestService, FUNNEL_KEYS, stageMeta, CANDIDATE_STATUS_META,
  type HiringStage, type IHiringCandidate,
} from '../../../services/hiringRequestService';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { ApiError } from '../../../api/client';
import { Avatar, pluralDays, fmtDate } from './hiringUi';
import { HiringRequestCreateModal } from './HiringRequestCreateModal';
import { HIRING_QK } from './HiringRequestsBoard';
import styles from './hiring.module.css';

interface IProps { requestId: number; canManage: boolean; onClose: () => void }

export const HiringRequestPanel: FC<IProps> = ({ requestId, canManage: canManageHint, onClose }) => {
  const { profile, isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const myEmp = profile?.employee_id ?? null;
  const [rejectOpen, setRejectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const qk = ['hiring-request', requestId];
  const { data: r, isLoading } = useQuery({ queryKey: qk, queryFn: () => hiringRequestService.getById(requestId) });
  const recruitersQuery = useQuery({ queryKey: ['hiring-recruiters'], queryFn: () => hiringRequestService.listRecruiters(), enabled: canManageHint });

  const invalidate = () => { qc.invalidateQueries({ queryKey: qk }); qc.invalidateQueries({ queryKey: HIRING_QK }); };
  const onErr = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Ошибка');

  const stageMut = useMutation({ mutationFn: (s: HiringStage) => hiringRequestService.changeStage(requestId, s), onSuccess: invalidate, onError: onErr });
  const urgentMut = useMutation({ mutationFn: (u: boolean) => hiringRequestService.setUrgent(requestId, u), onSuccess: invalidate, onError: onErr });
  const resubmitMut = useMutation({ mutationFn: () => hiringRequestService.resubmit(requestId), onSuccess: () => { invalidate(); toast.success('Заявка пересдана'); }, onError: onErr });
  const finalizeMut = useMutation({
    mutationFn: (confirmPartial: boolean) => hiringRequestService.finalize(requestId, confirmPartial),
    onSuccess: () => { invalidate(); toast.success('Набор утверждён'); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PARTIAL') {
        if (confirm('Выбрано меньше требуемого числа. Закрыть набор с меньшим числом?')) finalizeMut.mutate(true);
      } else onErr(e);
    },
  });
  const addAssigneeMut = useMutation({ mutationFn: (emp: number) => hiringRequestService.addAssignee(requestId, emp), onSuccess: invalidate, onError: onErr });
  const removeAssigneeMut = useMutation({ mutationFn: (emp: number) => hiringRequestService.removeAssignee(requestId, emp), onSuccess: invalidate, onError: onErr });
  const primaryMut = useMutation({ mutationFn: (emp: number) => hiringRequestService.setPrimary(requestId, emp), onSuccess: invalidate, onError: onErr });
  const commentMut = useMutation({ mutationFn: (body: string) => hiringRequestService.addComment(requestId, body), onSuccess: invalidate, onError: onErr });
  const vacancyMut = useMutation({ mutationFn: (url: string) => hiringRequestService.update(requestId, { hh_vacancy_url: url || null }), onSuccess: () => { invalidate(); toast.success('Ссылка на вакансию сохранена'); setVacEdit(null); }, onError: onErr });
  const fileMut = useMutation({ mutationFn: (file: File) => hiringRequestService.uploadFile(requestId, file), onSuccess: () => { invalidate(); toast.success('Файл прикреплён'); }, onError: onErr });

  const canWork = useMemo(() => {
    if (!r) return false;
    if (isAdmin || r.can_manage) return true;
    return myEmp != null && r.assignees.some(a => a.employee_id === myEmp);
  }, [r, isAdmin, myEmp]);
  const isAuthor = r != null && myEmp != null && r.author_employee_id === myEmp;
  const canManage = (r?.can_manage ?? canManageHint) || isAdmin;
  const canApprove = isAuthor || canManage;

  const [comment, setComment] = useState('');
  const [vacEdit, setVacEdit] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (isLoading || !r) {
    return (
      <>
        <div className={styles.overlay} onClick={onClose} />
        <div className={styles.panel}><div className={styles.pBody}>Загрузка…</div></div>
      </>
    );
  }

  const m = stageMeta(r.stage);
  const approvedCount = r.candidates.filter(c => c.applicant_approved).length;
  const fpct = r.headcount > 0 ? Math.min(100, Math.round((approvedCount / r.headcount) * 100)) : 0;
  const assigneeEmps = new Set(r.assignees.map(a => a.employee_id));
  const poolToAdd = (recruitersQuery.data ?? []).filter(x => !assigneeEmps.has(x.employee_id));

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div className={styles.panel} role="dialog" aria-modal="true">
        {/* HEADER */}
        <div className={styles.pHead}>
          <div className={styles.pHeadTop}>
            <div>
              <div className={styles.pTitle}>{r.position_title}</div>
              <div className={styles.pMeta}>
                <span style={{ color: m.color, fontWeight: 700 }}>● {m.label}</span>
                <span className={styles.dotsep}>·</span>
                <span>👤 {r.headcount} чел.</span>
                <span className={styles.dotsep}>·</span>
                <span>{r.stage === 'closed' ? `закрыта за ${r.days_in_work} дн` : r.stage === 'rework' ? 'ждёт заявителя' : `⏱ ${r.days_in_work} ${pluralDays(r.days_in_work)} в работе`}</span>
                {r.deadline && <><span className={styles.dotsep}>·</span><span>дедлайн {fmtDate(r.deadline)}</span></>}
                {r.is_urgent && <><span className={styles.dotsep}>·</span><span style={{ color: 'var(--error)', fontWeight: 700 }}>Срочная</span></>}
              </div>
            </div>
            <button className={styles.x} onClick={onClose}>✕</button>
          </div>

          {r.stage !== 'rework' && (
            <div className={styles.stepper}>
              {FUNNEL_KEYS.map(s => {
                const sm = stageMeta(s);
                const isActive = s === r.stage;
                const isDone = sm.idx < m.idx;
                return (
                  <button
                    key={s}
                    className={`${styles.step} ${isActive ? styles.active : ''} ${isDone ? styles.done : ''}`}
                    disabled={!canWork || stageMut.isPending}
                    onClick={() => canWork && stageMut.mutate(s)}
                  >
                    <span className={styles.mk} />{sm.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* BODY */}
        <div className={styles.pBody}>
          {r.stage === 'rework' && r.rework_reason && (
            <div className={styles.reworkBanner}>↩ <b>Возвращена на доработку.</b><br />{r.rework_reason}</div>
          )}

          {/* Ответственные (manage) */}
          {canManage && (
            <div className={styles.sec}>
              <div className={styles.secH}><h4>Ответственные</h4></div>
              {r.assignees.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Не назначены.</div>}
              {r.assignees.map(a => (
                <div key={a.employee_id} className={styles.candRow} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <Avatar name={a.full_name} id={a.employee_id} />
                  <span className={styles.candName}>{a.full_name}{a.is_primary && ' · главный'}</span>
                  {!a.is_primary && <button className={styles.mini} onClick={() => primaryMut.mutate(a.employee_id)}>Сделать главным</button>}
                  <button className={`${styles.mini} ${styles.no}`} onClick={() => removeAssigneeMut.mutate(a.employee_id)}>✕</button>
                </div>
              ))}
              {poolToAdd.length > 0 && (
                <select className={styles.poolSearch} style={{ marginTop: 10, marginBottom: 0 }} defaultValue=""
                  onChange={e => { const v = Number(e.target.value); if (v) addAssigneeMut.mutate(v); e.currentTarget.value = ''; }}>
                  <option value="">+ Добавить ответственного из пула…</option>
                  {poolToAdd.map(x => <option key={x.employee_id} value={x.employee_id}>{x.full_name}</option>)}
                </select>
              )}
            </div>
          )}

          {/* Воронка кандидатов */}
          <div className={styles.sec}>
            <div className={styles.secH}><h4>Воронка кандидатов</h4><span className={styles.right}>{approvedCount} из {r.headcount} выбрано</span></div>
            <div className={styles.fprog}><span style={{ width: `${fpct}%` }} /></div>
            {r.candidates.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Пока нет кандидатов.</div>}
            {r.candidates.map(c => (
              <CandidateRow
                key={c.id} c={c} requestId={requestId}
                canWork={canWork} canApprove={canApprove}
                approvedReached={approvedCount >= r.headcount}
                onChanged={invalidate}
              />
            ))}
            {canWork && <AddCandidate requestId={requestId} onAdded={invalidate} />}

            {canApprove && approvedCount > 0 && !r.applicant_finalized_at && (
              <button className={styles.finalizeCta} disabled={finalizeMut.isPending} onClick={() => finalizeMut.mutate(false)}>
                Утвердить набор ({approvedCount}/{r.headcount})
              </button>
            )}
            {r.applicant_finalized_at && <div className={styles.finalizedBadge}>✓ Набор утверждён заявителем</div>}
          </div>

          {/* Первичка */}
          <div className={styles.sec}>
            <div className={styles.secH}><h4>Заявка</h4><span className={styles.right}>read-only</span></div>
            <dl className={styles.kv}>
              <dt>Заказчик</dt><dd>{r.customer_name || '—'}</dd>
              <dt>Требуется</dt><dd>{r.headcount} чел. · {r.gender === 'male' ? 'Мужской' : r.gender === 'female' ? 'Женский' : 'Не важно'}</dd>
              {r.experience && <><dt>Опыт</dt><dd>{r.experience}</dd></>}
              {r.salary_level && <><dt>Оклад</dt><dd>{r.salary_level}</dd></>}
              {r.duties && <><dt>Обязанности</dt><dd>{r.duties}</dd></>}
              {r.requirements && <><dt>Требования</dt><dd>{r.requirements}</dd></>}
              {r.software && <><dt>Программы</dt><dd><div className={styles.chips}>{r.software.split(',').map((s, i) => <span key={i} className={styles.chip}>{s.trim()}</span>)}</div></dd></>}
              {r.start_work_date && <><dt>Дата заявки</dt><dd>{fmtDate(r.start_work_date)}</dd></>}
            </dl>
          </div>

          {/* Вакансия */}
          <div className={styles.sec}>
            <div className={styles.secH}>
              <h4>Вакансия и источники</h4>
              {canWork && vacEdit === null && (
                <button className={styles.mini} onClick={() => setVacEdit(r.hh_vacancy_url ?? '')}>
                  {r.hh_vacancy_url ? '✎ Изменить' : '＋ Добавить ссылку'}
                </button>
              )}
            </div>
            {vacEdit !== null ? (
              <div>
                <input
                  className={styles.poolSearch}
                  style={{ marginBottom: 6 }}
                  placeholder="https://hh.kz/vacancy/..."
                  value={vacEdit}
                  onChange={e => setVacEdit(e.target.value)}
                />
                <div className={styles.candActs}>
                  <button className={`${styles.mini} ${styles.ok}`} disabled={vacancyMut.isPending} onClick={() => vacancyMut.mutate(vacEdit.trim())}>Сохранить</button>
                  <button className={styles.mini} onClick={() => setVacEdit(null)}>Отмена</button>
                </div>
              </div>
            ) : r.hh_vacancy_url
              ? <div className={styles.vacLink}><span>🔗 Вакансия на HeadHunter</span><a href={r.hh_vacancy_url} target="_blank" rel="noreferrer">Открыть ↗</a></div>
              : <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Вакансия ещё не указана.</div>}
          </div>

          {/* Файлы */}
          <div className={styles.sec}>
            <div className={styles.secH}><h4>Файлы</h4><span className={styles.right}>{r.files.length}</span></div>
            {r.files.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Файлов нет.</div>}
            {r.files.map(f => (
              <div key={f.id} className={styles.file}>
                <span className={styles.ic}>📄</span>
                <span className={styles.nm}>{f.file_name}</span>
                <button className={styles.hh} onClick={async () => { try { const url = await hiringRequestService.getFileDownloadUrl(requestId, f.id); window.open(url, '_blank'); } catch (e) { onErr(e); } }}>↓</button>
              </div>
            ))}
            {canWork && <>
              <input ref={fileRef} type="file" hidden onChange={e => { const file = e.target.files?.[0]; if (file) fileMut.mutate(file); e.currentTarget.value = ''; }} />
              <button className={styles.addBtn} onClick={() => fileRef.current?.click()}>＋ Прикрепить файл</button>
            </>}
          </div>

          {/* Лента */}
          <div className={styles.sec}>
            <div className={styles.secH}><h4>Активность</h4></div>
            <div className={styles.timeline}>
              {r.events.map(ev => (
                <div key={ev.id} className={`${styles.tl} ${ev.kind === 'comment' ? styles.comment : ''}`}>
                  <span className={styles.tnode}>{eventIcon(ev.kind)}</span>
                  <span className={styles.who}>{ev.author_name || 'Система'}</span>
                  <span className={styles.when}>{fmtDate(ev.created_at)}</span>
                  <div className={styles.txt}>{ev.body || stageChangeText(ev.from_stage, ev.to_stage)}{ev.link_url && <> · <a href={ev.link_url} target="_blank" rel="noreferrer" className={styles.hh}>ссылка</a></>}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <div className={styles.pFoot}>
          {canWork ? (
            <>
              <textarea placeholder="Написать комментарий…" value={comment} onChange={e => setComment(e.target.value)} />
              <button className={styles.send} disabled={!comment.trim() || commentMut.isPending} onClick={() => { commentMut.mutate(comment); setComment(''); }}>↑</button>
            </>
          ) : isAuthor && r.stage === 'rework' ? (
            <div className={styles.pActions}>
              <button className={styles.btnGhost} onClick={() => setEditOpen(true)}>✎ Редактировать</button>
              <button className={styles.btnPrimary} style={{ flex: 1 }} disabled={resubmitMut.isPending} onClick={() => resubmitMut.mutate()}>↻ Пересдать заявку</button>
            </div>
          ) : (
            <div className={styles.pHint}>Просмотр. {canApprove ? 'Вы можете утверждать кандидатов и оставлять отзыв.' : 'Действия доступны отделу подбора.'}</div>
          )}
        </div>

        {/* manage-панель действий поверх футера */}
        {canManage && (
          <div className={styles.pFoot} style={{ borderTop: 'none', paddingTop: 0 }}>
            <div className={styles.pActions}>
              <button className={styles.btnGhost} onClick={() => urgentMut.mutate(!r.is_urgent)}>{r.is_urgent ? 'Снять срочность' : '● Срочная'}</button>
              {r.stage !== 'rework' && r.stage !== 'closed' && <button className={styles.btnDanger} onClick={() => setRejectOpen(true)}>↩ Вернуть на доработку</button>}
            </div>
          </div>
        )}
      </div>

      {rejectOpen && <RejectModal requestId={requestId} onClose={() => setRejectOpen(false)} onDone={invalidate} />}
      {editOpen && <HiringRequestCreateModal request={r} onClose={() => { setEditOpen(false); invalidate(); }} />}
    </>
  );
};

// ===== Кандидат =====
const CandidateRow: FC<{ c: IHiringCandidate; requestId: number; canWork: boolean; canApprove: boolean; approvedReached: boolean; onChanged: () => void }> = ({ c, requestId, canWork, canApprove, approvedReached, onChanged }) => {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [fbEdit, setFbEdit] = useState<string | null>(null);
  const onErr = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Ошибка');

  const status = c.applicant_approved ? { label: 'Кандидат выбран', color: 'var(--success)' } : CANDIDATE_STATUS_META[c.status];
  const approve = async (v: boolean) => { try { await hiringRequestService.approveCandidate(requestId, c.id, v); onChanged(); } catch (e) { onErr(e); } };
  const saveFb = async () => { try { await hiringRequestService.updateCandidate(requestId, c.id, { applicant_feedback: fbEdit ?? '' }); setFbEdit(null); onChanged(); } catch (e) { onErr(e); } };
  const changeStatus = async (s: string) => { try { await hiringRequestService.updateCandidate(requestId, c.id, { status: s as IHiringCandidate['status'] }); onChanged(); } catch (e) { onErr(e); } };

  return (
    <div className={styles.cand}>
      <div className={styles.candRow} onClick={() => setOpen(o => !o)}>
        <Avatar name={c.full_name} id={c.id} />
        <span className={styles.candName}>{c.full_name}</span>
        <span className={styles.cpill} style={{ color: status.color, background: c.applicant_approved ? 'var(--success-muted,rgba(34,197,94,.13))' : 'var(--surface-elevated)' }}>{c.applicant_approved ? '✓ ' : ''}{status.label}</span>
        {c.hh_resume_url && <a className={styles.hh} href={c.hh_resume_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>HH ↗</a>}
      </div>
      {open && (
        <div className={styles.candDet}>
          <div className={styles.candLine}>
            {c.phone && <span>📞 {c.phone}</span>}
            {c.salary_expectation && <span>💰 {c.salary_expectation}</span>}
            {c.interview_at && <span>📅 {fmtDate(c.interview_at)}</span>}
          </div>
          {c.seeker_feedback && <div className={styles.fb}>
            <div className={styles.fbLabel}>Отзыв соискателя <span className={styles.by}>· записал HR</span></div>
            <div className={`${styles.note} ${styles.noteSeeker}`}>{c.seeker_feedback}</div>
          </div>}
          <div className={styles.fb}>
            <div className={styles.fbLabel}>
              Отзыв заявителя <span className={styles.by}>· нач. отдела</span>
              {canApprove && fbEdit === null && <button className={styles.mini} onClick={() => setFbEdit(c.applicant_feedback ?? '')}>{c.applicant_feedback ? '✎ Изменить' : '＋ Добавить'}</button>}
            </div>
            {fbEdit !== null ? (
              <div>
                <textarea className={styles.poolSearch} style={{ minHeight: 60, marginBottom: 6 }} value={fbEdit} onChange={e => setFbEdit(e.target.value)} placeholder="Ваша оценка кандидата" />
                <div className={styles.candActs}>
                  <button className={`${styles.mini} ${styles.ok}`} onClick={saveFb}>Сохранить</button>
                  <button className={styles.mini} onClick={() => setFbEdit(null)}>Отмена</button>
                </div>
              </div>
            ) : c.applicant_feedback
              ? <div className={`${styles.note} ${styles.noteApplicant}`}>{c.applicant_feedback}</div>
              : <div className={`${styles.note} ${styles.noteEmpty}`}>Отзыва заявителя пока нет.</div>}
          </div>
          <div className={styles.candActs}>
            {canApprove && (
              <button
                className={`${styles.mini} ${c.applicant_approved ? styles.approved : styles.approve}`}
                disabled={!c.applicant_approved && approvedReached}
                title={!c.applicant_approved && approvedReached ? 'Достигнут лимит выбранных' : ''}
                onClick={() => approve(!c.applicant_approved)}
              >{c.applicant_approved ? '✓ Утверждён вами' : 'Утвердить'}</button>
            )}
            {canWork && (
              <select className={styles.mini} value={c.status} onChange={e => changeStatus(e.target.value)}>
                {Object.entries(CANDIDATE_STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const AddCandidate: FC<{ requestId: number; onAdded: () => void }> = ({ requestId, onAdded }) => {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ full_name: '', hh_resume_url: '', phone: '', salary_expectation: '' });
  const save = async () => {
    if (!f.full_name.trim()) { toast.error('Укажите ФИО'); return; }
    try { await hiringRequestService.addCandidate(requestId, f); setOpen(false); setF({ full_name: '', hh_resume_url: '', phone: '', salary_expectation: '' }); onAdded(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  if (!open) return <button className={styles.addBtn} onClick={() => setOpen(true)}>＋ Добавить кандидата</button>;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input className={styles.poolSearch} style={{ margin: 0 }} placeholder="ФИО" value={f.full_name} onChange={e => setF(p => ({ ...p, full_name: e.target.value }))} />
      <input className={styles.poolSearch} style={{ margin: 0 }} placeholder="Ссылка на резюме HH" value={f.hh_resume_url} onChange={e => setF(p => ({ ...p, hh_resume_url: e.target.value }))} />
      <div style={{ display: 'flex', gap: 8 }}>
        <input className={styles.poolSearch} style={{ margin: 0 }} placeholder="Телефон" value={f.phone} onChange={e => setF(p => ({ ...p, phone: e.target.value }))} />
        <input className={styles.poolSearch} style={{ margin: 0 }} placeholder="Ожид. ЗП" value={f.salary_expectation} onChange={e => setF(p => ({ ...p, salary_expectation: e.target.value }))} />
      </div>
      <div className={styles.candActs}>
        <button className={`${styles.mini} ${styles.ok}`} onClick={save}>Добавить</button>
        <button className={styles.mini} onClick={() => setOpen(false)}>Отмена</button>
      </div>
    </div>
  );
};

const RejectModal: FC<{ requestId: number; onClose: () => void; onDone: () => void }> = ({ requestId, onClose, onDone }) => {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const submit = async () => {
    if (!reason.trim()) { toast.error('Укажите причину'); return; }
    try { await hiringRequestService.reject(requestId, reason); toast.success('Возвращена на доработку'); onDone(); onClose(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`${styles.modal} ${styles.modalSm}`} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}><div><h3>Вернуть на доработку</h3><p>Заявитель увидит причину и сможет исправить.</p></div><button className={styles.x} onClick={onClose}>✕</button></div>
        <div className={styles.modalBody}>
          <div className={`${styles.field} ${styles.full}`}>
            <label>Причина <span className={styles.req}>*</span></label>
            <textarea placeholder="Например: уточните разряд и объект, добавьте вилку оклада" value={reason} onChange={e => setReason(e.target.value)} />
          </div>
        </div>
        <div className={styles.modalFoot}><button className={styles.btnGhost} onClick={onClose}>Отмена</button><button className={styles.btnDanger} onClick={submit}>Вернуть на доработку</button></div>
      </div>
    </div>
  );
};

function eventIcon(kind: string): string {
  return ({ comment: '💬', stage_change: '↗', assign: '👤', unassign: '–', rework: '↩', resubmit: '↻', urgent: '●', candidate: '+', file: '📎', approve: '✓', finalize: '★', unfinalize: '☆', link: '🔗' } as Record<string, string>)[kind] || '•';
}
function stageChangeText(from: string | null, to: string | null): string {
  if (!to) return '';
  const l = (s: string | null) => s ? stageMeta(s as HiringStage).label : '';
  return `Этап: ${l(from)} → ${l(to)}`;
}
