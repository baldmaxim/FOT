import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { leaveRequestService, type ILeaveRequest, type LeaveRequestType } from '../../services/leaveRequestService';
import { documentService } from '../../services/documentService';
import { getMyLeaveRequestsQueryKey } from '../../hooks/usePortalData';
import { useToast } from '../../contexts/ToastContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { MyMonthTimesheet, type IDayFocusPayload } from './MyMonthTimesheet';
import styles from '../../pages/employee/EmployeeDashboard.module.css';

const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 МБ
const ACCEPT_ATTR = '.pdf,application/pdf,image/jpeg,image/png';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
};

// Порядок и состав типов — как в эталонной форме главной (EmployeeDashboardPage).
const UNIFIED_TYPES: { value: LeaveRequestType; label: string }[] = [
  { value: 'time_correction', label: 'Корректировка табеля' },
  { value: 'remote', label: 'Удалённая работа' },
  { value: 'work', label: 'Работа в выходной/праздник' },
  { value: 'vacation', label: 'Отпуск' },
  { value: 'sick_leave', label: 'Больничный' },
  { value: 'unpaid', label: 'За свой счёт' },
  { value: 'educational_leave', label: 'Учебный отпуск' },
  { value: 'sick_worked', label: 'Работа на больничном' },
  { value: 'certificate', label: 'Справка' },
];

// «За свой счёт» (unpaid) подаётся датами на календаре, а не периодом (как на главной).
const RANGE_TYPES: LeaveRequestType[] = ['vacation', 'sick_leave', 'educational_leave'];

interface IUnifiedRequestModalProps {
  onClose: () => void;
  employeeId: number | null;
  /** Предвыбранный день (например, сфокусированный день календаря на главной). */
  presetDate?: string | null;
}

