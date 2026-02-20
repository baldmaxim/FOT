import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ProtectedRoute, PublicRoute } from './components/auth/ProtectedRoute';
import { Layout } from './components/layout/Layout';
import { EmployeeLayout } from './components/layout/EmployeeLayout';
import { useTheme } from './hooks/useTheme';

// Auth pages
import { LoginPage, RegisterPage, TwoFactorPage, PendingApprovalPage, ForgotPasswordPage, ResetPasswordPage } from './pages/auth';

// Dashboard
import { DashboardPage } from './pages/DashboardPage';

// Super Admin
import { UserManagementPage } from './pages/super-admin/UserManagementPage';
import { OrganizationsPage } from './pages/super-admin/OrganizationsPage';
import { StructurePage } from './pages/super-admin/StructurePage';
import { DataAuditPage } from './pages/super-admin/DataAuditPage';

// Tender & SKUD
import { TenderPage } from './pages/tender/TenderPage';
import { EmployeeCardPage } from './pages/employees/EmployeeCardPage';
import { SigurSettingsPage } from './pages/skud/SigurSettingsPage';
import { SigurRawDataPage } from './pages/skud/SigurRawDataPage';
import { SkudSupabasePage } from './pages/skud/SkudSupabasePage';

// Profile
import { ProfilePage } from './pages/profile';

// Employee
import { EmployeeDashboardPage } from './pages/employee';

import './App.css';

// Компонент для умного редиректа на основе должности
const PositionBasedRedirect = () => {
  const { positionType, canAccess } = useAuth();

  // DEBUG: выводим текущую роль
  console.log('[PositionBasedRedirect] positionType:', positionType);

  // Worker (Рабочий/Инженер) → личный кабинет сотрудника
  if (positionType === 'worker') {
    return <Navigate to="/employee" replace />;
  }

  // Все остальные (header, admin, super_admin) → дашборд
  return <Navigate to="/dashboard" replace />;
};

const AppRoutes = () => {
  const { theme, toggleTheme } = useTheme();

  return (
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

      {/* Employee routes (for viewers) */}
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
          path="/employee/*"
          element={
            <EmployeeLayout title="Личный кабинет">
              <div style={{ padding: '28px' }}>Страница в разработке</div>
            </EmployeeLayout>
          }
        />
      </Route>

      {/* Header/Admin routes (dashboard access) */}
      <Route element={<ProtectedRoute requiredPosition="header" />}>
        <Route
          path="/dashboard"
          element={
            <Layout title="Обзор" theme={theme} onToggleTheme={toggleTheme} showPeriodTabs>
              <DashboardPage />
            </Layout>
          }
        />
        <Route
          path="/tender"
          element={
            <Layout title="Сотрудники" theme={theme} onToggleTheme={toggleTheme}>
              <TenderPage />
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
          path="/skud-settings"
          element={
            <Layout title="Настройки СКУД" theme={theme} onToggleTheme={toggleTheme}>
              <SigurSettingsPage />
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
          path="/timesheet"
          element={
            <Layout title="Табель" theme={theme} onToggleTheme={toggleTheme}>
              <div>Timesheet Page (в разработке)</div>
            </Layout>
          }
        />
      </Route>

      {/* Profile - available for all authenticated users */}
      <Route element={<ProtectedRoute />}>
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
          path="/admin/structure"
          element={
            <Layout title="Структура Организации" theme={theme} onToggleTheme={toggleTheme}>
              <StructurePage />
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
  );
};

const App = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

export default App;
