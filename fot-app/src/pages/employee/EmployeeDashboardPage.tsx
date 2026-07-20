import React, { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { apiClient } from '../../api/client';
import { employeeService } from '../../services/employeeService';
import { useMyLeaveRequests } from '../../hooks/usePortalData';
import { useMySimNumbers } from '../../hooks/useMySim';
import type { Employee } from '../../types';
import { useEmployeeTimesheetMonths } from '../../hooks/useEmployeeTimesheet';
import styles from './EmployeeDashboard.module.css';

import type { IDayFocusPayload } from '../../components/dashboard/MyMonthTimesheet';
import { LeaveRequestRow } from '../../components/dashboard/LeaveRequestRow';

const EmployeeInfoCard = lazy(() => import('../../components/dashboard/EmployeeInfoCards').then(m => ({ default: m.EmployeeInfoCard })));
const SecurityCard = lazy(() => import('../../components/dashboard/EmployeeInfoCards').then(m => ({ default: m.SecurityCard })));
const DailyTasksCard = lazy(() => import('../../components/dashboard/DailyTasksCard').then(m => ({ default: m.DailyTasksCard })));
const FeedbackCard = lazy(() => import('../../components/dashboard/FeedbackCard').then(m => ({ default: m.FeedbackCard })));
const TestPromptCard = lazy(() => import('../../components/dashboard/TestPromptCard').then(m => ({ default: m.TestPromptCard })));
const AdaptiveTestCard = lazy(() => import('../../components/dashboard/AdaptiveTestCard').then(m => ({ default: m.AdaptiveTestCard })));
const TwoFAModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.TwoFAModal })));
const UnifiedRequestModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.UnifiedRequestModal })));
const MyMonthTimesheet = lazy(() => import('../../components/dashboard/MyMonthTimesheet').then(m => ({ default: m.MyMonthTimesheet })));
const DayDetailPanel = lazy(() => import('../../components/dashboard/DayDetailPanel').then(m => ({ default: m.DayDetailPanel })));
const PresenceTimeline = lazy(() => import('../../components/skud/PresenceTimeline').then(m => ({ default: m.PresenceTimeline })));

const todayLocalIso = (): string => new Date().toLocaleDateString('en-CA');

