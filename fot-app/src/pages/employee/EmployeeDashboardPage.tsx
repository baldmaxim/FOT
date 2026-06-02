import React, { lazy, Suspense, useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { apiClient } from '../../api/client';
import { employeeService } from '../../services/employeeService';
import { leaveRequestService, type LeaveRequestType } from '../../services/leaveRequestService';
import { documentService } from '../../services/documentService';
import { getMyLeaveRequestsQueryKey } from '../../hooks/usePortalData';
import type { Employee } from '../../types';
import { useEmployeeTimesheetMonths } from '../../hooks/useEmployeeTimesheet';
import styles from './EmployeeDashboard.module.css';

import type { IDayFocusPayload } from '../../components/dashboard/MyMonthTimesheet';

const EmployeeInfoCards = lazy(() => import('../../components/dashboard/EmployeeInfoCards').then(m => ({ default: m.EmployeeInfoCards })));
const DailyTasksCard = lazy(() => import('../../components/dashboard/DailyTasksCard').then(m => ({ default: m.DailyTasksCard })));
const TwoFAModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.TwoFAModal })));
const MyMonthTimesheet = lazy(() => import('../../components/dashboard/MyMonthTimesheet').then(m => ({ default: m.MyMonthTimesheet })));
const DayDetailPanel = lazy(() => import('../../components/dashboard/DayDetailPanel').then(m => ({ default: m.DayDetailPanel })));

// «За свой счёт» (unpaid) теперь подаётся датами на календаре, а не периодом.
const RANGE_TYPES: LeaveRequestType[] = ['vacation', 'sick_leave', 'educational_leave'];
const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const pad2 = (n: number) => String(n).padStart(2, '0');

