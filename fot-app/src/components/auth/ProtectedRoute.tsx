import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

interface ProtectedRouteProps {
  requiredPage?: string | string[];
  children?: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  requiredPage,
  children,
}) => {
  const {
    isAuthenticated,
    isApproved,
    isTwoFactorEnabled,
    isTwoFactorVerified,
    canViewPage,
    loading,
    employeeVariant,
    isAdmin,
  } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>Загрузка...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!isApproved) {
    return <Navigate to="/pending-approval" replace />;
  }

  if (isTwoFactorEnabled && !isTwoFactorVerified) {
    return <Navigate to="/verify-2fa" state={{ from: location }} replace />;
  }

  // Object-worker (рабочий на объекте) работает только через минималистичный
  // ObjectWorkerDashboardPage (/employee). Любые nested /employee/* страницы
  // ему недоступны — даже если в role_page_access случайно дали view.
  if (
    employeeVariant === 'object'
    && !isAdmin
    && location.pathname !== '/employee'
    && location.pathname.startsWith('/employee/')
  ) {
    return <Navigate to="/employee" replace />;
  }

  if (requiredPage) {
    const pageList = Array.isArray(requiredPage) ? requiredPage : [requiredPage];
    if (!pageList.some(page => canViewPage(page))) {
      if (location.pathname.startsWith('/employee') && canViewPage('/employee')) {
        return <Navigate to="/employee" replace />;
      }
      return <Navigate to="/unauthorized" replace />;
    }
  }

  return children ? <>{children}</> : <Outlet />;
};

interface PublicRouteProps {
  children: React.ReactNode;
}

export const PublicRoute: React.FC<PublicRouteProps> = ({ children }) => {
  const { isAuthenticated, isApproved, isTwoFactorEnabled, isTwoFactorVerified, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>Загрузка...</p>
      </div>
    );
  }

  if (isAuthenticated && isApproved && (!isTwoFactorEnabled || isTwoFactorVerified)) {
    const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';
    return <Navigate to={from} replace />;
  }

  return <>{children}</>;
};
