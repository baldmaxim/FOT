import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { leaveRequestService, type ILeaveRequest, type LeaveRequestType } from '../../services/leaveRequestService';
import { documentService } from '../../services/documentService';
import { getMyLeaveRequestsQueryKey } from '../../hooks/usePortalData';
import { useToast } from '../../contexts/ToastContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { MyMonthTimesheet } from './MyMonthTimesheet';
import type { TimesheetEntry } from '../../types';
import styles from '../../pages/employee/EmployeeDashboard.module.css';

type RequestType = 'vacation' | 'sick' | 'remote' | 'docs';

const TYPE_TO_LEAVE: Record<Exclude<RequestType, 'docs'>, LeaveRequestType> = {
  vacation: 'vacation',
  sick: 'sick_leave',
  remote: 'remote',
};

const TITLES: Record<RequestType, string> = {
  vacation: 'Заявление на отпуск',
  sick: 'Больничный лист',
  remote: 'Удалённая работа',
  docs: 'Запрос справки',
};

const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 МБ
const ACCEPT_ATTR = '.pdf,application/pdf,image/jpeg,image/png';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
};

interface IRequestModalProps {
  activeModal: RequestType;
  onClose: () => void;
  employeeId: number | null;
  presetDates?: { start: string; end: string } | null;
}

