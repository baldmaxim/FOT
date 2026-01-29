import { apiClient } from './client';

export interface AuditIssue {
  employee_id: number;
  full_name: string;
  issue_type: string;
  details: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface AuditCheckResult {
  check_name: string;
  check_description: string;
  issues_count: number;
  issues: AuditIssue[];
}

export interface AuditSummary {
  total_employees: number;
  total_issues: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  checks: AuditCheckResult[];
  run_at: string;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export const auditApi = {
  /**
   * Запустить полный аудит данных
   */
  async runFullAudit(): Promise<ApiResponse<AuditSummary>> {
    try {
      return await apiClient.get<ApiResponse<AuditSummary>>('/audit/run');
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка запуска аудита',
      };
    }
  },

  /**
   * Запустить конкретную проверку
   */
  async runSingleCheck(checkType: string): Promise<ApiResponse<AuditCheckResult>> {
    try {
      return await apiClient.get<ApiResponse<AuditCheckResult>>(`/audit/check/${checkType}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка запуска проверки',
      };
    }
  },
};
