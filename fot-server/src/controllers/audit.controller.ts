import { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface AuditIssue {
  employee_id: number;
  full_name: string;
  issue_type: string;
  details: string;
  severity: 'critical' | 'warning' | 'info';
}

interface AuditCheckResult {
  check_name: string;
  check_description: string;
  issues_count: number;
  issues: AuditIssue[];
}

interface AuditSummary {
  total_employees: number;
  total_issues: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  checks: AuditCheckResult[];
  run_at: string;
}

// ─── Кэш результата аудита (10 мин) ───

const AUDIT_CACHE_TTL = 10 * 60_000;
let auditCache: { data: AuditSummary; expiresAt: number } | null = null;

export const auditController = {
  async runFullAudit(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const now = Date.now();
      if (auditCache && auditCache.expiresAt > now) {
        res.json({ success: true, data: auditCache.data });
        return;
      }

      // Загружаем все данные параллельно одним батчем
      const [empResult, assignResult, salaryResult] = await Promise.all([
        supabase
          .from('employees')
          .select('id, full_name, birth_date, patent_expiry_date')
          .eq('is_archived', false),
        supabase
          .from('employee_assignments')
          .select('employee_id, org_department_id, org_site_id')
          .is('effective_to', null),
        supabase
          .from('salary_history')
          .select('employee_id'),
      ]);

      const employees = empResult.data || [];
      const assignments = assignResult.data || [];
      const salaryRecords = salaryResult.data || [];

      // Предварительные индексы
      const assignmentsByEmp = new Map<number, typeof assignments>();
      for (const a of assignments) {
        const list = assignmentsByEmp.get(a.employee_id) || [];
        list.push(a);
        assignmentsByEmp.set(a.employee_id, list);
      }

      const employeesWithSalary = new Set<number>();
      for (const s of salaryRecords) {
        employeesWithSalary.add(s.employee_id);
      }

      // Все проверки выполняются in-memory, 0 дополнительных запросов
      const checks: AuditCheckResult[] = [
        checkUnassigned(employees, assignmentsByEmp),
        checkOrphaned(employees, assignments),
        checkNoSalary(employees, employeesWithSalary),
        checkExpiredPatents(employees),
        checkMissingBirthDate(employees),
        checkDuplicates(employees),
        checkMultipleAssignments(employees, assignmentsByEmp),
      ];

      let totalIssues = 0;
      let criticalCount = 0;
      let warningCount = 0;
      let infoCount = 0;

      for (const check of checks) {
        totalIssues += check.issues_count;
        for (const issue of check.issues) {
          if (issue.severity === 'critical') criticalCount++;
          else if (issue.severity === 'warning') warningCount++;
          else infoCount++;
        }
      }

      const summary: AuditSummary = {
        total_employees: employees.length,
        total_issues: totalIssues,
        critical_count: criticalCount,
        warning_count: warningCount,
        info_count: infoCount,
        checks,
        run_at: new Date().toISOString(),
      };

      auditCache = { data: summary, expiresAt: now + AUDIT_CACHE_TTL };
      res.json({ success: true, data: summary });
    } catch (error) {
      console.error('Audit error:', error);
      res.status(500).json({ success: false, error: 'Audit failed' });
    }
  },

  async runSingleCheck(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { checkType } = req.params;

      const checkMap: Record<string, () => Promise<AuditCheckResult>> = {
        'unassigned': async () => {
          const [e, a] = await Promise.all([
            supabase.from('employees').select('id, full_name').eq('is_archived', false),
            supabase.from('employee_assignments').select('employee_id').is('effective_to', null),
          ]);
          const byEmp = new Map<number, number>();
          for (const r of a.data || []) byEmp.set(r.employee_id, (byEmp.get(r.employee_id) || 0) + 1);
          return checkUnassigned(e.data || [], byEmp as never);
        },
        'orphaned': async () => {
          const [e, a] = await Promise.all([
            supabase.from('employees').select('id, full_name').eq('is_archived', false),
            supabase.from('employee_assignments').select('employee_id, org_department_id, org_site_id').is('effective_to', null),
          ]);
          return checkOrphaned(e.data || [], a.data || []);
        },
        'no-salary': async () => {
          const [e, s] = await Promise.all([
            supabase.from('employees').select('id, full_name').eq('is_archived', false),
            supabase.from('salary_history').select('employee_id'),
          ]);
          const set = new Set((s.data || []).map(r => r.employee_id));
          return checkNoSalary(e.data || [], set);
        },
        'expired-patents': async () => {
          const { data } = await supabase.from('employees').select('id, full_name, patent_expiry_date').eq('is_archived', false).not('patent_expiry_date', 'is', null);
          return checkExpiredPatents(data || []);
        },
        'no-birthdate': async () => {
          const { data } = await supabase.from('employees').select('id, full_name, birth_date').eq('is_archived', false);
          return checkMissingBirthDate(data || []);
        },
        'duplicates': async () => {
          const { data } = await supabase.from('employees').select('id, full_name').eq('is_archived', false);
          return checkDuplicates(data || []);
        },
        'multiple-assignments': async () => {
          const [e, a] = await Promise.all([
            supabase.from('employees').select('id, full_name').eq('is_archived', false),
            supabase.from('employee_assignments').select('employee_id').is('effective_to', null),
          ]);
          const byEmp = new Map<number, number>();
          for (const r of a.data || []) byEmp.set(r.employee_id, (byEmp.get(r.employee_id) || 0) + 1);
          return checkMultipleAssignments(e.data || [], byEmp as never);
        },
      };

      const fn = checkMap[checkType];
      if (!fn) {
        res.status(400).json({ success: false, error: 'Unknown check type' });
        return;
      }

      res.json({ success: true, data: await fn() });
    } catch (error) {
      console.error('Audit check error:', error);
      res.status(500).json({ success: false, error: 'Check failed' });
    }
  },
};

