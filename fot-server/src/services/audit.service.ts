import { supabase } from '../config/database.js';
import type { Request } from 'express';

export const AUDIT_ACTIONS = {
  // Auth
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  LOGIN_FAILED: 'LOGIN_FAILED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  // 2FA
  '2FA_ENABLED': '2FA_ENABLED',
  '2FA_DISABLED': '2FA_DISABLED',
  '2FA_VERIFIED': '2FA_VERIFIED',
  '2FA_FAILED': '2FA_FAILED',
  // Admin — users
  USER_APPROVED: 'USER_APPROVED',
  USER_REJECTED: 'USER_REJECTED',
  USER_DELETED: 'USER_DELETED',
  EMAIL_CONFIRMED: 'EMAIL_CONFIRMED',
  POSITION_CHANGED: 'POSITION_CHANGED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  ORG_ASSIGNED: 'ORG_ASSIGNED',
  NAME_CHANGED: 'NAME_CHANGED',
  // Admin — organizations
  ORG_CREATED: 'ORG_CREATED',
  ORG_UPDATED: 'ORG_UPDATED',
  ORG_DELETED: 'ORG_DELETED',
  // Employees
  VIEW_EMPLOYEES: 'VIEW_EMPLOYEES',
  CREATE_EMPLOYEE: 'CREATE_EMPLOYEE',
  UPDATE_EMPLOYEE: 'UPDATE_EMPLOYEE',
  DELETE_EMPLOYEE: 'DELETE_EMPLOYEE',
  DELETE_ALL_EMPLOYEES: 'DELETE_ALL_EMPLOYEES',
  ARCHIVE_EMPLOYEE: 'ARCHIVE_EMPLOYEE',
  RESTORE_EMPLOYEE: 'RESTORE_EMPLOYEE',
  FIRE_EMPLOYEE: 'FIRE_EMPLOYEE',
  REHIRE_EMPLOYEE: 'REHIRE_EMPLOYEE',
  MOVE_EMPLOYEE_DEPARTMENT: 'MOVE_EMPLOYEE_DEPARTMENT',
  IMPORT_EMPLOYEES: 'IMPORT_EMPLOYEES',
  ENRICH_EMPLOYEES: 'ENRICH_EMPLOYEES',
  // Structure
  CREATE_ORG_DEPARTMENT: 'CREATE_ORG_DEPARTMENT',
  DELETE_ORG_DEPARTMENT: 'DELETE_ORG_DEPARTMENT',
  CLEAR_STRUCTURE: 'CLEAR_STRUCTURE',
  // Timesheet
  VIEW_TIMESHEET: 'VIEW_TIMESHEET',
  CREATE_TIMESHEET_ENTRY: 'CREATE_TIMESHEET_ENTRY',
  UPDATE_TIMESHEET_ENTRY: 'UPDATE_TIMESHEET_ENTRY',
  IMPORT_TIMESHEET: 'IMPORT_TIMESHEET',
  // SKUD
  VIEW_SKUD: 'VIEW_SKUD',
  IMPORT_SKUD: 'IMPORT_SKUD',
  CLEAR_SKUD: 'CLEAR_SKUD',
  CLEAN_SKUD_DUPLICATES: 'CLEAN_SKUD_DUPLICATES',
  // Sigur
  SYNC_SIGUR: 'SYNC_SIGUR',
  SYNC_SIGUR_EMPLOYEE: 'SYNC_SIGUR_EMPLOYEE',
  MATCH_EMPLOYEES: 'MATCH_EMPLOYEES',
  // Salary
  VIEW_SALARY: 'VIEW_SALARY',
  UPDATE_SALARY: 'UPDATE_SALARY',
} as const;

export type AuditAction = typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS];

interface AuditEntry {
  user_id: string;
  action: AuditAction;
  entity_type?: string;
  entity_id?: string;
  details?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
}

export const auditService = {
  /**
   * Логирует действие пользователя
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await supabase.from('audit_logs').insert({
        user_id: entry.user_id,
        action: entry.action,
        entity_type: entry.entity_type || null,
        entity_id: entry.entity_id || null,
        details: entry.details || null,
        ip_address: entry.ip_address || null,
        user_agent: entry.user_agent || null,
      });
    } catch (error) {
      // Не прерываем основную операцию из-за ошибки логирования
      console.error('Audit log failed:', error);
    }
  },

  /**
   * Создаёт аудит запись из Express Request
   */
  async logFromRequest(
    req: Request,
    userId: string,
    action: AuditAction,
    options?: {
      entityType?: string;
      entityId?: string;
      details?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.log({
      user_id: userId,
      action,
      entity_type: options?.entityType,
      entity_id: options?.entityId,
      details: options?.details,
      ip_address: req.ip || req.socket.remoteAddress,
      user_agent: req.headers['user-agent'],
    });
  },

  /**
   * Получает логи для конкретного пользователя
   */
  async getByUser(userId: string, limit = 100) {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  },

  /**
   * Получает логи по типу действия
   */
  async getByAction(action: AuditAction, limit = 100) {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .eq('action', action)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  },

  /**
   * Получает все логи (только для super_admin)
   */
  async getAll(limit = 100, offset = 0) {
    const { data, error, count } = await supabase
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return { data, count };
  },
};
