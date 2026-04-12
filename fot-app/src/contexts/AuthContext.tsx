/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiClient, ApiError, getSessionToken, setSessionToken, subscribeSessionToken } from '../api/client';
import type {
  User,
  UserProfile,
  AuthState,
  LoginCredentials,
  RegisterData,
  EmployeePositionType,
  SystemRole,
} from '../types';

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
  roles: SystemRole[];
  login: (credentials: LoginCredentials) => Promise<{ requires2FA: boolean }>;
  verify2FA: (code: string) => Promise<void>;
  register: (data: RegisterData) => Promise<RegisterResponse | null>;
  logout: () => void;
  refreshProfile: () => Promise<void>;
  hasPosition: (positions: EmployeePositionType | EmployeePositionType[]) => boolean;
  canAccess: (requiredPosition?: EmployeePositionType) => boolean;
  hasPermission: (permission: string) => boolean;
  canViewPage: (pagePath: string) => boolean;
  canEditPage: (pagePath: string) => boolean;
  getRoleLabel: (code: string) => string;
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
  const [roles, setRoles] = useState<SystemRole[]>([]);
  const [token, setToken] = useState<string | null>(getSessionToken());

  useEffect(() => subscribeSessionToken(setToken), []);

  const loadRoles = useCallback(async () => {
    try {
      const response = await apiClient.get<{ data: SystemRole[] }>('/roles');
      setRoles(response.data ?? []);
    } catch {
      // Не критично — используем пустой массив
    }
  }, []);

  // Check existing session on mount
  useEffect(() => {
    const checkAuth = async () => {
      const twoFactorVerified = sessionStorage.getItem('2fa_verified') === 'true';

      try {
        const [response] = await Promise.all([
          apiClient.get<{ user: User; profile: UserProfile; access_token?: string }>('/auth/me'),
          loadRoles(),
        ]);
        const { user, profile } = response;

        if (response.access_token) {
          setSessionToken(response.access_token);
          setToken(response.access_token);
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
        setSessionToken(null);
        setToken(null);
        sessionStorage.removeItem('2fa_verified');
        setState({ ...initialState, loading: false });
      }
    };

    checkAuth();
  }, [loadRoles]);

  const login = useCallback(async (credentials: LoginCredentials): Promise<{ requires2FA: boolean }> => {
    const response = await apiClient.post<AuthResponse>('/auth/login', credentials, { skipAuth: true });

    setSessionToken(response.access_token);
    setToken(response.access_token);

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
    sessionStorage.setItem('2fa_verified', 'true');
    await loadRoles();
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
  }, [loadRoles]);

  const verify2FA = useCallback(async (code: string): Promise<void> => {
    const response = await apiClient.post<{ token: string; user: User & UserProfile }>('/auth/verify-2fa', { code });

    if (response.token) {
      setSessionToken(response.token);
      setToken(response.token);
    }

    sessionStorage.setItem('2fa_verified', 'true');
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
    void apiClient.post('/auth/logout', undefined, { skipAuth: true }).catch(() => undefined);
    setSessionToken(null);
    setToken(null);
    sessionStorage.removeItem('2fa_verified');
    setRoles([]);
    setState({ ...initialState, loading: false });
  }, []);

  const refreshProfile = useCallback(async (): Promise<void> => {
    try {
      const response = await apiClient.get<{ user: User; profile: UserProfile; access_token?: string }>('/auth/me');
      const { user, profile } = response;
      if (response.access_token) {
        setSessionToken(response.access_token);
        setToken(response.access_token);
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

  const effectivePositionType = state.positionType;

  // Check if user has one of the specified positions
  const hasPosition = useCallback((positions: EmployeePositionType | EmployeePositionType[]): boolean => {
    if (!effectivePositionType) return false;
    const positionArray = Array.isArray(positions) ? positions : [positions];
    return positionArray.includes(effectivePositionType);
  }, [effectivePositionType]);

  // Deprecated alias for backward compatibility
  const hasRole = hasPosition;

  const getRoleLevel = useCallback((code: string): number => {
    return roles.find(r => r.code === code)?.level ?? 0;
  }, [roles]);

  const getRoleLabel = useCallback((code: string): string => {
    return roles.find(r => r.code === code)?.name ?? code;
  }, [roles]);

  const hasPermission = useCallback((permission: string): boolean => {
    if (!state.isAuthenticated || !state.isApproved) return false;
    if (state.isTwoFactorEnabled && !state.isTwoFactorVerified) return false;
    return !!state.profile?.permissions?.includes(permission);
  }, [state.isAuthenticated, state.isApproved, state.isTwoFactorEnabled, state.isTwoFactorVerified, state.profile?.permissions]);

  const canViewPage = useCallback((pagePath: string): boolean => {
    if (!state.isAuthenticated || !state.isApproved) return false;
    if (state.isTwoFactorEnabled && !state.isTwoFactorVerified) return false;
    return state.profile?.page_access?.[pagePath]?.can_view === true;
  }, [state.isAuthenticated, state.isApproved, state.isTwoFactorEnabled, state.isTwoFactorVerified, state.profile?.page_access]);

  const canEditPage = useCallback((pagePath: string): boolean => {
    if (!state.isAuthenticated || !state.isApproved) return false;
    if (state.isTwoFactorEnabled && !state.isTwoFactorVerified) return false;
    return state.profile?.page_access?.[pagePath]?.can_edit === true;
  }, [state.isAuthenticated, state.isApproved, state.isTwoFactorEnabled, state.isTwoFactorVerified, state.profile?.page_access]);

  // Check if user can access based on position hierarchy (dynamic from system_roles)
  const canAccess = useCallback((requiredPosition?: EmployeePositionType): boolean => {
    if (!state.isAuthenticated || !state.isApproved) return false;
    if (state.isTwoFactorEnabled && !state.isTwoFactorVerified) return false;
    if (!requiredPosition) return true;
    if (!effectivePositionType) return false;
    return getRoleLevel(effectivePositionType) >= getRoleLevel(requiredPosition);
  }, [state.isAuthenticated, state.isApproved, state.isTwoFactorEnabled, state.isTwoFactorVerified, effectivePositionType, getRoleLevel]);

  const value: AuthContextType = {
    ...state,
    positionType: effectivePositionType,
    token,
    roles,
    login,
    verify2FA,
    register,
    logout,
    refreshProfile,
    hasPosition,
    canAccess,
    hasPermission,
    canViewPage,
    canEditPage,
    getRoleLabel,
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
