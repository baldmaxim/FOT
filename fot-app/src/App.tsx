import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ChatProvider } from './contexts/ChatContext';
import { ChatButton } from './components/chat/ChatButton';
import { ChatSidePanel } from './components/chat/ChatSidePanel';
import { ProtectedRoute, PublicRoute } from './components/auth/ProtectedRoute';
import { Layout } from './components/layout/Layout';
import { EmployeeLayout } from './components/layout/EmployeeLayout';
import { useTheme } from './hooks/useTheme';
import { PageLoader } from './components/ui/PageLoader';
import './App.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Auth pages
const LoginPage = lazy(() => import('./pages/auth/LoginPage').then(m => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('./pages/auth/RegisterPage').then(m => ({ default: m.RegisterPage })));
const TwoFactorPage = lazy(() => import('./pages/auth/TwoFactorPage').then(m => ({ default: m.TwoFactorPage })));
const PendingApprovalPage = lazy(() => import('./pages/auth/PendingApprovalPage').then(m => ({ default: m.PendingApprovalPage })));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })));

// Dashboard
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));

// Super Admin
const UserManagementPage = lazy(() => import('./pages/super-admin/UserManagementPage').then(m => ({ default: m.UserManagementPage })));
const DataAuditPage = lazy(() => import('./pages/super-admin/DataAuditPage').then(m => ({ default: m.DataAuditPage })));
const RoleManagementPage = lazy(() => import('./pages/super-admin/RoleManagementPage').then(m => ({ default: m.RoleManagementPage })));
const SystemSettingsPage = lazy(() => import('./pages/super-admin/SystemSettingsPage').then(m => ({ default: m.SystemSettingsPage })));

// Employees & SKUD
const EmployeesPage = lazy(() => import('./pages/employees/EmployeesPage').then(m => ({ default: m.EmployeesPage })));
const EmployeeCardPage = lazy(() => import('./pages/employees/EmployeeCardPage').then(m => ({ default: m.EmployeeCardPage })));
const HeaderEmployeesPage = lazy(() => import('./pages/employees/HeaderEmployeesPage').then(m => ({ default: m.HeaderEmployeesPage })));
const SigurSettingsPage = lazy(() => import('./pages/skud/SigurSettingsPage').then(m => ({ default: m.SigurSettingsPage })));
const SigurRawDataPage = lazy(() => import('./pages/skud/SigurRawDataPage').then(m => ({ default: m.SigurRawDataPage })));
const SkudSupabasePage = lazy(() => import('./pages/skud/SkudSupabasePage').then(m => ({ default: m.SkudSupabasePage })));

// Timesheet
const TimesheetPage = lazy(() => import('./pages/timesheet/TimesheetPage').then(m => ({ default: m.TimesheetPage })));
const TimesheetReviewPage = lazy(() => import('./pages/timesheet/TimesheetReviewPage').then(m => ({ default: m.TimesheetReviewPage })));

// Discipline Analytics
const DisciplineAnalyticsPage = lazy(() => import('./pages/DisciplineAnalyticsPage').then(m => ({ default: m.DisciplineAnalyticsPage })));

// Staff Control
const StaffControlPage = lazy(() => import('./pages/StaffControlPage').then(m => ({ default: m.StaffControlPage })));

// Profile
const ProfilePage = lazy(() => import('./pages/profile/ProfilePage').then(m => ({ default: m.ProfilePage })));

// Employee portal
const EmployeeDashboardPage = lazy(() => import('./pages/employee/EmployeeDashboardPage').then(m => ({ default: m.EmployeeDashboardPage })));
const LeaveRequestsPage = lazy(() => import('./pages/employee/LeaveRequestsPage').then(m => ({ default: m.LeaveRequestsPage })));
const PayslipsPage = lazy(() => import('./pages/employee/PayslipsPage').then(m => ({ default: m.PayslipsPage })));
const PaymentsPage = lazy(() => import('./pages/employee/PaymentsPage').then(m => ({ default: m.PaymentsPage })));
const DocumentsPage = lazy(() => import('./pages/employee/DocumentsPage').then(m => ({ default: m.DocumentsPage })));
const EmployeeTimesheetPage = lazy(() => import('./pages/employee/EmployeeTimesheetPage').then(m => ({ default: m.EmployeeTimesheetPage })));
const MyHistoryPage = lazy(() => import('./pages/employee/MyHistoryPage').then(m => ({ default: m.MyHistoryPage })));
const SalaryRaisePage = lazy(() => import('./pages/employee/SalaryRaisePage').then(m => ({ default: m.SalaryRaisePage })));
const SalaryRaiseFormPage = lazy(() => import('./pages/employee/SalaryRaiseFormPage').then(m => ({ default: m.SalaryRaiseFormPage })));
const SalaryRaiseViewPage = lazy(() => import('./pages/employee/SalaryRaiseViewPage').then(m => ({ default: m.SalaryRaiseViewPage })));

// Leave requests management (header/hr)
const LeaveRequestsManagePage = lazy(() => import('./pages/LeaveRequestsManagePage').then(m => ({ default: m.LeaveRequestsManagePage })));

