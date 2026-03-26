import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { EmployeePositionType } from '../../types';

interface ProtectedRouteProps {
  requiredPosition?: EmployeePositionType;
  children?: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  requiredPosition,
  children,
}) => {
  const {
    isAuthenticated,
    isApproved,
    isTwoFactorEnabled,
    isTwoFactorVerified,
    canAccess,
    loading,
  } = useAuth();
  const location = useLocation();

  // Show loading state
  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>Загрузка...</p>
      </div>
    );
  }

  // Not authenticated - redirect to login
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Not approved by admin - show pending approval page
  if (!isApproved) {
    return <Navigate to="/pending-approval" replace />;
  }

  // 2FA enabled but not verified in this session - need to enter code
  if (isTwoFactorEnabled && !isTwoFactorVerified) {
    return <Navigate to="/verify-2fa" state={{ from: location }} replace />;
  }

  // Check position access — redirect to appropriate page instead of error
  if (requiredPosition && !canAccess(requiredPosition)) {
    return <Navigate to="/" replace />;
  }

  // All checks passed
  return children ? <>{children}</> : <Outlet />;
};

// Public route - redirect to dashboard if already authenticated
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

  // Fully authenticated: approved + (2FA not required OR 2FA verified)
  if (isAuthenticated && isApproved && (!isTwoFactorEnabled || isTwoFactorVerified)) {
    const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';
    return <Navigate to={from} replace />;
  }

  return <>{children}</>;
};
