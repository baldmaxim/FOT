import { supabase } from '../config/database.js';
import type { Request } from 'express';

export type AuditAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'LOGIN_FAILED'
  | '2FA_ENABLED'
  | '2FA_DISABLED'
  | '2FA_VERIFIED'
  | '2FA_FAILED'
  | 'USER_APPROVED'
  | 'USER_REJECTED'
  | 'USER_DELETED'
  | 'EMAIL_CONFIRMED'
  | 'ROLE_CHANGED'
  | 'ORG_ASSIGNED'
  | 'NAME_CHANGED'
  | 'ORG_CREATED'
  | 'ORG_UPDATED'
  | 'ORG_DELETED'
  | 'VIEW_EMPLOYEES'
  | 'CREATE_EMPLOYEE'
  | 'UPDATE_EMPLOYEE'
  | 'DELETE_EMPLOYEE'
  | 'ARCHIVE_EMPLOYEE'
  | 'IMPORT_EMPLOYEES'
  | 'VIEW_TIMESHEET'
  | 'IMPORT_TIMESHEET'
  | 'VIEW_SKUD'
  | 'IMPORT_SKUD'
  | 'CLEAR_SKUD'
  | 'VIEW_SALARY'
  | 'UPDATE_SALARY';

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