export const EmployeeDashboardPage: React.FC = () => {

  const { user, profile, refreshProfile, isTwoFactorEnabled, timesheetMonthsBack, timesheetMonthsForward } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form state. По умолчанию — корректировка табеля (открывается по клику на день).
  const [requestType, setRequestType] = useState<LeaveRequestType>('time_correction');
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [correctionHours, setCorrectionHours] = useState('8');
  const [correctionObjectId, setCorrectionObjectId] = useState('');

  // Фокус дня для блока деталей/СКУД (#7, #10). focusKey форсит перезагрузку СКУД при повторном клике.
  const [focusedDay, setFocusedDay] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [focusedPayload, setFocusedPayload] = useState<IDayFocusPayload | null>(null);

  // 2FA state
  const [show2FASetup, setShow2FASetup] = useState(false);
  const [twoFAData, setTwoFAData] = useState<{ secret: string; qrCode: string; recoveryCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [isEnabling2FA, setIsEnabling2FA] = useState(false);

  const employeeId = profile?.employee_id ?? null;

  // Загружаем окно [now - monthsBack .. now + monthsForward], настроенное per-role
  // (см. system_roles.timesheet_months_back / timesheet_months_forward, миграция 094).
  const timesheetMonthKeys = useMemo(() => {
    const today = new Date();
    const result: string[] = [];
    for (let offset = -timesheetMonthsBack; offset <= timesheetMonthsForward; offset += 1) {
      const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      result.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
    }
    return result;
  }, [timesheetMonthsBack, timesheetMonthsForward]);

  useEffect(() => {
    if (!employeeId && refreshProfile) {
      refreshProfile();
    }
  }, [employeeId, refreshProfile]);

  const employeeQuery = useQuery<Employee | null>({
    queryKey: ['employee', employeeId],
    queryFn: () => employeeService.getById(employeeId as number),
    enabled: !!employeeId,
    staleTime: 60_000,
  });

  const timesheetQuery = useEmployeeTimesheetMonths(employeeId, timesheetMonthKeys, !!employeeId);

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

  // Опции выпадашки: объекты дня; если их нет (прогул/отсутствие) — полный закреплённый список.
  const objectOptions = dayObjects.length > 0 ? dayObjects : myObjects;

  // Автовыбор единственного объекта дня; иначе сброс — пусть выбирает вручную.
  useEffect(() => {
    setCorrectionObjectId(dayObjects.length === 1 ? dayObjects[0].object_id : '');
  }, [focusedDay, dayObjects]);

  const employee = employeeQuery.data ?? null;

  const loading = employeeQuery.isLoading || timesheetQuery.isLoading;

  const handleSetup2FA = async () => {
    try {
      const data = await apiClient.post<{ secret: string; qrCode: string; recoveryCodes: string[] }>('/auth/2fa/setup');
      setTwoFAData(data);
      setShow2FASetup(true);
    } catch {
      showToast('error', 'Ошибка при настройке 2FA');
    }
  };

  const handleEnable2FA = async () => {
    if (!verifyCode.trim()) { showToast('error', 'Введите код'); return; }
    setIsEnabling2FA(true);
    try {
      await apiClient.post('/auth/2fa/enable', { code: verifyCode });
      await refreshProfile();
      setShow2FASetup(false); setTwoFAData(null); setVerifyCode('');
      showToast('success', '2FA включена');
    } catch {
      showToast('error', 'Неверный код');
    } finally {
      setIsEnabling2FA(false);
    }
  };

  const handleDisable2FA = async () => {
    if (!confirm('Отключить двухфакторную аутентификацию?')) return;
    try {
      await apiClient.post('/auth/2fa/disable');
      await refreshProfile();
      showToast('success', '2FA отключена');
    } catch {
      showToast('error', 'Ошибка при отключении 2FA');
    }
  };

  const isCorrection = requestType === 'time_correction';
  const isRangeType = RANGE_TYPES.includes(requestType);
  // Форма появляется только после выбора дня в календаре (#1).
  const showForm = focusedDay != null || selectedDates.size > 0;

  const handleTypeChange = (next: LeaveRequestType) => {
    setRequestType(next);
    setSelectedDates(new Set());
    setRangeStart('');
    setRangeEnd('');
  };

  // Любой клик по дню — мультивыбор (в т.ч. для корректировки, #2).
  const handleDayToggle = (iso: string) => {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  };

  // Клик по дню задаёт фокус для блока деталей/СКУД справа от календаря (#7, #10).
  const handleDayFocus = (iso: string, payload: IDayFocusPayload) => {
    setFocusedDay(iso);
    setFocusedPayload(payload);
    setFocusKey(k => k + 1);
  };

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
    if (!employeeId) return showToast('error', 'Не найден ID сотрудника');
    const parsedCorrectionHours = parseFloat(correctionHours);
    const days = Array.from(selectedDates).sort();

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

      if (isCorrection) {
        // По одному заявлению на каждый выбранный день — одинаковые часы/объект/причина (#2, #3).
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
        // Файлы прикрепляем к первой созданной корректировке (общее обоснование).
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
        failedFiles = await uploadFilesTo(created.id);
      }

      if (failedFiles > 0) showToast('warning', `${failedFiles} файл(ов) не загрузились`);

      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: ['employee-timesheet-summary', employeeId] });

      showToast('success', 'Заявление отправлено');

      // Очищаем форму
      setRequestType('time_correction');
      setSelectedDates(new Set());
      setReason('');
      setFiles([]);
      setRangeStart('');
      setRangeEnd('');
      setCorrectionHours('8');
      setCorrectionObjectId('');
      setFocusedDay(null);
      setFocusedPayload(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка отправки';
      showToast('error', message);
    } finally {
      setSubmitting(false);
    }
  };

  const DashboardCardFallback = (
    <div className={styles.infoCard}>
      <div className={styles.emptyState}>Загрузка...</div>
    </div>
  );

  return (
    <div className={styles.content}>
      {/* Content Grid: Calendar | Day detail | Form */}
      <div className={styles.contentGrid}>
        {/* Calendar - Left */}
        <div className={styles.calendarEventsBlock}>
          <div className={styles.calendarPane}>
            <Suspense fallback={<div className={styles.emptyState}>Загрузка...</div>}>
              <MyMonthTimesheet
                employeeId={employeeId}
                noCard
                selectedDates={selectedDates}
                onDayToggle={handleDayToggle}
                onDayFocus={handleDayFocus}
                allowFuture
              />
            </Suspense>
          </div>
        </div>

        {/* Day detail / SKUD - Middle (#7, #10) */}
        <div className={styles.detailPane}>
          {focusedDay && focusedPayload && employeeId ? (
            <Suspense fallback={<div className={styles.detailHint}>Загрузка...</div>}>
              <DayDetailPanel
                employeeId={employeeId}
                employeeName={employee?.full_name ?? ''}
                focusedDay={focusedDay}
                payload={focusedPayload}
                focusKey={focusKey}
              />
            </Suspense>
          ) : (
            <div className={styles.detailHint}>Выберите день в календаре, чтобы увидеть детали и проходы СКУД</div>
          )}
        </div>

        {/* Form / hint - Right */}
        <div className={styles.formPane}>
          {!showForm ? (
            <div className={styles.formHint}>Выберите день в календаре, чтобы подать заявление</div>
          ) : (
            <>
              <h2 className={styles.formTitle}>Подать заявление</h2>

              {/* Type select */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Тип заявления <span className={styles.required}>*</span></label>
                <select className={styles.formSelect} value={requestType} onChange={(e) => handleTypeChange(e.target.value as LeaveRequestType)}>
                  <option value="time_correction">Корректировка табеля</option>
                  <option value="remote">Удалённая работа</option>
                  <option value="work">Работа в выходной/праздник</option>
                  <option value="vacation">Отпуск</option>
                  <option value="sick_leave">Больничный</option>
                  <option value="unpaid">За свой счёт</option>
                  <option value="educational_leave">Учебный отпуск</option>
                  <option value="certificate">Справка</option>
                </select>
              </div>

              {/* Range inputs for vacation/sick/educational */}
              {isRangeType && (
                <div className={styles.formRow}>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Дата начала <span className={styles.required}>*</span></label>
                    <input type="date" className={styles.formInput} value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Дата окончания <span className={styles.required}>*</span></label>
                    <input type="date" className={styles.formInput} value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
                  </div>
                </div>
              )}

              {/* Selected days (мультивыбор: корректировка / удалёнка / работа / справка / за свой счёт) */}
              {!isRangeType && selectedDates.size > 0 && (
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Выбрано дней: {selectedDates.size}</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {Array.from(selectedDates).sort().map(date => (
                      <span key={date} style={{ fontSize: '11px', padding: '3px 8px', background: 'var(--accent-muted)', color: 'var(--accent)', borderRadius: '12px' }}>
                        {new Date(date + 'T00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Correction: целые часы + обязательный объект */}
              {isCorrection && (
                <>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Часов <span className={styles.required}>*</span></label>
                    <input
                      type="number"
                      className={styles.formInput}
                      value={correctionHours}
                      onChange={(e) => setCorrectionHours(e.target.value)}
                      step="1"
                      min="0"
                    />
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Объект <span className={styles.required}>*</span></label>
                    <select
                      className={styles.formSelect}
                      value={correctionObjectId}
                      onChange={(e) => setCorrectionObjectId(e.target.value)}
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

              {/* Reason */}
              {requestType !== 'certificate' && (
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Комментарий</label>
                  <textarea className={styles.formTextarea} placeholder="Задача, причина, примечание..." value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              )}

              {/* File upload — для всех типов; для больничного обязателен */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  Приложение {requestType === 'sick_leave' && <span className={styles.required}>*</span>}
                </label>
                <input type="file" ref={fileInputRef} style={{ display: 'none' }} accept=".pdf,image/*" onChange={(e) => handleFiles(e.target.files)} />
                <button
                  className="btn-secondary"
                  onClick={() => fileInputRef.current?.click()}
                  style={{ width: '100%' }}
                >
                  Выбрать файл (PDF, JPG, PNG)
                </button>
                {files.length > 0 && (
                  <div style={{ marginTop: '8px', fontSize: '12px' }}>
                    {files.map((f, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--text-secondary)' }}>
                        <span>{f.name}</span>
                        <button style={{ background: 'none', border: 'none', color: 'var(--error)', cursor: 'pointer', padding: 0 }} onClick={() => removeFile(idx)}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Submit */}
              <button className="btn-primary" onClick={handleSubmit} disabled={submitting} style={{ width: '100%', marginTop: '12px' }}>
                {submitting ? 'Отправка...' : 'Подать заявление'}
              </button>
            </>
          )}
        </div>

        {/* Задачи — нижняя средняя ячейка сетки */}
        <div className={styles.tasksArea}>
          <Suspense fallback={DashboardCardFallback}>
            <DailyTasksCard />
          </Suspense>
        </div>

        {/* Информация — нижняя правая ячейка сетки */}
        <div className={styles.infoArea}>
          <Suspense fallback={DashboardCardFallback}>
            <EmployeeInfoCards
              loading={loading}
              employee={employee}
              importedPosition={profile?.imported_position ?? undefined}
              email={user?.email ?? undefined}
              isTwoFactorEnabled={isTwoFactorEnabled}
              onSetup2FA={handleSetup2FA}
              onDisable2FA={handleDisable2FA}
            />
          </Suspense>
        </div>
      </div>

      {show2FASetup && twoFAData && (
        <Suspense fallback={null}>
          <TwoFAModal
            twoFAData={twoFAData}
            verifyCode={verifyCode}
            setVerifyCode={setVerifyCode}
            isEnabling2FA={isEnabling2FA}
            onEnable={handleEnable2FA}
            onClose={() => setShow2FASetup(false)}
          />
        </Suspense>
      )}

    </div>
  );
};
