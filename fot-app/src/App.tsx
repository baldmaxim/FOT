import { lazy, Suspense, useEffect } from 'react';
import type { FC } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ChatProvider } from './contexts/ChatContext';
import { OnlinePresenceProvider } from './contexts/OnlinePresenceContext';
import { ProtectedRoute, PublicRoute } from './components/auth/ProtectedRoute';
import { SigurHeaderBadges } from './components/skud/SigurHeaderBadges';
import { CardReaderAgentProvider } from './contexts/CardReaderAgentContext';
import { CardReaderHeaderBadge } from './components/skud/CardReaderHeaderBadge';
import { useTheme } from './hooks/useTheme';
import { useStructureRealtime } from './hooks/useStructureRealtime';
import { PageLoader } from './components/ui/PageLoader';
import { ChatPanelMount } from './components/chat/ChatPanelMount';
import { TooltipHost } from './components/ui/Tooltip';
import { AppUpdateBanner } from './components/ui/AppUpdateBanner';
import { ErrorFallback } from './components/ErrorFallback';
import { clearStaleChunkReloadFlag, tryAutoReloadOnStaleChunk } from './utils/staleChunkReload';
import './App.css';

const StructureRealtimeMount: FC = () => {
  useStructureRealtime();
  return null;
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retry: 1,
    },
  },
});

if (import.meta.env.DEV) {
  // DEV-only хук для отладки кеша React Query из консоли:
  // window.__qc__.removeQueries({ queryKey: ['structure', 'tree'] }) — симулировать cold cache miss.
  (window as Window & { __qc__?: QueryClient }).__qc__ = queryClient;
}

// Auth pages
const LoginPage = lazy(() => import('./pages/auth/LoginPage').then(m => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('./pages/auth/RegisterPage').then(m => ({ default: m.RegisterPage })));
const TwoFactorPage = lazy(() => import('./pages/auth/TwoFactorPage').then(m => ({ default: m.TwoFactorPage })));
const PendingApprovalPage = lazy(() => import('./pages/auth/PendingApprovalPage').then(m => ({ default: m.PendingApprovalPage })));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })));

// Dashboard
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const Layout = lazy(() => import('./components/layout/Layout').then(m => ({ default: m.Layout })));
const EmployeeLayout = lazy(() => import('./components/layout/EmployeeLayout').then(m => ({ default: m.EmployeeLayout })));

// Admin
const UserManagementPage = lazy(() => import('./pages/admin/UserManagementPage').then(m => ({ default: m.UserManagementPage })));
const DataAuditPage = lazy(() => import('./pages/admin/DataAuditPage').then(m => ({ default: m.DataAuditPage })));
const RoleManagementPage = lazy(() => import('./pages/admin/RoleManagementPage').then(m => ({ default: m.RoleManagementPage })));
const SystemSettingsPage = lazy(() => import('./pages/admin/SystemSettingsPage').then(m => ({ default: m.SystemSettingsPage })));
const PayslipManagePage = lazy(() => import('./pages/admin/PayslipManagePage').then(m => ({ default: m.PayslipManagePage })));
const SchedulesPage = lazy(() => import('./pages/admin/SchedulesPage').then(m => ({ default: m.SchedulesPage })));
const PatentReceiptsPage = lazy(() => import('./pages/admin/PatentReceiptsPage').then(m => ({ default: m.PatentReceiptsPage })));
const PatentReceiptsEncryptionBadge = lazy(() => import('./pages/admin/PatentReceiptsPage').then(m => ({ default: m.PatentReceiptsEncryptionBadge })));
const TimesheetTransfersAdminPage = lazy(() => import('./pages/admin/TimesheetTransfersAdminPage').then(m => ({ default: m.TimesheetTransfersAdminPage })));

