import React, { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { apiClient } from '../../api/client';
import { employeeService } from '../../services/employeeService';
import type { Employee } from '../../types';
import { useEmployeeTimesheetMonths } from '../../hooks/useEmployeeTimesheet';
import styles from './EmployeeDashboard.module.css';

const EmployeeInfoCards = lazy(() => import('../../components/dashboard/EmployeeInfoCards').then(m => ({ default: m.EmployeeInfoCards })));
const DailyTasksCard = lazy(() => import('../../components/dashboard/DailyTasksCard').then(m => ({ default: m.DailyTasksCard })));
const UnifiedRequestModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.UnifiedRequestModal })));
const TwoFAModal = lazy(() => import('../../components/dashboard/RequestModals').then(m => ({ default: m.TwoFAModal })));
const MyMonthTimesheet = lazy(() => import('../../components/dashboard/MyMonthTimesheet').then(m => ({ default: m.MyMonthTimesheet })));

const pad2 = (n: number) => String(n).padStart(2, '0');

export const EmployeeDashboardPage: React.FC = () => {

  const { user, profile, refreshProfile, isTwoFactorEnabled, timesheetMonthsBack, timesheetMonthsForward } = useAuth();
  const { showToast } = useToast();
  const [showRequestModal, setShowRequestModal] = useState(false);

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

  const DashboardCardFallback = (
    <div className={styles.infoCard}>
      <div className={styles.emptyState}>Загрузка...</div>
    </div>
  );

  return (
    <div className={styles.content}>
      {/* Header with request button (заголовок «Личный кабинет» уже в верхней панели) */}
      <div className={styles.sectionHeader}>
        <button className="btn-primary" onClick={() => setShowRequestModal(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Подать заявление
        </button>
      </div>

      {/* Content Grid */}
      <div className={styles.contentGrid}>
        {/* Calendar */}
        <div className={styles.calendarEventsBlock}>
          <div className={styles.calendarPane}>
            <Suspense fallback={<div className={styles.emptyState}>Загрузка...</div>}>
              <MyMonthTimesheet
                employeeId={employeeId}
                noCard
              />
            </Suspense>
          </div>
        </div>

        {/* Right column: Employee Info */}
        <div className={styles.rightColumn}>
          <Suspense fallback={DashboardCardFallback}>
            <DailyTasksCard />
          </Suspense>
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

      {showRequestModal && (
        <Suspense fallback={null}>
          <UnifiedRequestModal
            employeeId={employeeId}
            onClose={() => setShowRequestModal(false)}
          />
        </Suspense>
      )}
    </div>
  );
};