// «Последнее 1 заявление» / «Последние 3 заявления» / «Последние 5 заявлений».
const recentRequestsHeading = (n: number): string => {
  const d = n % 10;
  const dd = n % 100;
  const noun = dd >= 11 && dd <= 14 ? 'заявлений' : d === 1 ? 'заявление' : d >= 2 && d <= 4 ? 'заявления' : 'заявлений';
  const adj = n === 1 ? 'Последнее' : 'Последние';
  return `${adj} ${n} ${noun}:`;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

export const EmployeeDashboardPage: React.FC = () => {

  const { user, profile, refreshProfile, isTwoFactorEnabled, timesheetMonthsBack, timesheetMonthsForward, canViewPage, canEditPage } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  // Создание заявления — общая модалка (та же, что на странице «Мои заявления»).
  const [showRequestModal, setShowRequestModal] = useState(false);

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
  // Корпоративный номер МТС — строка «Телефон» в блоке «Информация».
  const mySimNumbersQuery = useMySimNumbers(!!employeeId);

  const employee = employeeQuery.data ?? null;
  // Расписание сотрудника берём из первого месяца окна, где оно присутствует (для ритма графика).
  const schedule = useMemo(() => {
    if (!employeeId) return undefined;
    for (const m of timesheetQuery.data ?? []) {
      const s = m.schedules?.[employeeId];
      if (s) return s;
    }
    return undefined;
  }, [timesheetQuery.data, employeeId]);

  // Права на «Мои заявления»: view — список и переходы, edit — подача/отмена.
  // У ролей без прав (напр. без строки /employee/requests в role_page_access)
  // блок не показываем — иначе подача упрётся в 403 на сервере.
  const canViewRequests = canViewPage('/employee/requests');
  const canEditRequests = canEditPage('/employee/requests');

  // Последние заявления для блока списка (свежие сверху, максимум 5).
  const leaveRequestsQuery = useMyLeaveRequests(canViewRequests);
  const recentRequests = useMemo(() => {
    const list = leaveRequestsQuery.data ?? [];
    return [...list]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 5);
  }, [leaveRequestsQuery.data]);
  const todayIso = todayLocalIso();

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

  // Клик по дню задаёт фокус для блока деталей/СКУД справа от календаря (#7, #10).
  const handleDayFocus = (iso: string, payload: IDayFocusPayload) => {
    setFocusedDay(iso);
    setFocusedPayload(payload);
    setFocusKey(k => k + 1);
  };

  const DashboardCardFallback = (
    <div className={styles.infoCard}>
      <div className={styles.emptyState}>Загрузка...</div>
    </div>
  );

  return (
    <div className={styles.content}>
      {/* Интервалы присутствия — всегда за текущий день, поверх всех блоков */}
      {employeeId && (
        <Suspense fallback={null}>
          <PresenceTimeline employeeId={employeeId} date={todayLocalIso()} className={styles.presencePane} />
        </Suspense>
      )}

      {/* Content Grid: Calendar | Day detail | Form */}
      <div className={styles.contentGrid}>
        {/* Верхний ряд: Проходы | Календарь | Заявления */}
        <div className={styles.topRow}>
          {/* Проходы за выбранный день (по умолчанию — сегодня, #7, #10) */}
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
              <div className={styles.detailHint}>Загрузка проходов…</div>
            )}
          </div>

          {/* Календарь */}
          <div className={styles.calendarEventsBlock}>
            <div className={styles.calendarPane}>
              <Suspense fallback={<div className={styles.emptyState}>Загрузка...</div>}>
                <MyMonthTimesheet
                  employeeId={employeeId}
                  noCard
                  activeDayIso={focusedDay ?? undefined}
                  onDayFocus={handleDayFocus}
                  allowFuture
                />
              </Suspense>
            </div>
          </div>

          {/* Заявления: кнопка подачи + список последних */}
          {canViewRequests && (
          <div className={styles.formPane}>
            {canEditRequests && (
              <button className="btn-primary" onClick={() => setShowRequestModal(true)} style={{ width: '100%', marginBottom: '14px' }}>
                Подать заявление
              </button>
            )}
            {recentRequests.length === 0 ? (
              <div className={styles.emptyState}>Заявлений пока нет</div>
            ) : (
              <div className={styles.recentRequests}>
                <div className={styles.recentRequestsTitle}>{recentRequestsHeading(recentRequests.length)}</div>
                {recentRequests.map(r => (
                  <LeaveRequestRow
                    key={r.id}
                    request={r}
                    today={todayIso}
                    onClick={() => navigate(`/employee/requests/${r.id}`)}
                  />
                ))}
              </div>
            )}
          </div>
          )}
        </div>

        {/* Правая узкая колонка: Информация → Тест → Задачи → Обратная связь → Безопасность */}
        <div className={styles.rightCol}>
          <Suspense fallback={DashboardCardFallback}>
            <EmployeeInfoCard
              loading={loading}
              employee={employee}
              importedPosition={profile?.imported_position ?? undefined}
              schedule={schedule}
              phones={mySimNumbersQuery.data}
            />
          </Suspense>
          <Suspense fallback={null}>
            <TestPromptCard />
          </Suspense>
          <Suspense fallback={null}>
            <AdaptiveTestCard />
          </Suspense>
          <Suspense fallback={DashboardCardFallback}>
            <DailyTasksCard />
          </Suspense>
          <Suspense fallback={DashboardCardFallback}>
            <FeedbackCard />
          </Suspense>
          <Suspense fallback={DashboardCardFallback}>
            <SecurityCard
              email={user?.email ?? undefined}
              isTwoFactorEnabled={isTwoFactorEnabled}
              onSetup2FA={handleSetup2FA}
              onDisable2FA={handleDisable2FA}
            />
          </Suspense>
        </div>
      </div>

      {showRequestModal && canEditRequests && (
        <Suspense fallback={null}>
          <UnifiedRequestModal
            employeeId={employeeId}
            presetDate={focusedDay}
            onClose={() => setShowRequestModal(false)}
          />
        </Suspense>
      )}

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