// Employees & SKUD
const EmployeeCardPage = lazy(() => import('./pages/employees/EmployeeCardPage').then(m => ({ default: m.EmployeeCardPage })));
const SigurSettingsPage = lazy(() => import('./pages/skud/SigurSettingsPage').then(m => ({ default: m.SigurSettingsPage })));
const MtsLayout = lazy(() => import('./pages/mts/MtsLayout').then(m => ({ default: m.MtsLayout })));
const MtsSubscribersTab = lazy(() => import('./pages/mts/SubscribersTab').then(m => ({ default: m.SubscribersTab })));
const MtsLinkedTab = lazy(() => import('./pages/mts/LinkedTab').then(m => ({ default: m.LinkedTab })));
const MtsLocationsMapTab = lazy(() => import('./pages/mts/LocationsMapTab').then(m => ({ default: m.LocationsMapTab })));
const MtsGeofencesTab = lazy(() => import('./pages/mts/GeofencesTab').then(m => ({ default: m.GeofencesTab })));
const MtsTracksTab = lazy(() => import('./pages/mts/TracksTab').then(m => ({ default: m.TracksTab })));
const MtsTasksTab = lazy(() => import('./pages/mts/TasksTab').then(m => ({ default: m.TasksTab })));
const MtsDictionariesTab = lazy(() => import('./pages/mts/DictionariesTab').then(m => ({ default: m.DictionariesTab })));
const MtsConnectionTab = lazy(() => import('./pages/mts/ConnectionTab').then(m => ({ default: m.ConnectionTab })));
const MtsBusinessPage = lazy(() => import('./pages/mts-business/MtsBusinessPage').then(m => ({ default: m.MtsBusinessPage })));
const SigurPage = lazy(() => import('./pages/skud/SigurPage').then(m => ({ default: m.SigurPage })));
const SkudCardReaderPage = lazy(() => import('./pages/skud/SkudCardReaderPage').then(m => ({ default: m.SkudCardReaderPage })));
const ContractorPage = lazy(() => import('./pages/contractor/ContractorPage').then(m => ({ default: m.ContractorPage })));
const ContractorApprovalsPage = lazy(() => import('./pages/admin/ContractorApprovalsPage').then(m => ({ default: m.ContractorApprovalsPage })));
const SkudPresencePage = lazy(() => import('./pages/skud/presence/SkudPresencePage').then(m => ({ default: m.SkudPresencePage })));

// Timesheet
const TimesheetPage = lazy(() => import('./pages/timesheet/TimesheetPage').then(m => ({ default: m.TimesheetPage })));
const TimesheetHrPage = lazy(() => import('./pages/timesheet/TimesheetHrPage').then(m => ({ default: m.TimesheetHrPage })));
const ApprovalsPage = lazy(() => import('./pages/approvals/ApprovalsPage').then(m => ({ default: m.ApprovalsPage })));

// Discipline Analytics
const DisciplineAnalyticsPage = lazy(() => import('./pages/DisciplineAnalyticsPage').then(m => ({ default: m.DisciplineAnalyticsPage })));

// Staff Control
const StaffControlHubPage = lazy(() => import('./pages/StaffControlHubPage').then(m => ({ default: m.StaffControlHubPage })));
const HiringRequestsBoard = lazy(() => import('./components/staff/hiring/HiringRequestsBoard').then(m => ({ default: m.HiringRequestsBoard })));

