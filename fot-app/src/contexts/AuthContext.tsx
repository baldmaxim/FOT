/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiClient, ApiError } from '../api/client';
import type { User, UserProfile, AuthState, LoginCredentials, RegisterData, EmployeePositionType } from '../types';

interface AuthResponse {
  access_token: string;
  refresh_token: string;
  user: User;
  profile: UserProfile;
  requires_2fa?: boolean;
}

interface RegisterResponse {
  full_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
}

interface AuthContextType extends AuthState {
  token: string | null;
  login: (credentials: LoginCredentials) => Promise<{ requires2FA: boolean }>;
  verify2FA: (code: string) => Promise<void>;
  register: (data: RegisterData) => Promise<RegisterResponse | null>;
  logout: () => void;
  refreshProfile: () => Promise<void>;
  hasPosition: (positions: EmployeePositionType | EmployeePositionType[]) => boolean;
  canAccess: (requiredPosition?: EmployeePositionType) => boolean;
  // Dev mode override
  devOverride: EmployeePositionType | null;
  setDevOverride: (position: EmployeePositionType | null) => void;
  // Deprecated aliases for compatibility
  role: EmployeePositionType | null;
  hasRole: (roles: EmployeePositionType | EmployeePositionType[]) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const initialState: AuthState = {
  user: null,
  profile: null,
  isAuthenticated: false,
  isApproved: false,
  isTwoFactorEnabled: false,
  isTwoFactorVerified: false,
  positionType: null,
  loading: true,
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AuthState>(initialState);
  const [devOverride, setDevOverrideState] = useState<EmployeePositionType | null>(null);

  const setDevOverride = useCallback((position: EmployeePositionType | null) => {
    if (import.meta.env.DEV) {
      setDevOverrideState(position);
    }
  }, []);

  // Check existing session on mount
  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('access_token');
      const twoFactorVerified = localStorage.getItem('2fa_verified') === 'true';

      if (!token) {
        setState({ ...initialState, loading: false });
        return;
      }

      try {
        const response = await apiClient.get<{ user: User; profile: UserProfile; access_token?: string }>('/auth/me');
        const { user, profile } = response;

        // Обновляем токен если сервер вернул свежий (при смене org/employee_id без перелогина)
        if (response.access_token) {
          localStorage.setItem('access_token', response.access_token);
        }

        setState({
          user,
          profile,
          isAuthenticated: true,
          isApproved: profile.is_approved,
          isTwoFactorEnabled: profile.two_factor_enabled,
          isTwoFactorVerified: twoFactorVerified || !profile.two_factor_enabled,
          positionType: profile.position_type,
          loading: false,
        });
      } catch {
        // Token invalid, clear storage
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('2fa_verified');
        setState({ ...initialState, loading: false });
      }
    };

    checkAuth();
  }, []);

  const login = useCallback(async (credentials: LoginCredentials): Promise<{ requires2FA: boolean }> => {
    const response = await apiClient.post<AuthResponse>('/auth/login', credentials, { skipAuth: true });

    localStorage.setItem('access_token', response.access_token);
    localStorage.setItem('refresh_token', response.refresh_token);

    if (response.requires_2fa) {
      // Partially authenticated, needs 2FA
      // Оставляем loading: true чтобы избежать мерцания UI при переходе на страницу 2FA
      setState({
        user: response.user,
        profile: response.profile,
        isAuthenticated: true,
        isApproved: response.profile.is_approved,
        isTwoFactorEnabled: true,
        isTwoFactorVerified: false,
        positionType: response.profile.position_type,
        loading: true,
      });
      return { requires2FA: true };
    }

    // Fully authenticated
    localStorage.setItem('2fa_verified', 'true');
    setState({
      user: response.user,
      profile: response.profile,
      isAuthenticated: true,
      isApproved: response.profile.is_approved,
      isTwoFactorEnabled: response.profile.two_factor_enabled,
      isTwoFactorVerified: true,
      positionType: response.profile.position_type,
      loading: false,
    });

    return { requires2FA: false };
  }, []);

  const verify2FA = useCallback(async (code: string): Promise<void> => {
    const response = await apiClient.post<{ token: string; user: User & UserProfile }>('/auth/verify-2fa', { code });

    // Сохраняем новый токен с подтверждённой 2FA
    if (response.token) {
      localStorage.setItem('access_token', response.token);
      localStorage.setItem('refresh_token', response.token);
    }

    localStorage.setItem('2fa_verified', 'true');
    setState(prev => ({
      ...prev,
      isTwoFactorVerified: true,
      loading: false,
    }));
  }, []);

  const register = useCallback(async (data: RegisterData): Promise<RegisterResponse | null> => {
    const response = await apiClient.post<RegisterResponse>('/auth/register', data, { skipAuth: true });
    return response;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('2fa_verified');
    setState({ ...initialState, loading: false });
  }, []);

  const refreshProfile = useCallback(async (): Promise<void> => {
    try {
      const response = await apiClient.get<{ user: User; profile: UserProfile; access_token?: string }>('/auth/me');
      const { user, profile } = response;
      if (response.access_token) {
        localStorage.setItem('access_token', response.access_token);
      }
      setState(prev => ({
        ...prev,
        user,
        profile,
        isApproved: profile.is_approved,
        isTwoFactorEnabled: profile.two_factor_enabled,
        positionType: profile.position_type,
      }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        logout();
      }
    }
  }, [logout]);

  // Effective position type (dev override takes priority in DEV mode)
  const effectivePositionType = (import.meta.env.DEV && devOverride) ? devOverride : state.positionType;

  // Check if user has one of the specified positions
  const hasPosition = useCallback((positions: EmployeePositionType | EmployeePositionType[]): boolean => {
    if (!effectivePositionType) return false;
    const positionArray = Array.isArray(positions) ? positions : [positions];
    return positionArray.includes(effectivePositionType);
  }, [effectivePositionType]);

  // Deprecated alias for backward compatibility
  const hasRole = hasPosition;

  // Check if user can access based on position hierarchy
  const canAccess = useCallback((requiredPosition?: EmployeePositionType): boolean => {
    if (!state.isAuthenticated || !state.isApproved) return false;
    if (state.isTwoFactorEnabled && !state.isTwoFactorVerified) return false;
    if (!requiredPosition) return true;

    // Position hierarchy: super_admin > admin > header > worker
    const positionHierarchy: Record<EmployeePositionType, number> = {
      super_admin: 4,
      admin: 3,
      hr: 3,
      header: 2,
      worker: 1,
    };

    if (!effectivePositionType) return false;
    return positionHierarchy[effectivePositionType] >= positionHierarchy[requiredPosition];
  }, [state.isAuthenticated, state.isApproved, state.isTwoFactorEnabled, state.isTwoFactorVerified, effectivePositionType]);

  const value: AuthContextType = {
    ...state,
    positionType: effectivePositionType,
    token: localStorage.getItem('access_token'),
    login,
    verify2FA,
    register,
    logout,
    refreshProfile,
    hasPosition,
    canAccess,
    devOverride,
    setDevOverride,
    // Deprecated aliases for compatibility
    role: effectivePositionType,
    hasRole,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