// ─── Чистые функции проверок (in-memory, 0 запросов к БД) ───

type EmpRow = { id: number; full_name: string | null; birth_date?: string | null; patent_expiry_date?: string | null };

function checkUnassigned(
  employees: EmpRow[],
  assignmentsByEmp: Map<number, unknown[]>,
): AuditCheckResult {
  const issues: AuditIssue[] = [];
  for (const emp of employees) {
    const assignments = assignmentsByEmp.get(emp.id);
    if (!assignments || assignments.length === 0) {
      issues.push({
        employee_id: emp.id,
        full_name: emp.full_name || 'Неизвестно',
        issue_type: 'unassigned',
        details: 'Сотрудник не имеет активных назначений в структуре',
        severity: 'critical',
      });
    }
  }
  return {
    check_name: 'unassigned',
    check_description: 'Сотрудники без назначений в структуре',
    issues_count: issues.length,
    issues,
  };
}

function checkOrphaned(
  employees: EmpRow[],
  assignments: { employee_id: number; org_department_id: string | null; org_site_id: string | null }[],
): AuditCheckResult {
  const issues: AuditIssue[] = [];
  const empNames = new Map<number, string>();
  const activeEmpIds = new Set<number>();
  for (const e of employees) {
    empNames.set(e.id, e.full_name || 'Неизвестно');
    activeEmpIds.add(e.id);
  }

  for (const a of assignments) {
    if (!activeEmpIds.has(a.employee_id)) continue;
    if (!a.org_department_id && !a.org_site_id) {
      issues.push({
        employee_id: a.employee_id,
        full_name: empNames.get(a.employee_id) || 'Неизвестно',
        issue_type: 'orphaned_assignment',
        details: 'Назначение не связано ни с одним отделом или площадкой',
        severity: 'critical',
      });
    }
  }
  return {
    check_name: 'orphaned',
    check_description: 'Потерянные назначения (удалённые подразделения)',
    issues_count: issues.length,
    issues,
  };
}