// Employee portal
const EmployeeDashboardPage = lazy(() => import('./pages/employee/EmployeeDashboardPage').then(m => ({ default: m.EmployeeDashboardPage })));
const ObjectWorkerDashboardPage = lazy(() => import('./pages/employee/ObjectWorkerDashboardPage').then(m => ({ default: m.ObjectWorkerDashboardPage })));
const LeaveRequestsPage = lazy(() => import('./pages/employee/LeaveRequestsPage').then(m => ({ default: m.LeaveRequestsPage })));
const LeaveRequestDetailPage = lazy(() => import('./pages/employee/LeaveRequestDetailPage').then(m => ({ default: m.LeaveRequestDetailPage })));
const DocumentsPage = lazy(() => import('./pages/employee/DocumentsPage').then(m => ({ default: m.DocumentsPage })));
const DailyTasksPage = lazy(() => import('./pages/employee/DailyTasksPage').then(m => ({ default: m.DailyTasksPage })));
const SalaryRaisePage = lazy(() => import('./pages/employee/SalaryRaisePage').then(m => ({ default: m.SalaryRaisePage })));
const SalaryRaiseFormPage = lazy(() => import('./pages/employee/SalaryRaiseFormPage').then(m => ({ default: m.SalaryRaiseFormPage })));
const SalaryRaiseViewPage = lazy(() => import('./pages/employee/SalaryRaiseViewPage').then(m => ({ default: m.SalaryRaiseViewPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));
// Salary raise review (header/hr/admin) — используется в /salary-raise-review/:id
const SalaryRaiseReviewPage = lazy(() => import('./pages/SalaryRaiseReviewPage').then(m => ({ default: m.SalaryRaiseReviewPage })));

// Hubs (объединяющие страницы-обёртки с табами)
const LeaveRequestsHubPage = lazy(() => import('./pages/hubs/LeaveRequestsHubPage').then(m => ({ default: m.LeaveRequestsHubPage })));
const SystemAdminPage = lazy(() => import('./pages/hubs/SystemAdminPage').then(m => ({ default: m.SystemAdminPage })));

// Компонент для умного редиректа на основе должности
const PositionBasedRedirect = () => {
  const { canViewPage, employeeVariant } = useAuth();
  // Тип кабинета «Подрядчик» — всегда лендинг на /contractor.
  if (employeeVariant === 'contractor') {
    return <Navigate to="/contractor" replace />;
  }
  if (canViewPage('/dashboard')) {
    return <Navigate to="/dashboard" replace />;
  }
  if (canViewPage('/employee')) {
    return <Navigate to="/employee" replace />;
  }
  if (canViewPage('/contractor')) {
    return <Navigate to="/contractor" replace />;
  }
  // Табельщица: единственная доступная страница — «Табель».
  if (canViewPage('/timesheet')) {
    return <Navigate to="/timesheet" replace />;
  }
  return <Navigate to="/unauthorized" replace />;
};

const EmployeeHomeRoute = () => {
  const { employeeVariant, isAdmin } = useAuth();
  const [searchParams] = useSearchParams();
  const previewAsWorker = isAdmin && searchParams.get('preview') === 'worker';

  if (previewAsWorker || employeeVariant === 'object') {
    return <ObjectWorkerDashboardPage />;
  }

  if (employeeVariant === 'office' || isAdmin) {
    return (
      <EmployeeLayout title="Личный кабинет">
        <EmployeeDashboardPage />
      </EmployeeLayout>
    );
  }

  return <Navigate to="/unauthorized" replace />;
};

const AppRoutes = () => {
  const { theme, toggleTheme } = useTheme();

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Public routes */}
        <Route
          path="/login"
          element={
            <PublicRoute>
              <LoginPage />
            </PublicRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicRoute>
              <RegisterPage />
            </PublicRoute>
          }
        />
        <Route path="/verify-2fa" element={<TwoFactorPage />} />
        <Route path="/pending-approval" element={<PendingApprovalPage />} />
        <Route
          path="/forgot-password"
          element={
            <PublicRoute>
              <ForgotPasswordPage />
            </PublicRoute>
          }
        />
        <Route
          path="/reset-password"
          element={
            <PublicRoute>
              <ResetPasswordPage />
            </PublicRoute>
          }
        />

        {/* Root redirect based on position */}
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<PositionBasedRedirect />} />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/employee" />}>
          <Route
            path="/employee"
            element={<EmployeeHomeRoute />}
          />
          <Route
            path="/employee/*"
            element={
              <EmployeeLayout title="Личный кабинет">
                <NotFoundPage
                  title="Раздел не найден"
                  message="Этот раздел личного кабинета больше не существует или ещё не реализован."
                />
              </EmployeeLayout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/employee/requests" />}>
          <Route
            path="/employee/requests"
            element={
              <EmployeeLayout title="Мои заявления">
                <LeaveRequestsPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/requests/:id"
            element={
              <EmployeeLayout title="Заявление">
                <LeaveRequestDetailPage />
              </EmployeeLayout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/employee/documents" />}>
          <Route
            path="/employee/documents"
            element={
              <EmployeeLayout title="Мои документы">
                <DocumentsPage />
              </EmployeeLayout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/employee/tasks" />}>
          <Route
            path="/employee/tasks"
            element={
              <EmployeeLayout title="Мои задачи">
                <DailyTasksPage />
              </EmployeeLayout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/employee/salary-raise" />}>
          <Route
            path="/employee/salary-raise"
            element={
              <EmployeeLayout title="Повышение оклада">
                <SalaryRaisePage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/salary-raise/new"
            element={
              <EmployeeLayout title="Новая заявка на повышение">
                <SalaryRaiseFormPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/salary-raise/:id"
            element={
              <EmployeeLayout title="Заявка на повышение">
                <SalaryRaiseViewPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/salary-raise/:id/edit"
            element={
              <EmployeeLayout title="Редактирование заявки">
                <SalaryRaiseFormPage />
              </EmployeeLayout>
            }
          />
        </Route>

        {/* Доска «Заявки на поиск сотрудников» в ЛК — для рекрутеров (команда подбора),
            руководителя ОК, заявителей (manager/manager_obj) и активных ответственных.
            Тот же компонент, что и вкладка панели; доступ по существующему праву
            /staff-control/hiring (бэк инжектит его нужной аудитории). */}
        <Route element={<ProtectedRoute requiredPage="/staff-control/hiring" />}>
          <Route
            path="/employee/hiring"
            element={
              <EmployeeLayout title="Заявки на поиск сотрудников">
                <HiringRequestsBoard padded />
              </EmployeeLayout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/dashboard" />}>
          <Route
            path="/dashboard"
            element={
              <Layout title="Обзор" theme={theme} onToggleTheme={toggleTheme}>
                <DashboardPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/timesheet" />}>
          <Route
            path="/timesheet"
            element={
              <Layout title="Табель" theme={theme} onToggleTheme={toggleTheme}>
                <TimesheetPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage={['/leave-requests', '/salary-raise-review', '/leave-vacations']} />}>
          <Route
            path="/leave-requests"
            element={
              <Layout title="Заявления" theme={theme} onToggleTheme={toggleTheme}>
                <LeaveRequestsHubPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/salary-raise-review" />}>
          <Route
            path="/salary-raise-review"
            element={
              <Layout title="Повышение оклада" theme={theme} onToggleTheme={toggleTheme}>
                <SalaryRaiseReviewPage />
              </Layout>
            }
          />
          <Route
            path="/salary-raise-review/:id"
            element={
              <Layout title="Заявка на повышение" theme={theme} onToggleTheme={toggleTheme}>
                <SalaryRaiseViewPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/employees" />}>
          <Route
            path="/employees/:id"
            element={
              <Layout title="Карточка сотрудника" theme={theme} onToggleTheme={toggleTheme}>
                <EmployeeCardPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/discipline" />}>
          <Route
            path="/discipline"
            element={
              <Layout title="Аналитика дисциплины" theme={theme} onToggleTheme={toggleTheme}>
                <DisciplineAnalyticsPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/timesheet-hr" />}>
          <Route
            path="/timesheet-hr"
            element={
              <Layout title="Табели HR" theme={theme} onToggleTheme={toggleTheme}>
                <TimesheetHrPage />
              </Layout>
            }
          />
        </Route>

        {/* «Согласования» доступны и назначенным ответственным за выходные (без /timesheet-hr). */}
        <Route element={<ProtectedRoute requiredPage="/timesheet-hr" allowIfWeekendResponsible />}>
          <Route
            path="/approvals"
            element={
              <Layout title="Согласования" theme={theme} onToggleTheme={toggleTheme}>
                <ApprovalsPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/skud-settings" />}>
          <Route
            path="/sigur"
            element={
              <Layout
                title="SIGUR"
                theme={theme}
                onToggleTheme={toggleTheme}
                titleAddon={<SigurHeaderBadges />}
              >
                <SigurPage />
              </Layout>
            }
          />
        </Route>

<Route element={<ProtectedRoute requiredPage="/staff-control" />}>
          <Route
            path="/staff-control"
            element={
              <Layout title="Управление кадрами" theme={theme} onToggleTheme={toggleTheme}>
                <StaffControlHubPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage={['/admin/schedules', '/admin/schedules/templates']} />}>
          <Route
            path="/admin/schedules"
            element={
              <Layout title="Графики работы" theme={theme} onToggleTheme={toggleTheme}>
                <SchedulesPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/skud-settings" />}>
          <Route
            path="/skud-settings"
            element={
              <Layout title="Настройки СКУД" theme={theme} onToggleTheme={toggleTheme}>
                <SigurSettingsPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/mts" />}>
          <Route
            path="/mts"
            element={
              <Layout title="Мобильные сотрудники МТС" theme={theme} onToggleTheme={toggleTheme}>
                <MtsLayout />
              </Layout>
            }
          >
            <Route index element={<MtsSubscribersTab />} />
            <Route path="subscribers" element={<MtsSubscribersTab />} />
            <Route path="linked" element={<MtsLinkedTab />} />
            <Route path="map" element={<MtsLocationsMapTab />} />
            <Route path="geofences" element={<MtsGeofencesTab />} />
            <Route path="tracks" element={<MtsTracksTab />} />
            <Route path="tasks" element={<MtsTasksTab />} />
            <Route path="dictionaries" element={<MtsDictionariesTab />} />
            <Route path="connection" element={<MtsConnectionTab />} />
            {/* Legacy: /mts/objects удалена — функция переехала в карточку геозоны. */}
            <Route path="objects" element={<Navigate to="/mts/geofences" replace />} />
          </Route>
        </Route>

        <Route element={<ProtectedRoute requiredPage="/mts-business" />}>
          <Route
            path="/mts-business"
            element={
              <Layout title="МТС Бизнес — звонки" theme={theme} onToggleTheme={toggleTheme}>
                <MtsBusinessPage />
              </Layout>
            }
          />
          <Route
            path="/mts-business/subscribers"
            element={
              <Layout title="МТС Бизнес — абоненты" theme={theme} onToggleTheme={toggleTheme}>
                <MtsBusinessPage />
              </Layout>
            }
          />
          <Route
            path="/mts-business/admin"
            element={
              <Layout title="МТС Бизнес — администрирование" theme={theme} onToggleTheme={toggleTheme}>
                <MtsBusinessPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/skud-card-reader" />}>
          <Route
            path="/skud-card-reader"
            element={
              <CardReaderAgentProvider>
                <Layout
                  title="Выдача пропусков"
                  theme={theme}
                  onToggleTheme={toggleTheme}
                  titleAddon={<CardReaderHeaderBadge />}
                >
                  <SkudCardReaderPage />
                </Layout>
              </CardReaderAgentProvider>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/contractor" />}>
          <Route
            path="/contractor"
            element={
              <Layout title="Пропуска" theme={theme} onToggleTheme={toggleTheme}>
                <ContractorPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage={['/admin/contractor-approvals', '/admin/contractor-approvals/submissions']} />}>
          <Route
            path="/admin/contractor-approvals"
            element={
              <CardReaderAgentProvider>
                <Layout
                  title="Подрядчики"
                  theme={theme}
                  onToggleTheme={toggleTheme}
                  titleAddon={<CardReaderHeaderBadge />}
                >
                  <ContractorApprovalsPage />
                </Layout>
              </CardReaderAgentProvider>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/skud-presence" />}>
          <Route
            path="/skud-presence"
            element={
              <Layout title="Сотрудники на объектах" theme={theme} onToggleTheme={toggleTheme}>
                <SkudPresencePage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/admin/users" />}>
          <Route
            path="/admin/users"
            element={
              <Layout title="Управление пользователями" theme={theme} onToggleTheme={toggleTheme}>
                <UserManagementPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/admin/audit" />}>
          <Route
            path="/admin/audit"
            element={
              <Layout title="Аудит данных" theme={theme} onToggleTheme={toggleTheme}>
                <DataAuditPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/admin/roles" />}>
          <Route
            path="/admin/roles"
            element={
              <Layout title="Управление ролями" theme={theme} onToggleTheme={toggleTheme}>
                <RoleManagementPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/admin/settings" />}>
          <Route
            path="/admin/settings"
            element={
              <Layout title="Системные настройки" theme={theme} onToggleTheme={toggleTheme}>
                <SystemSettingsPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/admin/payslips" />}>
          <Route
            path="/admin/payslips"
            element={
              <Layout title="Расчётные листки" theme={theme} onToggleTheme={toggleTheme}>
                <PayslipManagePage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/admin/patent-receipts" />}>
          <Route
            path="/admin/patent-receipts"
            element={
              <Layout
                title="Чеки за патент"
                theme={theme}
                onToggleTheme={toggleTheme}
                titleAddon={<Suspense fallback={null}><PatentReceiptsEncryptionBadge /></Suspense>}
              >
                <PatentReceiptsPage />
              </Layout>
            }
          />
        </Route>

        <Route element={<ProtectedRoute requiredPage="/admin/timesheet-transfers" />}>
          <Route
            path="/admin/timesheet-transfers"
            element={
              <Layout title="Переводы и исключения табеля" theme={theme} onToggleTheme={toggleTheme}>
                <TimesheetTransfersAdminPage />
              </Layout>
            }
          />
        </Route>

        {/* Legacy-редиректы: пустые hub-обёртки убраны, ссылки ведут напрямую. */}
        <Route path="/skud" element={<Navigate to="/skud-settings" replace />} />
        <Route path="/admin/payroll" element={<Navigate to="/admin/schedules" replace />} />

        <Route element={<ProtectedRoute requiredPage={['/admin/users', '/admin/roles', '/admin/audit', '/admin/action-history', '/admin/settings', '/admin/data-api']} />}>
          <Route
            path="/admin/system"
            element={
              <Layout title="Система" theme={theme} onToggleTheme={toggleTheme}>
                <SystemAdminPage />
              </Layout>
            }
          />
        </Route>

        {/* Unauthorized page */}
        <Route
          path="/unauthorized"
          element={
            <div style={{ padding: '40px', textAlign: 'center' }}>
              <h1>Доступ запрещён</h1>
              <p>У вас недостаточно прав для просмотра этой страницы.</p>
              <a href="/">Вернуться на главную</a>
            </div>
          }
        />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
};

const App = () => {
  useEffect(() => {
    clearStaleChunkReloadFlag();
    const onError = (event: ErrorEvent) => { tryAutoReloadOnStaleChunk(event.error ?? event.message); };
    const onRejection = (event: PromiseRejectionEvent) => { tryAutoReloadOnStaleChunk(event.reason); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return (
    <Sentry.ErrorBoundary
      fallback={ErrorFallback}
      showDialog={false}
      onError={error => { tryAutoReloadOnStaleChunk(error); }}
    >
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ToastProvider>
              <ChatProvider>
                <OnlinePresenceProvider>
                  <AppRoutes />
                  <StructureRealtimeMount />
                  <ChatPanelMount />
                  <Sentry.ErrorBoundary fallback={<></>} showDialog={false}>
                    <TooltipHost />
                  </Sentry.ErrorBoundary>
                  <AppUpdateBanner />
                </OnlinePresenceProvider>
              </ChatProvider>
            </ToastProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  );
};

export default App;
