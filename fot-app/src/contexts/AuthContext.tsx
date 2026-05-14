/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import * as Sentry from '@sentry/react';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient, ApiError, getSessionToken, setSessionToken, subscribeSessionToken } from '../api/client';
import {
  dashboardKeys,
  employeesKeys,
  structureKeys,
  timesheetKeys,
} from '../api/queryKeys';
import { wsService } from '../services/websocket';
import { presenceByObjectQueryKey } from '../hooks/useEmployeeDirectory';
import type { RoleLabel } from '../services/rolesService';
import type {
  User,
  UserProfile,
  AuthState,
  LoginCredentials,
  RegisterData,
  EmployeePositionType,
  EmployeeVariant,
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
  roles: RoleLabel[];
  isAdmin: boolean;
  employeeVariant: EmployeeVariant | null;
  // true → роль настроена показывать фактические часы по СКУД
  // (hours_worked); false → текущее поведение, т.е. урезанные по графику.
  showActualHours: boolean;
  /** true → у пользователя полностью скрыто боковое меню (Sidebar). Для is_admin форсируется false. */
  hideSidebar: boolean;
  login: (credentials: LoginCredentials) => Promise<{ requires2FA: boolean }>;
  verify2FA: (code: string) => Promise<void>;
  register: (data: RegisterData) => Promise<RegisterResponse | null>;
  logout: () => void;
  refreshProfile: () => Promise<void>;
  canViewPage: (pagePath: string) => boolean;
  canEditPage: (pagePath: string) => boolean;
  getRoleLabel: (code: string) => string;
  /**
   * @deprecated Используйте canViewPage/canEditPage или isAdmin.
   * Оставлен как compat-shim для старых вызовов из timesheet/dashboard.
   */
  hasPermission: (permission: string) => boolean;
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
  const [roles, setRoles] = useState<RoleLabel[]>([]);
  const [token, setToken] = useState<string | null>(getSessionToken());
  const queryClient = useQueryClient();

  useEffect(() => subscribeSessionToken(setToken), []);

  // Грузим подписи ролей через /roles/labels — endpoint доступен любому
  // authenticated, в отличие от полного /roles, который теперь под
  // requirePageAccess('/admin/roles', 'view').
  const loadRoles = useCallback(async () => {
    try {
      const response = await apiClient.get<{ data: RoleLabel[] }>('/roles/labels');
      setRoles(response.data ?? []);
    } catch {
      // Не критично.
    }
  }, []);

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
          positionType: profile.role_code,
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
      setState({
        user: response.user,
        profile: response.profile,
        isAuthenticated: true,
        isApproved: response.profile.is_approved,
        isTwoFactorEnabled: true,
        isTwoFactorVerified: false,
        positionType: response.profile.role_code,
        loading: true,
      });
      return { requires2FA: true };
    }

    sessionStorage.setItem('2fa_verified', 'true');
    await loadRoles();
    setState({
      user: response.user,
      profile: response.profile,
      isAuthenticated: true,
      isApproved: response.profile.is_approved,
      isTwoFactorEnabled: response.profile.two_factor_enabled,
      isTwoFactorVerified: true,
      positionType: response.profile.role_code,
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
    setState(prev => ({ ...prev, isTwoFactorVerified: true, loading: false }));
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
        positionType: profile.role_code,
      }));
      // Профиль мог измениться (managed departments, show_actual_hours и т.п.) —
      // инвалидируем зависящие server-кэши, чтобы UI пересчитался без ручной перезагрузки.
      queryClient.invalidateQueries({ queryKey: timesheetKeys.page() });
      queryClient.invalidateQueries({ queryKey: timesheetKeys.hr() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        logout();
      }
    }
  }, [logout, queryClient]);

  // Sentry user context: ставим, как только знаем кто залогинен; чистим при логауте.
  useEffect(() => {
    if (state.user && state.profile) {
      Sentry.setUser({
        id: state.user.id,
        email: state.user.email,
        username: state.profile.role_code,
        segment: state.profile.is_admin ? 'admin' : (state.profile.employee_variant ?? 'user'),
      });
    } else {
      Sentry.setUser(null);
    }
  }, [state.user, state.profile]);

  // Держим актуальную ссылку, чтобы socket-подписка не пересоздавалась на каждый рефреш.
  const refreshProfileRef = useRef(refreshProfile);
  useEffect(() => { refreshProfileRef.current = refreshProfile; }, [refreshProfile]);

  // Когда админ меняет назначение отделов, бэк шлёт 'profile:access_changed' в user:${id} —
  // тихо тянем /auth/me, чтобы managed_department_ids обновились без релогина.
  // Дополнительно инвалидируем server-кэши, иначе UI продолжит показывать сотрудников
  // и структуру по уже отозванному отделу — пока пользователь сам не сменит фильтр.
  useEffect(() => {
    if (!token || !state.isAuthenticated) return;
    wsService.connect(token, 'auth-context');
    const unsubscribe = wsService.on('profile:access_changed', () => {
      void refreshProfileRef.current();
      void queryClient.invalidateQueries({ queryKey: structureKeys.all });
      void queryClient.invalidateQueries({ queryKey: employeesKeys.all });
      // Приписка сотрудника к объектам изменилась → /skud-presence должен
      // перетянуть свежий scope (вкл. is_unrestricted и assigned_object_ids).
      void queryClient.invalidateQueries({ queryKey: presenceByObjectQueryKey() });
    });
    return () => {
      unsubscribe();
      wsService.disconnect('auth-context');
    };
  }, [token, state.isAuthenticated, queryClient]);

  const getRoleLabel = useCallback((code: string): string => {
    return roles.find(r => r.code === code)?.name ?? code;
  }, [roles]);

  const isAdmin = !!state.profile?.is_admin;
  const employeeVariant = state.profile?.employee_variant ?? null;
  const showActualHours = !!state.profile?.show_actual_hours;
  // Защита от самоблокировки: админ всегда видит меню, даже если в его роли стоит флаг.
  const hideSidebar = !!state.profile?.hide_sidebar && !isAdmin;

  const ready = state.isAuthenticated && state.isApproved && (!state.isTwoFactorEnabled || state.isTwoFactorVerified);

  const canViewPage = useCallback((pagePath: string): boolean => {
    if (!ready) return false;
    if (state.profile?.is_admin) return true;
    // Defense in depth: edit без view невозможен по семантике, но если
    // в page_access вдруг просочится {can_view:false, can_edit:true} —
    // считаем доступ есть. Сервер нормализует это в access-control.service.ts.
    const perm = state.profile?.page_access?.[pagePath];
    return perm?.can_view === true || perm?.can_edit === true;
  }, [ready, state.profile]);

  const canEditPage = useCallback((pagePath: string): boolean => {
    if (!ready) return false;
    if (state.profile?.is_admin) return true;
    return state.profile?.page_access?.[pagePath]?.can_edit === true;
  }, [ready, state.profile]);

  const hasPermission = useCallback((permission: string): boolean => {
    if (!ready) return false;
    if (state.profile?.is_admin) return true;
    switch (permission) {
      case 'timesheet.workflow.submit':
        return state.profile?.page_access?.['/timesheet']?.can_edit === true;
      case 'timesheet.workflow.review':
        return state.profile?.page_access?.['/timesheet-hr']?.can_edit === true;
      case 'timesheet.workflow.monitor':
        return state.profile?.page_access?.['/timesheet-hr']?.can_view === true;
      case 'data.scope.all':
        return !!state.profile?.is_admin;
      case 'data.scope.department':
        return !state.profile?.is_admin;
      default:
        return false;
    }
  }, [ready, state.profile]);

  const value: AuthContextType = {
    ...state,
    token,
    roles,
    isAdmin,
    employeeVariant,
    showActualHours,
    hideSidebar,
    login,
    verify2FA,
    register,
    logout,
    refreshProfile,
    canViewPage,
    canEditPage,
    getRoleLabel,
    hasPermission,
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