// Компонент для умного редиректа на основе должности
const PositionBasedRedirect = () => {
  const { positionType, canAccess } = useAuth();

  if (!positionType) {
    return <Navigate to="/employee" replace />;
  }

  // Header+ (руководитель, hr, админ, супер-админ) → дашборд
  if (canAccess('header')) {
    return <Navigate to="/dashboard" replace />;
  }

  // Worker → личный кабинет сотрудника
  return <Navigate to="/employee" replace />;
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

        {/* Employee portal routes (worker+) */}
        <Route element={<ProtectedRoute />}>
          <Route
            path="/employee"
            element={
              <EmployeeLayout title="Личный кабинет">
                <EmployeeDashboardPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/requests"
            element={
              <EmployeeLayout title="Мои заявления">
                <LeaveRequestsPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/payslips"
            element={
              <EmployeeLayout title="Расчётные листки">
                <PayslipsPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/payments"
            element={
              <EmployeeLayout title="История выплат">
                <PaymentsPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/documents"
            element={
              <EmployeeLayout title="Мои документы">
                <DocumentsPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/timesheet"
            element={
              <EmployeeLayout title="Мой табель">
                <EmployeeTimesheetPage />
              </EmployeeLayout>
            }
          />
          <Route
            path="/employee/history"
            element={
              <EmployeeLayout title="Моя история">
                <MyHistoryPage />
              </EmployeeLayout>
            }
          />
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
          <Route
            path="/employee/*"
            element={
              <EmployeeLayout title="Личный кабинет">
                <div style={{ padding: '28px' }}>Страница в разработке</div>
              </EmployeeLayout>
            }
          />
        </Route>

        {/* Header+ routes (dashboard, timesheet, leave requests) */}
        <Route element={<ProtectedRoute requiredPosition="header" />}>
          <Route
            path="/dashboard"
            element={
              <Layout title="Обзор" theme={theme} onToggleTheme={toggleTheme}>
                <DashboardPage />
              </Layout>
            }
          />
          <Route
            path="/timesheet"
            element={
              <Layout title="Табель" theme={theme} onToggleTheme={toggleTheme}>
                <TimesheetPage />
              </Layout>
            }
          />
          <Route
            path="/my-employees"
            element={
              <Layout title="Сотрудники" theme={theme} onToggleTheme={toggleTheme}>
                <HeaderEmployeesPage />
              </Layout>
            }
          />
          <Route
            path="/leave-requests"
            element={
              <Layout title="Заявления" theme={theme} onToggleTheme={toggleTheme}>
                <LeaveRequestsManagePage />
              </Layout>
            }
          />
          <Route
            path="/tender/:id"
            element={
              <Layout title="Карточка сотрудника" theme={theme} onToggleTheme={toggleTheme}>
                <EmployeeCardPage />
              </Layout>
            }
          />
          <Route
            path="/discipline"
            element={
              <Layout title="Аналитика дисциплины" theme={theme} onToggleTheme={toggleTheme}>
                <DisciplineAnalyticsPage />
              </Layout>
            }
          />
        </Route>

        {/* HR routes */}
        <Route element={<ProtectedRoute requiredPosition="hr" />}>
          <Route
            path="/timesheet-review"
            element={
              <Layout title="Проверка табелей" theme={theme} onToggleTheme={toggleTheme}>
                <TimesheetReviewPage />
              </Layout>
            }
          />
        </Route>

        {/* Admin+ routes (employees, SKUD) */}
        <Route element={<ProtectedRoute requiredPosition="admin" />}>
          <Route
            path="/tender"
            element={
              <Layout title="Сотрудники" theme={theme} onToggleTheme={toggleTheme}>
                <EmployeesPage />
              </Layout>
            }
          />
          <Route
            path="/skud-raw"
            element={
              <Layout title="Просмотр СКУД" theme={theme} onToggleTheme={toggleTheme}>
                <SigurRawDataPage />
              </Layout>
            }
          />
          <Route
            path="/skud-db"
            element={
              <Layout title="Просмотр СКУД (база)" theme={theme} onToggleTheme={toggleTheme}>
                <SkudSupabasePage />
              </Layout>
            }
          />
          <Route
            path="/staff-control"
            element={
              <Layout title="Управление кадрами" theme={theme} onToggleTheme={toggleTheme}>
                <StaffControlPage />
              </Layout>
            }
          />
        </Route>

        {/* Profile - for header+ */}
        <Route element={<ProtectedRoute requiredPosition="header" />}>
          <Route
            path="/profile"
            element={
              <Layout title="Личный кабинет" theme={theme} onToggleTheme={toggleTheme}>
                <ProfilePage />
              </Layout>
            }
          />
        </Route>

        {/* Super Admin routes */}
        <Route element={<ProtectedRoute requiredPosition="super_admin" />}>
          <Route
            path="/skud-settings"
            element={
              <Layout title="Настройки СКУД" theme={theme} onToggleTheme={toggleTheme}>
                <SigurSettingsPage />
              </Layout>
            }
          />
          <Route
            path="/admin/users"
            element={
              <Layout title="Управление пользователями" theme={theme} onToggleTheme={toggleTheme}>
                <UserManagementPage />
              </Layout>
            }
          />

          <Route
            path="/admin/audit"
            element={
              <Layout title="Аудит данных" theme={theme} onToggleTheme={toggleTheme}>
                <DataAuditPage />
              </Layout>
            }
          />
          <Route
            path="/admin/roles"
            element={
              <Layout title="Управление ролями" theme={theme} onToggleTheme={toggleTheme}>
                <RoleManagementPage />
              </Layout>
            }
          />
          <Route
            path="/admin/settings"
            element={
              <Layout title="Системные настройки" theme={theme} onToggleTheme={toggleTheme}>
                <SystemSettingsPage />
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

        {/* Catch all - redirect to home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
};

const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <ChatProvider>
              <AppRoutes />
              <ChatButton />
              <ChatSidePanel />
            </ChatProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
};

export default App;
