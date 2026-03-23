import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ProtectedRoute, PublicRoute } from './components/auth/ProtectedRoute';
import { Layout } from './components/layout/Layout';
import { EmployeeLayout } from './components/layout/EmployeeLayout';
import { useTheme } from './hooks/useTheme';
import { PageLoader } from './components/ui/PageLoader';
import { DevRoleSwitcher } from './components/ui/DevRoleSwitcher';

import './App.css';

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
const OrganizationsPage = lazy(() => import('./pages/super-admin/OrganizationsPage').then(m => ({ default: m.OrganizationsPage })));
const ManagePage = lazy(() => import('./pages/super-admin/ManagePage').then(m => ({ default: m.ManagePage })));
const DataAuditPage = lazy(() => import('./pages/super-admin/DataAuditPage').then(m => ({ default: m.DataAuditPage })));

// Employees & SKUD
const EmployeesPage = lazy(() => import('./pages/employees/EmployeesPage').then(m => ({ default: m.EmployeesPage })));
const EmployeeCardPage = lazy(() => import('./pages/employees/EmployeeCardPage').then(m => ({ default: m.EmployeeCardPage })));
const SigurSettingsPage = lazy(() => import('./pages/skud/SigurSettingsPage').then(m => ({ default: m.SigurSettingsPage })));
const SigurRawDataPage = lazy(() => import('./pages/skud/SigurRawDataPage').then(m => ({ default: m.SigurRawDataPage })));
const SkudSupabasePage = lazy(() => import('./pages/skud/SkudSupabasePage').then(m => ({ default: m.SkudSupabasePage })));

// Timesheet
const TimesheetPage = lazy(() => import('./pages/timesheet/TimesheetPage').then(m => ({ default: m.TimesheetPage })));

// Discipline Analytics
const DisciplineAnalyticsPage = lazy(() => import('./pages/DisciplineAnalyticsPage').then(m => ({ default: m.DisciplineAnalyticsPage })));

// Profile
const ProfilePage = lazy(() => import('./pages/profile/ProfilePage').then(m => ({ default: m.ProfilePage })));

// Employee
const EmployeeDashboardPage = lazy(() => import('./pages/employee/EmployeeDashboardPage').then(m => ({ default: m.EmployeeDashboardPage })));
const ChatPage = lazy(() => import('./pages/employee/ChatPage').then(m => ({ default: m.ChatPage })));

// Компонент для умного редиректа на основе должности
const PositionBasedRedirect = () => {
  const { positionType, canAccess } = useAuth();

  // Если роль ещё не загружена — не редиректим в никуда
  if (!positionType) {
    return <Navigate to="/employee" replace />;
  }

  // Header+ (руководитель, админ, супер-админ) → дашборд
  if (canAccess('header')) {
    return <Navigate to="/dashboard" replace />;
  }

  // Worker (Рабочий/Инженер) → личный кабинет сотрудника
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

        {/* Employee routes (for workers) */}
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
            path="/employee/chat"
            element={
              <EmployeeLayout title="Сообщения">
                <ChatPage />
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

        {/* Header+ routes (dashboard, timesheet) */}
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
            path="/admin/structure"
            element={
              <Layout title="Управление" theme={theme} onToggleTheme={toggleTheme}>
                <ManagePage />
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
            path="/tender/:id"
            element={
              <Layout title="Карточка сотрудника" theme={theme} onToggleTheme={toggleTheme}>
                <EmployeeCardPage />
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
            path="/discipline"
            element={
              <Layout title="Аналитика дисциплины" theme={theme} onToggleTheme={toggleTheme}>
                <DisciplineAnalyticsPage />
              </Layout>
            }
          />
        </Route>

        {/* Profile - for header+ uses Layout, workers redirect to /employee */}
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
            path="/admin/organizations"
            element={
              <Layout title="Управление организациями" theme={theme} onToggleTheme={toggleTheme}>
                <OrganizationsPage />
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
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
          {import.meta.env.DEV && <DevRoleSwitcher />}
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

export default App;