export const UnifiedRequestModal: FC<IUnifiedRequestModalProps> = ({ onClose, employeeId, presetDate }) => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const isMobile = useIsMobile();
  const overlayDismiss = useOverlayDismiss(onClose);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [requestType, setRequestType] = useState<LeaveRequestType>('time_correction');
  const [selectedDates, setSelectedDates] = useState<Set<string>>(presetDate ? new Set([presetDate]) : new Set());
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Строковое состояние ввода часов: целое число (как на главной). В число парсим при отправке.
  const [correctionHours, setCorrectionHours] = useState<string>('8');
  const [correctionObjectId, setCorrectionObjectId] = useState('');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  // Фокус дня — для выбора объекта корректировки по СКУД-объектам конкретного дня.
  const [focusedDay, setFocusedDay] = useState<string | null>(presetDate ?? null);
  const [focusedPayload, setFocusedPayload] = useState<IDayFocusPayload | null>(null);

  const isCorrection = requestType === 'time_correction';
  const isRangeType = RANGE_TYPES.includes(requestType);

  // Объекты сотрудника для привязки корректировки табеля (выбор обязателен).
  const objectsQuery = useQuery({
    queryKey: ['my-correction-objects', employeeId],
    queryFn: () => leaveRequestService.getMyObjects(),
    enabled: !!employeeId,
    staleTime: 5 * 60_000,
  });
  const myObjects = objectsQuery.data ?? [];

  // Объекты выбранного дня (реальные СКУД/manual_object с object_id), дедуп по object_id.
  const dayObjects = useMemo(() => {
    const src = (focusedPayload?.objectEntries ?? []).filter(o => !o.from_day_level && o.object_id);
    const seen = new Map<string, { object_id: string; object_name: string }>();
    for (const o of src) {
      if (!seen.has(o.object_id!)) seen.set(o.object_id!, { object_id: o.object_id!, object_name: o.object_name });
    }
    return [...seen.values()];
  }, [focusedPayload]);

  // Опции выпадашки: объекты дня; если их нет — полный закреплённый список.
  const objectOptions = dayObjects.length > 0 ? dayObjects : myObjects;

  // Автовыбор единственного объекта дня; иначе сброс — пусть выбирает вручную.
  useEffect(() => {
    setCorrectionObjectId(dayObjects.length === 1 ? dayObjects[0].object_id : '');
  }, [focusedDay, dayObjects]);

  const handleTypeChange = (next: LeaveRequestType) => {
    setRequestType(next);
    setSelectedDates(new Set());
    setRangeStart('');
    setRangeEnd('');
    setCorrectionObjectId('');
  };

  const toggleDay = (iso: string) => {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  };

  const handleDayFocus = (iso: string, payload: IDayFocusPayload) => {
    setFocusedDay(iso);
    setFocusedPayload(payload);
  };

  const sortedDates = useMemo(() => [...selectedDates].sort(), [selectedDates]);

  const handleFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const next: File[] = [];
    for (const file of Array.from(incoming)) {
      if (!ALLOWED_MIMES.includes(file.type)) { showToast('error', `${file.name}: разрешены только PDF, JPG, PNG`); continue; }
      if (file.size > MAX_FILE_SIZE) { showToast('error', `${file.name}: превышает 10 МБ`); continue; }
      next.push(file);
    }
    if (next.length > 0) setFiles(prev => [...prev, ...next]);
  };

  const handleSubmit = async () => {
    if (!employeeId) return showToast('error', 'Не найден ID сотрудника');
    const parsedCorrectionHours = parseFloat(correctionHours);
    const days = sortedDates;

    if (isCorrection) {
      if (days.length === 0) return showToast('error', 'Выберите день(дни) на календаре');
      if (!correctionHours.trim() || !Number.isInteger(parsedCorrectionHours) || parsedCorrectionHours < 0) {
        return showToast('error', 'Часы — только целым числом (8, 9, 10…)');
      }
      if (!correctionObjectId) return showToast('error', 'Выберите объект для корректировки');
    } else if (isRangeType) {
      if (!rangeStart || !rangeEnd) return showToast('error', 'Укажите период (с — по)');
      if (rangeEnd < rangeStart) return showToast('error', 'Дата окончания раньше даты начала');
      if (requestType === 'sick_leave' && files.length === 0) return showToast('error', 'Для больничного приложите файл');
    } else {
      if (days.length === 0) return showToast('error', 'Выберите хотя бы один день');
    }

    setSubmitting(true);
    try {
      const uploadFilesTo = async (requestId: number): Promise<number> => {
        if (files.length === 0) return 0;
        const uploads = await Promise.allSettled(
          files.map(file => documentService.uploadFile(file, employeeId, 'leave_request_attachment', requestId)),
        );
        return uploads.filter(u => u.status === 'rejected').length;
      };

      let failedFiles = 0;
      let firstCreated: ILeaveRequest | null = null;

      if (isCorrection) {
        // По одному заявлению на каждый выбранный день — одинаковые часы/объект/причина.
        const results = await Promise.allSettled(
          days.map(day => leaveRequestService.create({
            request_type: 'time_correction',
            start_date: day,
            end_date: day,
            reason: reason.trim() || undefined,
            correction_date: day,
            correction_status: 'work',
            correction_hours: parsedCorrectionHours,
            correction_object_id: correctionObjectId,
          })),
        );
        const created = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
        if (created.length === 0) {
          const firstErr = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
          throw new Error(firstErr?.reason instanceof Error ? firstErr.reason.message : 'Не удалось создать корректировку');
        }
        firstCreated = created[0];
        failedFiles = await uploadFilesTo(created[0].id);
        if (created.length < days.length) {
          showToast('warning', `Создано ${created.length} из ${days.length} корректировок`);
        }
      } else {
        const payload = isRangeType
          ? {
              request_type: requestType,
              start_date: rangeStart,
              end_date: rangeEnd,
              reason: reason.trim() || undefined,
            }
          : {
              request_type: requestType,
              start_date: days[0],
              end_date: days[days.length - 1],
              selected_dates: days,
              reason: reason.trim() || undefined,
            };
        const created = await leaveRequestService.create(payload);
        firstCreated = created;
        failedFiles = await uploadFilesTo(created.id);
      }

      if (failedFiles > 0) showToast('warning', `${failedFiles} файл(ов) не загрузились`);

      // Оптимистично добавляем созданное заявление в кэш — чтобы оно появилось
      // в списке сразу при закрытии модалки (не ждём refetch).
      if (firstCreated) {
        const created = firstCreated;
        queryClient.setQueryData<ILeaveRequest[] | undefined>(
          getMyLeaveRequestsQueryKey(),
          (prev) => (prev ? [created, ...prev.filter(r => r.id !== created.id)] : [created]),
        );
      }
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
      // Календарь личного кабинета (MyMonthTimesheet) читает табель по ключу
      // ['employee-timesheet-summary', employeeId, monthKey] — без этой
      // инвалидации часы/бейдж заявки не появлялись до перезагрузки.
      await queryClient.invalidateQueries({ queryKey: ['employee-timesheet-summary', employeeId] });
      showToast('success', 'Заявление отправлено');
      onClose();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalOverlay} {...overlayDismiss}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Подать заявление</h2>
          <button className={styles.modalClose} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className={styles.modalBody}>
          {/* Type selector */}
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Тип заявления <span className={styles.required}>*</span></label>
            <select
              className={styles.formSelect}
              value={requestType}
              onChange={e => handleTypeChange(e.target.value as LeaveRequestType)}
            >
              {UNIFIED_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          {isRangeType ? (
            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Дата начала <span className={styles.required}>*</span></label>
                <input
                  type="date"
                  className={styles.formInput}
                  value={rangeStart}
                  onChange={e => setRangeStart(e.target.value)}
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Дата окончания <span className={styles.required}>*</span></label>
                <input
                  type="date"
                  className={styles.formInput}
                  value={rangeEnd}
                  min={rangeStart || undefined}
                  onChange={e => setRangeEnd(e.target.value)}
                />
              </div>
            </div>
          ) : (
            /* Calendar (мультивыбор дней, с часами и статусами заявок) */
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                {isCorrection ? <>Выберите день(дни) <span className={styles.required}>*</span></> : <>Выберите дни <span className={styles.required}>*</span></>}
                {selectedDates.size > 0 && (
                  <span className={styles.reqCalSelectedCount}> — выбрано: {selectedDates.size} дн.</span>
                )}
              </label>
              <MyMonthTimesheet
                employeeId={employeeId}
                selectedDates={selectedDates}
                onDayToggle={iso => toggleDay(iso)}
                onDayFocus={handleDayFocus}
                noCard
                allowFuture
              />
              {selectedDates.size > 0 && (
                <div className={styles.reqCalChips}>
                  {sortedDates.map(d => (
                    <span key={d} className={styles.reqCalChip}>
                      {new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                      <button type="button" className={styles.reqCalChipRemove} onClick={() => toggleDay(d)}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Correction: целые часы + обязательный объект */}
          {isCorrection && (
            <>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Часы <span className={styles.required}>*</span></label>
                <input
                  type="number"
                  className={styles.formInput}
                  value={correctionHours}
                  onChange={e => setCorrectionHours(e.target.value)}
                  step={1}
                  min={0}
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Объект <span className={styles.required}>*</span></label>
                <select
                  className={styles.formSelect}
                  value={correctionObjectId}
                  onChange={e => setCorrectionObjectId(e.target.value)}
                  disabled={objectOptions.length === 0}
                >
                  <option value="">{objectOptions.length === 0 ? 'Нет доступных объектов' : '— выберите объект —'}</option>
                  {objectOptions.map(o => (
                    <option key={o.object_id} value={o.object_id}>{o.object_name}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* Comment (скрыт для справки — как на главной) */}
          {requestType !== 'certificate' && (
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                {requestType === 'sick_leave' ? 'Комментарий / номер ЭЛН' : 'Комментарий'}
              </label>
              <textarea
                className={styles.formTextarea}
                placeholder={requestType === 'remote' ? 'Причина работы из дома...' : 'Дополнительная информация...'}
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
            </div>
          )}

          {/* Files */}
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>
              Документы {requestType === 'sick_leave' && <span className={styles.required}>*</span>}
              <span style={{ fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 6, fontSize: 12 }}>(PDF, JPG, PNG до 10 МБ)</span>
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <button type="button" className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
                Выбрать файлы
              </button>
              {isMobile && (
                <button type="button" className="btn-secondary" onClick={() => cameraInputRef.current?.click()}>
                  Сделать фото
                </button>
              )}
            </div>
            <input ref={fileInputRef} type="file" multiple accept={ACCEPT_ATTR} style={{ display: 'none' }}
              onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
              onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
            {files.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {files.map((file, idx) => (
                  <div key={`${file.name}-${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, fontSize: 13 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {file.name}
                      <span style={{ color: 'var(--text-tertiary)', marginLeft: 8 }}>{formatBytes(file.size)}</span>
                    </span>
                    <button type="button" onClick={() => setFiles(prev => prev.filter((_, i) => i !== idx))}
                      style={{ background: 'transparent', border: 0, color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px' }} aria-label="Удалить">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={styles.modalFooter}>
          <button className="btn-secondary" onClick={onClose} disabled={submitting}>Отмена</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Отправка...' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ITwoFAModalProps {
  twoFAData: { secret: string; qrCode: string; recoveryCodes: string[] };
  verifyCode: string;
  setVerifyCode: (v: string) => void;
  isEnabling2FA: boolean;
  onEnable: () => void;
  onClose: () => void;
}

export const TwoFAModal: FC<ITwoFAModalProps> = ({ twoFAData, verifyCode, setVerifyCode, isEnabling2FA, onEnable, onClose }) => (
  <div className={styles.modalOverlay} onClick={onClose}>
    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>Настройка 2FA</h2>
        <button className={styles.modalClose} onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div className={styles.modalBody}>
        <p style={{ marginBottom: 12, fontSize: 13 }}>Отсканируйте QR-код в приложении аутентификации:</p>
        <img src={twoFAData.qrCode} alt="QR" style={{ display: 'block', margin: '0 auto 16px', maxWidth: 200 }} />
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>Или введите вручную:</p>
        <code style={{ display: 'block', padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, fontSize: 12, marginBottom: 16, wordBreak: 'break-all' }}>{twoFAData.secret}</code>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Код из приложения</label>
          <input type="text" className={styles.formInput} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="000000" maxLength={6} />
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className="btn-secondary" onClick={onClose}>Отмена</button>
        <button className="btn-primary" onClick={onEnable} disabled={isEnabling2FA}>
          {isEnabling2FA ? 'Проверка...' : 'Подтвердить'}
        </button>
      </div>
    </div>
  </div>
);
