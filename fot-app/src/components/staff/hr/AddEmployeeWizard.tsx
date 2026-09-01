import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowRight, Loader2, UserCheck, X } from 'lucide-react';
import { ModalShell } from '../../ui/ModalShell';
import { useToast } from '../../../contexts/ToastContext';
import { hrProfileService } from '../../../services/hrProfileService';
import { employeeService } from '../../../services/employeeService';
import type { HrProfileInput, IHrDocument, IHrDraftView, IHrDuplicateCandidate, IHrDocumentSlot } from '../../../types/hrProfile';
import { HrProfileForm } from '../../employees/hr/HrProfileForm';
import { HrDocumentsGrid } from '../../employees/hr/HrDocumentsGrid';
import { documentSlotsFor, fmtDate, fmtDateTime } from '../../employees/hr/hrFormat';
import styles from '../../employees/hr/HrProfileModal.module.css';

interface IAddEmployeeWizardProps {
  onClose: () => void;
  onCreated: (employeeId: number) => void;
  /** Предзаполнение (например, из staging «Несопоставленные»). */
  initial?: { full_name?: string; profile?: HrProfileInput; stagingId?: string };
}

type Step = 'documents' | 'data';

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Мастер «Добавить сотрудника» (порт сценария PassDesk): шаг «Документы» (сканы →
 * распознавание) → шаг «Данные» (поля предзаполнены из сканов + отдел/должность) →
 * антидубль → создание существующим POST /api/employees → прикрепление профиля и сканов.
 */
