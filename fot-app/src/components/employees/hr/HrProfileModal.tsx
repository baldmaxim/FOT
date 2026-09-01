import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, Eye, EyeOff, Save, X } from 'lucide-react';
import { ModalShell } from '../../ui/ModalShell';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { hrProfileService } from '../../../services/hrProfileService';
import type { HrProfileInput, IHrDocument, IHrProfileView } from '../../../types/hrProfile';
import { HrProfileForm } from './HrProfileForm';
import { HrDocumentsGrid } from './HrDocumentsGrid';
import { HrProfileHistory } from './HrProfileHistory';
import { HrOcrConflictsPanel } from './HrOcrConflictsPanel';
import { displayFieldValue, fmtDate, visibleFields } from './hrFormat';
import styles from './HrProfileModal.module.css';

interface IHrProfileModalProps {
  employeeId: number;
  onClose: () => void;
}

type Tab = 'info' | 'files';

/**
 * «Реквизиты» — большая модалка по образцу карточки сотрудника PassDesk:
 * «Личная информация» (сетка полей + правка) / «Файлы» (слоты сканов), справа
 * история изменений, сверху — расхождения OCR. Без профиля — «Завести реквизиты».
 */
export const HrProfileModal: FC<IHrProfileModalProps> = ({ employeeId, onClose }) => {
  const { isAdmin, canEditPage } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canEdit = isAdmin || canEditPage('/staff-control/hr-profiles');

  const [tab, setTab] = useState<Tab>('info');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<HrProfileInput>({});
  const [saving, setSaving] = useState(false);
  const [unmasked, setUnmasked] = useState<IHrProfileView | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const catalogQuery = useQuery({ queryKey: ['hr-catalog'], queryFn: () => hrProfileService.getCatalog(), staleTime: 30 * 60_000 });
  const profileQuery = useQuery({ queryKey: ['hr-profile', employeeId], queryFn: () => hrProfileService.get(employeeId) });
  const docsQuery = useQuery({
    queryKey: ['hr-documents', employeeId],
    queryFn: () => hrProfileService.documents(employeeId),
    enabled: !!profileQuery.data?.profile,
    refetchInterval: q => (q.state.data?.slots.some(s => s.files.some(f => f.recognition_status === 'pending' || f.recognition_status === 'processing')) ? 4000 : false),
  });
  const historyQuery = useQuery({ queryKey: ['hr-history', employeeId], queryFn: () => hrProfileService.history(employeeId), enabled: !!profileQuery.data?.profile });
  const conflictsQuery = useQuery({ queryKey: ['hr-conflicts', employeeId], queryFn: () => hrProfileService.conflicts(employeeId), enabled: !!profileQuery.data?.profile });

  const profile = unmasked ?? profileQuery.data?.profile ?? null;
  const catalog = catalogQuery.data;

  const refreshAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['hr-profile', employeeId] });
    void queryClient.invalidateQueries({ queryKey: ['hr-documents', employeeId] });
    void queryClient.invalidateQueries({ queryKey: ['hr-history', employeeId] });
    void queryClient.invalidateQueries({ queryKey: ['hr-conflicts', employeeId] });
    void queryClient.invalidateQueries({ queryKey: ['employee', employeeId] });
  }, [queryClient, employeeId]);

  // После расшифровки держим полные значения до закрытия; при обновлении профиля перезапрашиваем.
  useEffect(() => {
    if (unmasked && profileQuery.data?.profile && profileQuery.data.profile.updated_at !== unmasked.updated_at) {
      void hrProfileService.getSensitive(employeeId).then(setUnmasked).catch(() => setUnmasked(null));
    }
  }, [profileQuery.data, unmasked, employeeId]);

  const startEdit = async () => {
    try {
      const full = await hrProfileService.getSensitive(employeeId);
      setUnmasked(full);
      setDraft({ ...full.fields });
      setEditing(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось открыть форму');
    }
  };

  const toggleUnmask = async () => {
    if (unmasked) { setUnmasked(null); return; }
    try {
      setUnmasked(await hrProfileService.getSensitive(employeeId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Нет доступа к полным данным');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await hrProfileService.update(employeeId, draft);
      setUnmasked(res.profile);
      setEditing(false);
      toast.success(res.changedFields.length ? `Сохранено: ${res.changedFields.length} полей${res.zupReset ? ' (флаг ЗУП сброшен)' : ''}` : 'Изменений нет');
      refreshAll();
    } catch (err) {
      const e = err as { message?: string; code?: string };
      toast.error(e.code === 'duplicate' ? 'Такой номер документа уже закреплён за другим сотрудником' : e.message ?? 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const createProfile = async () => {
    try {
      const full = await hrProfileService.create(employeeId, {});
      setUnmasked(full);
      setDraft({ ...full.fields });
      setEditing(true);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось завести реквизиты');
    }
  };

  const upload = async (typeCode: string, file: File) => {
    setUploading(typeCode);
    try {
      await hrProfileService.uploadDocument(employeeId, typeCode, file);
      toast.success('Файл загружен');
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(null);
    }
  };

  const removeDoc = async (doc: IHrDocument) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return;
    try {
      await hrProfileService.deleteDocument(doc.id);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось удалить файл');
    }
  };

  const recognize = async (doc: IHrDocument) => {
    try {
      await hrProfileService.recognizeDocument(doc.id);
      toast.info('Документ поставлен в очередь распознавания');
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось запустить распознавание');
    }
  };

  const fieldsToShow = useMemo(() => (catalog && profile ? visibleFields(catalog.fields, profile.requires_patent) : []), [catalog, profile]);

  const zupToggle = async () => {
    if (!profile) return;
    try {
      await hrProfileService.setZup(employeeId, !profile.zup.is_uploaded);
      refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось изменить флаг ЗУП');
    }
  };

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container} aria-label="Реквизиты сотрудника">
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <div>
              <h3>Реквизиты</h3>
              <div className={styles.subtitle}>{profile?.full_name ?? profileQuery.data?.profile?.full_name ?? `Сотрудник #${employeeId}`}</div>
            </div>
            <div className={styles.headerActions}>
              {profile && (
                <div className={styles.tabs}>
                  <button type="button" className={`${styles.tab} ${tab === 'info' ? styles.tabActive : ''}`} onClick={() => setTab('info')}>Личная информация</button>
                  <button type="button" className={`${styles.tab} ${tab === 'files' ? styles.tabActive : ''}`} onClick={() => setTab('files')}>
                    Файлы{docsQuery.data ? ` (${docsQuery.data.completeness.total})` : ''}
                  </button>
                </div>
              )}
              <button type="button" className={styles.closeBtn} onClick={requestClose} aria-label="Закрыть"><X size={18} /></button>
            </div>
          </div>

          <div className={styles.body}>
            {profileQuery.isPending && <div className={styles.muted}>Загрузка…</div>}
            {profileQuery.isError && <div className={styles.errorBox}>{(profileQuery.error as Error).message}</div>}

            {!profileQuery.isPending && !profile && !profileQuery.isError && (
              <div className={styles.emptyState}>
                <p>Реквизиты для этого сотрудника ещё не заведены.</p>
                {canEdit ? <button type="button" className={styles.btnPrimary} onClick={() => void createProfile()}>Завести реквизиты</button>
                  : <p className={styles.muted}>Заводит отдел кадров или табельщица.</p>}
              </div>
            )}

            {profile && catalog && (
              <div className={styles.columns}>
                <div className={styles.main}>
                  {tab === 'info' && (
                    <>
                      <div className={styles.statusRow}>
                        <span className={`${styles.pill} ${profile.requires_patent ? styles.pillWarn : styles.pillMuted}`}>
                          Патент: {profile.requires_patent ? 'требуется' : profile.fields.has_residence_permit ? 'не требуется (ВНЖ)' : 'не требуется'}
                        </span>
                        <button type="button" className={`${styles.pill} ${profile.zup.is_uploaded ? styles.pillOk : styles.pillWarn}`} onClick={() => canEdit && void zupToggle()} disabled={!canEdit} title="Занесён ли сотрудник в 1С-ЗУП">
                          ЗУП: {profile.zup.is_uploaded ? `ДА (${fmtDate(profile.zup.uploaded_at)})` : 'НЕТ'}
                        </button>
                        {profile.zup.exported_at && <span className={styles.muted}>выгрузка: {fmtDate(profile.zup.exported_at)}</span>}
                        <span className={styles.spacer} />
                        {canEdit && !editing && (
                          <>
                            <button type="button" className={styles.btnGhost} onClick={() => void toggleUnmask()} title={unmasked ? 'Скрыть номера' : 'Показать полные номера (действие записывается в аудит)'}>
                              {unmasked ? <EyeOff size={14} /> : <Eye size={14} />} {unmasked ? 'Скрыть' : 'Показать номера'}
                            </button>
                            <button type="button" className={styles.btnPrimary} onClick={() => void startEdit()}><Edit3 size={14} /> Редактировать</button>
                          </>
                        )}
                        {editing && (
                          <>
                            <button type="button" className={styles.btnGhost} onClick={() => setEditing(false)} disabled={saving}>Отмена</button>
                            <button type="button" className={styles.btnPrimary} onClick={() => void save()} disabled={saving}><Save size={14} /> {saving ? 'Сохраняем…' : 'Сохранить'}</button>
                          </>
                        )}
                      </div>

                      <HrOcrConflictsPanel conflicts={conflictsQuery.data ?? []} canEdit={canEdit} onResolved={refreshAll} />

                      {editing ? (
                        <HrProfileForm catalog={catalog} value={draft} onChange={setDraft} disabled={saving} />
                      ) : (
                        <div className={styles.infoGrid}>
                          <div className={styles.infoCell}><span>ФИО</span><b>{profile.full_name}</b></div>
                          <div className={styles.infoCell}><span>Гражданство</span><b>{profile.citizenship?.name ?? '—'}</b></div>
                          <div className={styles.infoCell}><span>Дата выхода</span><b>{fmtDate(profile.hire_date)}</b></div>
                          <div className={styles.infoCell}><span>Табельный №</span><b>{profile.tab_number ?? '—'}</b></div>
                          {fieldsToShow.filter(f => f.key !== 'citizenship_id').map(f => (
                            <div key={f.key} className={`${styles.infoCell} ${f.key === 'registration_address' || f.key === 'notes' || f.key === 'passport_issuer' ? styles.infoWide : ''}`}>
                              <span>{f.label}</span>
                              <b className={f.sensitive && profile.masked ? styles.masked : ''}>{displayFieldValue(f.key, profile.fields[f.key as keyof typeof profile.fields], catalog)}</b>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {tab === 'files' && (
                    <>
                      {docsQuery.data && (
                        <div className={styles.statusRow}>
                          <span className={`${styles.pill} ${docsQuery.data.completeness.filled >= docsQuery.data.completeness.required ? styles.pillOk : styles.pillWarn}`}>
                            Обязательных: {docsQuery.data.completeness.filled} из {docsQuery.data.completeness.required}
                          </span>
                          <span className={styles.muted}>Профиль комплекта: {profile.document_profile === 'ru' ? 'РФ' : profile.document_profile === 'eaeu' ? 'ЕАЭС' : 'мигрант'}</span>
                        </div>
                      )}
                      <HrDocumentsGrid
                        slots={docsQuery.data?.slots ?? []}
                        canEdit={canEdit}
                        canView={canEdit}
                        uploading={uploading}
                        onUpload={(t, f) => void upload(t, f)}
                        onDelete={d => void removeDoc(d)}
                        onRecognize={d => void recognize(d)}
                      />
                    </>
                  )}
                </div>
                <aside className={styles.side}>
                  <HrProfileHistory items={historyQuery.data ?? []} catalog={catalog} loading={historyQuery.isPending} />
                </aside>
              </div>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
};