export const RequestModal: FC<IRequestModalProps> = ({ activeModal, onClose, employeeId, presetDates }) => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const isMobile = useIsMobile();

  const [startDate, setStartDate] = useState(presetDates?.start || '');
  const [endDate, setEndDate] = useState(presetDates?.end || '');
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (presetDates) {
      setStartDate(presetDates.start);
      setEndDate(presetDates.end);
    }
  }, [presetDates]);

  const isLeaveType = activeModal !== 'docs';

  const handleFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const next: File[] = [];
    for (const file of Array.from(incoming)) {
      if (!ALLOWED_MIMES.includes(file.type)) {
        showToast('error', `${file.name}: разрешены только PDF, JPG, PNG`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        showToast('error', `${file.name}: превышает 10 МБ`);
        continue;
      }
      next.push(file);
    }
    if (next.length > 0) setFiles(prev => [...prev, ...next]);
  };

  const removeFile = (idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (activeModal === 'docs') {
      showToast('info', 'Запрос справки пока не реализован');
      return;
    }
    if (!isLeaveType) return;
    if (!employeeId) {
      showToast('error', 'Не найден ID сотрудника');
      return;
    }
    if (!startDate || !endDate) {
      showToast('error', 'Укажите даты');
      return;
    }
    if (activeModal === 'sick' && files.length === 0) {
      showToast('error', 'Для больничного приложите файл (PDF или фото)');
      return;
    }

    setSubmitting(true);
    try {
      const created = await leaveRequestService.create({
        request_type: TYPE_TO_LEAVE[activeModal as Exclude<RequestType, 'docs'>],
        start_date: startDate,
        end_date: endDate,
        reason: reason.trim() || undefined,
      });

      if (files.length > 0) {
        const uploads = await Promise.allSettled(
          files.map(file => documentService.uploadFile(file, employeeId, 'leave_request_attachment', created.id)),
        );
        const failed = uploads.filter(u => u.status === 'rejected').length;
        if (failed > 0) {
          showToast('warning', `Заявка создана, но ${failed} файл(ов) не загрузились`);
        }
      }

      // Оптимистично добавляем созданное заявление в начало списка, чтобы оно
      // появилось на странице «Мои заявления» сразу при закрытии модалки —
      // не ждём пока refetch завершится.
      queryClient.setQueryData<ILeaveRequest[] | undefined>(
        getMyLeaveRequestsQueryKey(),
        (prev) => (prev ? [created, ...prev.filter(r => r.id !== created.id)] : [created]),
      );
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
      // Календарь личного кабинета (MyMonthTimesheet) читает табель по ключу
      // ['employee-timesheet-summary', employeeId, monthKey] — без этой
      // инвалидации часы/бейдж заявки не появлялись до перезагрузки.
      await queryClient.invalidateQueries({ queryKey: ['employee-timesheet-summary', employeeId] });
      showToast('success', 'Заявление отправлено');
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка отправки';
      showToast('error', message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>{TITLES[activeModal]}</h2>
          <button className={styles.modalClose} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className={styles.modalBody}>
          {activeModal === 'docs' ? (
            <>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Тип справки <span className={styles.required}>*</span></label>
                <select className={styles.formSelect}>
                  <option>2-НДФЛ</option>
                  <option>Справка с места работы</option>
                  <option>Копия трудовой книжки</option>
                  <option>Справка о доходах</option>
                </select>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Комментарий</label>
                <textarea
                  className={styles.formTextarea}
                  placeholder="Для чего нужна справка..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div className={styles.formRow}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Дата начала <span className={styles.required}>*</span></label>
                  <input
                    type="date"
                    className={styles.formInput}
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Дата окончания <span className={styles.required}>*</span></label>
                  <input
                    type="date"
                    className={styles.formInput}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  {activeModal === 'sick' ? 'Комментарий / номер ЭЛН' : 'Комментарий / причина'}
                </label>
                <textarea
                  className={styles.formTextarea}
                  placeholder={activeModal === 'remote' ? 'Укажите причину работы из дома...' : 'Дополнительная информация...'}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  Прикреплённые файлы {activeModal === 'sick' && <span className={styles.required}>*</span>}
                  <span style={{ fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 6, fontSize: 12 }}>
                    (PDF, JPG, PNG до 10 МБ)
                  </span>
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Выбрать файлы
                  </button>
                  {isMobile && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => cameraInputRef.current?.click()}
                    >
                      Сделать фото
                    </button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPT_ATTR}
                  style={{ display: 'none' }}
                  onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
                />
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
                />
                {files.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {files.map((file, idx) => (
                      <div
                        key={`${file.name}-${idx}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 12px',
                          background: 'var(--bg-tertiary)',
                          borderRadius: 8,
                          fontSize: 13,
                        }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {file.name}
                          <span style={{ color: 'var(--text-tertiary)', marginLeft: 8 }}>{formatBytes(file.size)}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFile(idx)}
                          style={{
                            background: 'transparent',
                            border: 0,
                            color: 'var(--text-tertiary)',
                            cursor: 'pointer',
                            fontSize: 18,
                            lineHeight: 1,
                            padding: '0 4px',
                          }}
                          aria-label="Удалить файл"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className={styles.modalFooter}>
          <button className="btn-secondary" onClick={onClose} disabled={submitting}>
            Отмена
          </button>
          <button className="btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Отправка...' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
};

const UNIFIED_TYPES: { value: LeaveRequestType; label: string }[] = [
  { value: 'remote', label: 'Удалённая работа' },
  { value: 'work', label: 'Работа' },
  { value: 'vacation', label: 'Отпуск' },
  { value: 'unpaid', label: 'За свой счёт' },
  { value: 'sick_leave', label: 'Больничный' },
  { value: 'time_correction', label: 'Корректировка табеля' },
];

const RANGE_TYPES: LeaveRequestType[] = ['vacation', 'unpaid', 'sick_leave'];

interface IUnifiedRequestModalProps {
  onClose: () => void;
  employeeId: number | null;
}

export const UnifiedRequestModal: FC<IUnifiedRequestModalProps> = ({ onClose, employeeId }) => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const isMobile = useIsMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [requestType, setRequestType] = useState<LeaveRequestType>('remote');
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [correctionDate, setCorrectionDate] = useState('');
  const [correctionStatus, setCorrectionStatus] = useState('work');
  const [correctionHours, setCorrectionHours] = useState<number>(8);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  const isCorrection = requestType === 'time_correction';
  const isRangeType = RANGE_TYPES.includes(requestType);

  const handleTypeChange = (next: LeaveRequestType) => {
    setRequestType(next);
    setSelectedDates(new Set());
    setRangeStart('');
    setRangeEnd('');
    setCorrectionDate('');
  };

  const toggleDay = (iso: string) => {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  };

  const handleCorrectionPick = (iso: string, entry: TimesheetEntry | null) => {
    setCorrectionDate(iso);
    if (entry?.hours_worked != null) setCorrectionHours(entry.hours_worked);
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
    if (isCorrection) {
      if (!correctionDate) return showToast('error', 'Укажите дату корректировки');
    } else if (isRangeType) {
      if (!rangeStart || !rangeEnd) return showToast('error', 'Укажите период (с — по)');
      if (rangeEnd < rangeStart) return showToast('error', 'Дата окончания раньше даты начала');
      if (requestType === 'sick_leave' && files.length === 0) return showToast('error', 'Для больничного приложите файл');
    } else {
      if (selectedDates.size === 0) return showToast('error', 'Выберите хотя бы один день');
    }
    setSubmitting(true);
    try {
      const payload = isCorrection
        ? {
            request_type: requestType,
            start_date: correctionDate,
            end_date: correctionDate,
            reason: reason.trim() || undefined,
            correction_date: correctionDate,
            correction_status: correctionStatus,
            correction_hours: correctionHours,
          }
        : isRangeType
          ? {
              request_type: requestType,
              start_date: rangeStart,
              end_date: rangeEnd,
              reason: reason.trim() || undefined,
            }
          : {
              request_type: requestType,
              start_date: sortedDates[0],
              end_date: sortedDates[sortedDates.length - 1],
              reason: reason.trim() || undefined,
              selected_dates: sortedDates,
            };
      const created = await leaveRequestService.create(payload);
      if (files.length > 0) {
        const uploads = await Promise.allSettled(
          files.map(file => documentService.uploadFile(file, employeeId, 'leave_request_attachment', created.id)),
        );
        const failed = uploads.filter(u => u.status === 'rejected').length;
        if (failed > 0) showToast('warning', `Заявка создана, но ${failed} файл(ов) не загрузились`);
      }
      // Оптимистично добавляем созданное заявление в кэш — чтобы оно появилось
      // на странице «Мои заявления» сразу при закрытии модалки.
      queryClient.setQueryData<ILeaveRequest[] | undefined>(
        getMyLeaveRequestsQueryKey(),
        (prev) => (prev ? [created, ...prev.filter(r => r.id !== created.id)] : [created]),
      );
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
      // Календарь личного кабинета (MyMonthTimesheet) читает табель по ключу
      // ['employee-timesheet-summary', employeeId, monthKey] — без этой
      // инвалидации часы/бейдж корректировки не появлялись до reload.
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
    <div className={styles.modalOverlay} onClick={onClose}>
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
            /* Calendar (с часами и статусами заявок) */
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                {isCorrection ? (
                  <>Выберите день <span className={styles.required}>*</span></>
                ) : (
                  <>Выберите дни <span className={styles.required}>*</span></>
                )}
                {!isCorrection && selectedDates.size > 0 && (
                  <span className={styles.reqCalSelectedCount}> — выбрано: {selectedDates.size} дн.</span>
                )}
              </label>
              {isCorrection ? (
                <MyMonthTimesheet
                  employeeId={employeeId}
                  activeDayIso={correctionDate || null}
                  onDayActivate={handleCorrectionPick}
                  noCard
                  allowFuture
                />
              ) : (
                <MyMonthTimesheet
                  employeeId={employeeId}
                  selectedDates={selectedDates}
                  onDayToggle={iso => toggleDay(iso)}
                  noCard
                  allowFuture
                />
              )}
              {!isCorrection && selectedDates.size > 0 && (
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

          {isCorrection && (
            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Статус <span className={styles.required}>*</span></label>
                <select
                  className={styles.formSelect}
                  value={correctionStatus}
                  onChange={e => setCorrectionStatus(e.target.value)}
                >
                  <option value="work">Присутствие</option>
                  <option value="remote">Удалёнка</option>
                  <option value="sick">Больничный</option>
                  <option value="vacation">Отпуск</option>
                </select>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Часы <span className={styles.required}>*</span></label>
                <input
                  type="number"
                  className={styles.formInput}
                  value={correctionHours}
                  onChange={e => setCorrectionHours(parseFloat(e.target.value) || 0)}
                  min={0}
                  max={24}
                  step={0.5}
                />
              </div>
            </div>
          )}

          {/* Comment */}
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