export const AddEmployeeWizard: FC<IAddEmployeeWizardProps> = ({ onClose, onCreated, initial }) => {
  const toast = useToast();
  const [step, setStep] = useState<Step>('documents');
  const [draft, setDraft] = useState<IHrDraftView | null>(null);
  const [profile, setProfile] = useState<HrProfileInput>({ has_residence_permit: false, ...(initial?.profile ?? {}) });
  const [fullName, setFullName] = useState(initial?.full_name ?? '');
  const [hireDate, setHireDate] = useState(todayIso());
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [tabNumber, setTabNumber] = useState('');
  const [uploading, setUploading] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [candidates, setCandidates] = useState<IHrDuplicateCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocrApplied, setOcrApplied] = useState<Record<string, string>>({});
  // Найденная при открытии незавершённая анкета: предлагаем продолжить, чтобы уже
  // загруженные сканы не осиротели.
  const [resumeCandidate, setResumeCandidate] = useState<IHrDraftView | null>(null);
  // Сотрудник создан, но сервер об этом не узнал (mark не прошёл дважды) — создавать
  // повторно из этого окна нельзя, иначе получим дубль.
  const [createFrozen, setCreateFrozen] = useState(false);
  // Черновик создаётся один раз даже при параллельных загрузках; id созданного
  // сотрудника помним, чтобы повтор после сбоя прикреплял, а не создавал заново.
  const draftPromiseRef = useRef<Promise<IHrDraftView> | null>(null);
  const createdEmployeeIdRef = useRef<number | null>(null);

  const catalogQuery = useQuery({ queryKey: ['hr-catalog'], queryFn: () => hrProfileService.getCatalog(), staleTime: 30 * 60_000 });
  const deptQuery = useQuery({ queryKey: ['hr-departments'], queryFn: () => hrProfileService.getDepartments(), staleTime: 10 * 60_000 });
  const catalog = catalogQuery.data;

  // Черновик создаём лениво — при первой загрузке файла или переходе к данным;
  // промис мемоизируем, иначе две быстрые загрузки создадут два черновика.
  const ensureDraft = useCallback(async (): Promise<IHrDraftView> => {
    if (draft) return draft;
    if (!draftPromiseRef.current) {
      draftPromiseRef.current = hrProfileService.createDraft({ full_name: fullName || null, profile })
        .then(created => { setDraft(created); return created; })
        .catch(err => { draftPromiseRef.current = null; throw err; });
    }
    return draftPromiseRef.current;
  }, [draft, fullName, profile]);

  const adoptDraft = useCallback((d: IHrDraftView) => {
    setDraft(d);
    draftPromiseRef.current = Promise.resolve(d);
    const p = d.payload ?? {};
    if (p.full_name) setFullName(p.full_name);
    if (p.hire_date) setHireDate(p.hire_date);
    if (p.org_department_id) setDepartmentId(p.org_department_id);
    if (p.position_id) setPositionId(p.position_id);
    if (p.tab_number) setTabNumber(p.tab_number);
    if (p.profile) setProfile(prev => ({ ...prev, ...p.profile }));
  }, []);

  /**
   * Восстановление после закрытия окна. `createdEmployeeIdRef` живёт только в памяти
   * компонента, поэтому источник правды — сервер: анкета в состоянии
   * employee_created_pending_attach означает, что сотрудник уже создан и повторное
   * создание запрещено — остаётся только прикрепить документы.
   */
  useEffect(() => {
    if (initial?.stagingId) return; // из «Несопоставленных» открывается своя предзаполненная анкета
    let alive = true;
    hrProfileService.listMyDrafts()
      .then(list => {
        if (!alive) return;
        const pending = list.find(d => d.state === 'employee_created_pending_attach' && d.employee_id);
        if (pending?.employee_id) {
          adoptDraft(pending);
          createdEmployeeIdRef.current = pending.employee_id;
          setStep('data');
          setError(`Сотрудник #${pending.employee_id} уже создан, но документы не прикреплены${pending.attach_error ? `: ${pending.attach_error}` : ''}. Нажмите «Повторить прикрепление» — повторного создания не будет.`);
          return;
        }
        const unfinished = list.find(d => d.state === 'draft' && d.documents.length > 0);
        if (unfinished) setResumeCandidate(unfinished);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [initial?.stagingId, adoptDraft]);

  // Пока есть распознающиеся файлы — опрашиваем черновик и подтягиваем ocr_patch.
  const hasPending = draft?.documents.some(d => d.recognition_status === 'pending' || d.recognition_status === 'processing') ?? false;
  useEffect(() => {
    if (!draft || !hasPending) return;
    const t = setInterval(() => {
      hrProfileService.getDraft(draft.id).then(setDraft).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [draft, hasPending]);

  // Применяем распознанное к форме: только пустые поля (пользователь мог уже ввести).
  useEffect(() => {
    if (!draft) return;
    const patch = draft.ocr_patch;
    if (!patch || Object.keys(patch).length === 0) return;
    setProfile(prev => {
      const next = { ...prev } as Record<string, unknown>;
      const applied: Record<string, string> = { ...ocrApplied };
      for (const [k, v] of Object.entries(patch)) {
        if (['last_name', 'first_name', 'middle_name', 'citizenship_raw'].includes(k)) continue;
        if (next[k] === undefined || next[k] === null || next[k] === '') {
          next[k] = v;
          applied[k] = draft.ocr_sources[k] ?? 'документ';
        }
      }
      setOcrApplied(applied);
      return next as HrProfileInput;
    });
    if (!fullName.trim() && (patch.last_name || patch.first_name)) {
      setFullName([patch.last_name, patch.first_name, patch.middle_name].filter(Boolean).join(' '));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.ocr_patch]);

  const slots = useMemo<IHrDocumentSlot[]>(() => {
    const s = documentSlotsFor(catalog, profile.citizenship_id, !!profile.has_residence_permit);
    const byType = new Map<string, IHrDocument[]>();
    for (const d of draft?.documents ?? []) byType.set(d.type_code, [...(byType.get(d.type_code) ?? []), d]);
    const typeMap = new Map((catalog?.document_types ?? []).map(t => [t.code, t]));
    const required = new Set(s.required);
    const out: IHrDocumentSlot[] = s.all.map(code => ({
      code, label: typeMap.get(code)?.label ?? code, required: required.has(code), ocr_supported: !!typeMap.get(code)?.ocr_supported, files: byType.get(code) ?? [],
    }));
    for (const [code, files] of byType) if (!s.all.includes(code)) out.push({ code, label: typeMap.get(code)?.label ?? code, required: false, ocr_supported: !!typeMap.get(code)?.ocr_supported, files });
    return out;
  }, [catalog, profile.citizenship_id, profile.has_residence_permit, draft?.documents]);

  const upload = async (typeCode: string, file: File) => {
    setUploading(typeCode);
    try {
      const d = await ensureDraft();
      const cit = catalog?.citizenships.find(c => c.id === profile.citizenship_id);
      const passportType = profile.passport_type ?? (cit ? (cit.iso_code === 'RUS' ? 'russian' : 'foreign') : null);
      await hrProfileService.uploadDraftDocument(d.id, typeCode, file, passportType);
      setDraft(await hrProfileService.getDraft(d.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(null);
    }
  };

  const removeDoc = async (doc: IHrDocument) => {
    try {
      await hrProfileService.deleteDocument(doc.id);
      if (draft) setDraft(await hrProfileService.getDraft(draft.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось удалить файл');
    }
  };

  const recognize = async (doc: IHrDocument) => {
    try {
      await hrProfileService.recognizeDocument(doc.id);
      if (draft) setDraft(await hrProfileService.getDraft(draft.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось запустить распознавание');
    }
  };

  const goData = async () => {
    setError(null);
    try {
      await ensureDraft();
      setStep('data');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать черновик');
    }
  };

  const payload = () => ({
    full_name: fullName.trim() || null,
    hire_date: hireDate || null,
    org_department_id: departmentId || null,
    position_id: positionId || null,
    tab_number: tabNumber.trim() || null,
    profile,
  });

  const checkDuplicates = async (): Promise<boolean> => {
    const list = await hrProfileService.findDuplicates({
      snils: profile.snils, inn: profile.inn, passport_number: profile.passport_number, full_name: fullName, birth_date: profile.birth_date,
    });
    if (list.length > 0) {
      setCandidates(list);
      return true;
    }
    return false;
  };

  /**
   * Создание идёт существующим POST /api/employees — тем же запросом, что и старая
   * модалка. Дальше черновик помечается как «сотрудник создан» и только потом
   * прикрепляются профиль и сканы: если прикрепление упадёт, сотрудник уже корректно
   * создан, и повторяется лишь attach (createdEmployeeIdRef не даст создать второго).
   */
  const commit = async () => {
    setError(null);
    if (!fullName.trim() || !hireDate || !departmentId || !positionId) {
      setError('Заполните ФИО, дату найма, отдел и должность');
      return;
    }
    setCommitting(true);
    try {
      const d = await ensureDraft();
      if (!candidates && await checkDuplicates()) return;

      let employeeId = createdEmployeeIdRef.current;
      if (!employeeId) {
        const created = await employeeService.create({
          full_name: fullName.trim(),
          hire_date: hireDate,
          org_department_id: departmentId,
          position_id: positionId,
          tab_number: tabNumber.trim() || null,
        });
        employeeId = created.id;
        createdEmployeeIdRef.current = employeeId;
        // Фиксация обязательна: без неё сервер не узнает о созданном сотруднике,
        // и после закрытия окна восстановиться будет не из чего. Один повтор —
        // на случай короткого сетевого сбоя.
        try {
          await hrProfileService.markDraftEmployeeCreated(d.id, employeeId);
        } catch {
          try {
            await hrProfileService.markDraftEmployeeCreated(d.id, employeeId);
          } catch (markErr) {
            setCreateFrozen(true);
            throw new Error(
              `Сотрудник создан (#${employeeId}), но связь с анкетой не зафиксирована: ${markErr instanceof Error ? markErr.message : 'ошибка'}. `
              + 'Не создавайте его повторно — прикрепите документы из его карточки, кнопка «Реквизиты».',
            );
          }
        }
      }

      try {
        await hrProfileService.patchDraft(d.id, payload());
      } catch {
        toast.error('Поля анкеты не сохранились на сервере — после создания проверьте «Реквизиты» в карточке');
      }
      await hrProfileService.attachDraft(d.id, employeeId);
      toast.success('Сотрудник создан, документы прикреплены');
      if (initial?.stagingId) await hrProfileService.stagingLink(initial.stagingId, employeeId, 'created').catch(() => undefined);
      onCreated(employeeId);
    } catch (err) {
      const e = err as { message?: string; code?: string; details?: { details?: { candidates?: IHrDuplicateCandidate[] } } };
      if (e.code === 'duplicate') {
        setCandidates(e.details?.details?.candidates ?? []);
      } else if (createdEmployeeIdRef.current) {
        setError(`Сотрудник создан (#${createdEmployeeIdRef.current}), но документы не прикреплены: ${e.message ?? 'ошибка'}. Нажмите «Повторить прикрепление» — повторного создания не будет.`);
      } else {
        setError(e.message ?? 'Не удалось создать сотрудника');
      }
    } finally {
      setCommitting(false);
    }
  };


  const attachTo = async (employeeId: number) => {
    setCommitting(true);
    try {
      const d = await ensureDraft();
      await hrProfileService.patchDraft(d.id, payload());
      const res = await hrProfileService.attachDraft(d.id, employeeId);
      toast.success(`Документы прикреплены к существующему сотруднику${res.conflicts.length ? ` (расхождений: ${res.conflicts.length})` : ''}`);
      if (initial?.stagingId) await hrProfileService.stagingLink(initial.stagingId, employeeId, 'linked').catch(() => undefined);
      onCreated(employeeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось прикрепить');
    } finally {
      setCommitting(false);
    }
  };

  const departments = deptQuery.data?.departments ?? [];
  const positions = deptQuery.data?.positions ?? [];

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container} aria-label="Добавить сотрудника">
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <div>
              <h3>Добавить сотрудника</h3>
              <div className={styles.wizardSteps}>
                <span className={`${styles.wizardStep} ${step === 'documents' ? styles.wizardStepActive : styles.wizardStepDone}`}>1. Документы</span>
                <span className={`${styles.wizardStep} ${step === 'data' ? styles.wizardStepActive : ''}`}>2. Данные и создание</span>
              </div>
            </div>
            <button type="button" className={styles.closeBtn} onClick={requestClose} aria-label="Закрыть"><X size={18} /></button>
          </div>

          <div className={styles.body}>
            {!catalog && <div className={styles.muted}>Загрузка…</div>}
            {catalog && !catalog.enabled && <div className={styles.errorBox}>Кадровый модуль отключён администратором.</div>}
            {error && <div className={styles.errorBox}>{error}</div>}

            {catalog && step === 'documents' && resumeCandidate && (
              <div className={styles.resumeBox}>
                <AlertTriangle size={15} />
                <span>
                  Есть незавершённая анкета от {fmtDateTime(resumeCandidate.updated_at)}, сканов: {resumeCandidate.documents.length}.
                </span>
                <button type="button" className={styles.smallBtn} onClick={() => { adoptDraft(resumeCandidate); setResumeCandidate(null); }}>Продолжить</button>
                <button type="button" className={styles.smallBtnGhost} onClick={() => setResumeCandidate(null)}>Начать заново</button>
              </div>
            )}

            {catalog && step === 'documents' && (
              <div className={styles.main}>
                <div className={styles.statusRow}>
                  <div className={styles.field}>
                    <label htmlFor="wz-cit">Гражданство</label>
                    <select id="wz-cit" value={profile.citizenship_id ?? ''} onChange={e => setProfile(p => ({ ...p, citizenship_id: e.target.value || null }))}>
                      <option value="">— выберите —</option>
                      {catalog.citizenships.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <label className={styles.checkLabel}>
                    <input type="checkbox" checked={!!profile.has_residence_permit} onChange={e => setProfile(p => ({ ...p, has_residence_permit: e.target.checked }))} />
                    ВНЖ <span className={styles.hint}>патент и КИГ не нужны</span>
                  </label>
                  <span className={styles.muted}>Загрузите сканы — поля заполнятся автоматически. Шаг можно пропустить.</span>
                </div>
                <HrDocumentsGrid slots={slots} canEdit canView uploading={uploading} onUpload={(t, f) => void upload(t, f)} onDelete={d => void removeDoc(d)} onRecognize={d => void recognize(d)} />
              </div>
            )}

            {catalog && step === 'data' && (
              <div className={styles.main}>
                {hasPending && <div className={styles.muted}><Loader2 size={13} className={styles.spin} /> Часть документов ещё распознаётся — поля дозаполнятся автоматически.</div>}
                <section className={styles.formGroup}>
                  <h4>Приём на работу</h4>
                  <div className={styles.formGrid}>
                    <div className={`${styles.field} ${styles.fieldWide}`}>
                      <label htmlFor="wz-name">ФИО * {ocrApplied.full_name && <span className={styles.ocrTag}>из документа</span>}</label>
                      <input id="wz-name" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Иванов Иван Иванович" autoComplete="off" />
                    </div>
                    <div className={styles.field}><label htmlFor="wz-hire">Дата найма *</label><input id="wz-hire" type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} /></div>
                    <div className={styles.field}>
                      <label htmlFor="wz-dept">Отдел *</label>
                      <select id="wz-dept" value={departmentId} onChange={e => setDepartmentId(e.target.value)}>
                        <option value="">— выберите —</option>
                        {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </div>
                    <div className={styles.field}>
                      <label htmlFor="wz-pos">Должность *</label>
                      <select id="wz-pos" value={positionId} onChange={e => setPositionId(e.target.value)}>
                        <option value="">— выберите —</option>
                        {positions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                    <div className={styles.field}><label htmlFor="wz-tab">Табельный номер</label><input id="wz-tab" value={tabNumber} onChange={e => setTabNumber(e.target.value)} placeholder="(опционально)" autoComplete="off" /></div>
                  </div>
                </section>
                <HrProfileForm catalog={catalog} value={profile} onChange={setProfile} ocrFields={ocrApplied} disabled={committing} />

                {candidates && candidates.length > 0 && (
                  <div className={styles.candidateBox}>
                    <div><AlertTriangle size={14} /> <b>Похожий сотрудник уже есть в FOT.</b> Чтобы не создавать дубль, прикрепите документы к нему:</div>
                    {candidates.map(c => (
                      <div key={c.employee_id} className={styles.candidateRow}>
                        <b>{c.full_name}</b>
                        <span className={styles.muted}>{c.department ?? '—'} · {fmtDate(c.birth_date)} · {c.employment_status === 'fired' ? 'уволен' : 'активен'} · совпадение: {c.rule}</span>
                        <button type="button" className={styles.smallBtn} disabled={committing} onClick={() => void attachTo(c.employee_id)}><UserCheck size={13} /> Прикрепить к этому</button>
                      </div>
                    ))}
                    <div className={styles.muted}>Если это другой человек — исправьте СНИЛС/ИНН/паспорт и попробуйте снова.</div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className={styles.footer}>
            {step === 'data' && <button type="button" className={styles.btnGhost} onClick={() => setStep('documents')} disabled={committing}><ArrowLeft size={14} /> К документам</button>}
            <span className={styles.spacer} />
            <button type="button" className={styles.btnGhost} onClick={requestClose} disabled={committing}>Отмена</button>
            {step === 'documents' && <button type="button" className={styles.btnPrimary} onClick={() => void goData()} disabled={!catalog?.enabled}>Далее <ArrowRight size={14} /></button>}
            {step === 'data' && (
              <button type="button" className={styles.btnPrimary} onClick={() => void commit()} disabled={committing || createFrozen || !catalog?.enabled}>
                {committing
                  ? <><Loader2 size={14} className={styles.spin} /> {createdEmployeeIdRef.current ? "Прикрепляем…" : "Создаём…"}</>
                  : (createdEmployeeIdRef.current ? "Повторить прикрепление" : "Создать")}
              </button>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
};