function checkNoSalary(
  employees: EmpRow[],
  employeesWithSalary: Set<number>,
): AuditCheckResult {
  const issues: AuditIssue[] = [];
  for (const emp of employees) {
    if (!employeesWithSalary.has(emp.id)) {
      issues.push({
        employee_id: emp.id,
        full_name: emp.full_name || 'Неизвестно',
        issue_type: 'no_salary',
        details: 'Зарплата не установлена',
        severity: 'warning',
      });
    }
  }
  return {
    check_name: 'no-salary',
    check_description: 'Сотрудники без установленной зарплаты',
    issues_count: issues.length,
    issues,
  };
}

function checkExpiredPatents(employees: EmpRow[]): AuditCheckResult {
  const issues: AuditIssue[] = [];
  const today = new Date().toISOString().split('T')[0];

  for (const emp of employees) {
    const expiryDate = emp.patent_expiry_date;
    if (!expiryDate) continue;

    if (expiryDate < today) {
      issues.push({
        employee_id: emp.id,
        full_name: emp.full_name || 'Неизвестно',
        issue_type: 'expired_patent',
        details: `Патент истёк ${expiryDate}`,
        severity: 'critical',
      });
    } else {
      const daysUntilExpiry = Math.ceil((new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
        issues.push({
          employee_id: emp.id,
          full_name: emp.full_name || 'Неизвестно',
          issue_type: 'expiring_patent',
          details: `Патент истекает через ${daysUntilExpiry} дней (${expiryDate})`,
          severity: 'warning',
        });
      }
    }
  }
  return {
    check_name: 'expired-patents',
    check_description: 'Истёкшие и истекающие патенты',
    issues_count: issues.length,
    issues,
  };
}

function checkMissingBirthDate(employees: EmpRow[]): AuditCheckResult {
  const issues: AuditIssue[] = [];
  for (const emp of employees) {
    if (!emp.birth_date) {
      issues.push({
        employee_id: emp.id,
        full_name: emp.full_name || 'Неизвестно',
        issue_type: 'no_birthdate',
        details: 'Не указана дата рождения',
        severity: 'info',
      });
    }
  }
  return {
    check_name: 'no-birthdate',
    check_description: 'Сотрудники без даты рождения',
    issues_count: issues.length,
    issues,
  };
}

function checkDuplicates(employees: EmpRow[]): AuditCheckResult {
  const issues: AuditIssue[] = [];
  const nameMap = new Map<string, { id: number; full_name: string }[]>();

  for (const emp of employees) {
    const fullName = emp.full_name || '';
    const normalized = fullName.toLowerCase().trim();
    if (!normalized) continue;
    if (!nameMap.has(normalized)) nameMap.set(normalized, []);
    nameMap.get(normalized)!.push({ id: emp.id, full_name: fullName });
  }

  for (const [, duplicates] of nameMap) {
    if (duplicates.length > 1) {
      for (const dup of duplicates) {
        issues.push({
          employee_id: dup.id,
          full_name: dup.full_name,
          issue_type: 'duplicate',
          details: `Найдено ${duplicates.length} записей с таким ФИО`,
          severity: 'warning',
        });
      }
    }
  }
  return {
    check_name: 'duplicates',
    check_description: 'Возможные дубликаты сотрудников',
    issues_count: issues.length,
    issues,
  };
}

function checkMultipleAssignments(
  employees: EmpRow[],
  assignmentsByEmp: Map<number, unknown[]>,
): AuditCheckResult {
  const issues: AuditIssue[] = [];
  for (const emp of employees) {
    const assignments = assignmentsByEmp.get(emp.id);
    if (assignments && assignments.length > 1) {
      issues.push({
        employee_id: emp.id,
        full_name: emp.full_name || 'Неизвестно',
        issue_type: 'multiple_assignments',
        details: `Имеет ${assignments.length} активных назначений`,
        severity: 'info',
      });
    }
  }
  return {
    check_name: 'multiple-assignments',
    check_description: 'Сотрудники с несколькими назначениями',
    issues_count: issues.length,
    issues,
  };
}
