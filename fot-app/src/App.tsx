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
import { SKUDPage } from './pages/skud/SKUDPage';
import { SKUDAnalysisPage } from './pages/skud/SKUDAnalysisPage';
import { SigurSettingsPage } from './pages/skud/SigurSettingsPage';

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
    console.log('[PositionBasedRedirect] Redirecting to /employee (worker)');
    return <Navigate to="/employee" replace />;
  }

  // Super Admin → управление пользователями (главная страница суперадмина)
  if (positionType === 'super_admin') {
    console.log('[PositionBasedRedirect] Redirecting to /admin/users (super_admin)');
    return <Navigate to="/admin/users" replace />;
  }

  // Admin → управление пользователями
  if (positionType === 'admin') {
    console.log('[PositionBasedRedirect] Redirecting to /admin/users (admin)');
    return <Navigate to="/admin/users" replace />;
  }

  // Header (Руководитель) → дашборд
  if (canAccess('header')) {
    console.log('[PositionBasedRedirect] Redirecting to /dashboard (header)');
    return <Navigate to="/dashboard" replace />;
  }

  // По умолчанию → дашборд
  console.log('[PositionBasedRedirect] Redirecting to /dashboard (default)');
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
            <Layout title="Обзор" theme={theme} onToggleTheme={toggleTheme}>
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
          path="/skud"
          element={
            <Layout title="СКУД" theme={theme} onToggleTheme={toggleTheme}>
              <SKUDPage />
            </Layout>
          }
        />
        <Route
          path="/skud-analysis"
          element={
            <Layout title="Анализ СКУД" theme={theme} onToggleTheme={toggleTheme}>
              <SKUDAnalysisPage />
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
