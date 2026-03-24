import { Response } from 'express';
import { supabase } from '../config/database.js';
import { getOrgId } from '../utils/org.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

// Типы для результатов аудита
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

export const auditController = {
  /**
   * GET /api/audit/run
   * Запуск полного аудита данных
   */
  async runFullAudit(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      const checks: AuditCheckResult[] = [];

      // Получаем общее количество сотрудников
      const { count: totalEmployees } = await supabase
        .from('employees')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('is_archived', false);

      // 1. Проверка: Сотрудники без назначений
      const unassignedCheck = await checkUnassignedEmployees(organizationId);
      checks.push(unassignedCheck);

      // 2. Проверка: Потерянные назначения (удалённые подразделения)
      const orphanedCheck = await checkOrphanedAssignments(organizationId);
      checks.push(orphanedCheck);

      // 3. Проверка: Сотрудники без зарплаты
      const noSalaryCheck = await checkEmployeesWithoutSalary(organizationId);
      checks.push(noSalaryCheck);

      // 4. Проверка: Истёкшие патенты
      const expiredPatentsCheck = await checkExpiredPatents(organizationId);
      checks.push(expiredPatentsCheck);

      // 5. Проверка: Отсутствует дата рождения
      const noBirthDateCheck = await checkMissingBirthDate(organizationId);
      checks.push(noBirthDateCheck);

      // 6. Проверка: Дублирующиеся записи
      const duplicatesCheck = await checkDuplicateEmployees(organizationId);
      checks.push(duplicatesCheck);

      // 7. Проверка: Множественные активные назначения
      const multipleAssignmentsCheck = await checkMultipleAssignments(organizationId);
      checks.push(multipleAssignmentsCheck);

      // Подсчёт итогов
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
        total_employees: totalEmployees || 0,
        total_issues: totalIssues,
        critical_count: criticalCount,
        warning_count: warningCount,
        info_count: infoCount,
        checks,
        run_at: new Date().toISOString(),
      };

      res.json({ success: true, data: summary });
    } catch (error) {
      console.error('Audit error:', error);
      res.status(500).json({ success: false, error: 'Audit failed' });
    }
  },

  /**
   * GET /api/audit/check/:checkType
   * Запуск конкретной проверки
   */
  async runSingleCheck(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const { checkType } = req.params;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      let result: AuditCheckResult;

      switch (checkType) {
        case 'unassigned':
          result = await checkUnassignedEmployees(organizationId);
          break;
        case 'orphaned':
          result = await checkOrphanedAssignments(organizationId);
          break;
        case 'no-salary':
          result = await checkEmployeesWithoutSalary(organizationId);
          break;
        case 'expired-patents':
          result = await checkExpiredPatents(organizationId);
          break;
        case 'no-birthdate':
          result = await checkMissingBirthDate(organizationId);
          break;
        case 'duplicates':
          result = await checkDuplicateEmployees(organizationId);
          break;
        case 'multiple-assignments':
          result = await checkMultipleAssignments(organizationId);
          break;
        default:
          res.status(400).json({ success: false, error: 'Unknown check type' });
          return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Audit check error:', error);
      res.status(500).json({ success: false, error: 'Check failed' });
    }
  },
};

/**
 * Проверка 1: Сотрудники без активных назначений
 */
async function checkUnassignedEmployees(organizationId: string): Promise<AuditCheckResult> {
  const issues: AuditIssue[] = [];

  // Находим сотрудников без активных назначений
  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .eq('is_archived', false);

  if (employees) {
    for (const emp of employees) {
      // Проверяем есть ли активные назначения
      const { count } = await supabase
        .from('employee_assignments')
        .select('*', { count: 'exact', head: true })
        .eq('employee_id', emp.id)
        .is('effective_to', null);

      if (!count || count === 0) {
        issues.push({
          employee_id: emp.id,
          full_name: emp.full_name || 'Неизвестно',
          issue_type: 'unassigned',
          details: 'Сотрудник не имеет активных назначений в структуре',
          severity: 'critical',
        });
      }
    }
  }

  return {
    check_name: 'unassigned',
    check_description: 'Сотрудники без назначений в структуре',
    issues_count: issues.length,
    issues,
  };
}

/**
 * Проверка 2: Назначения с удалёнными подразделениями
 */
async function checkOrphanedAssignments(organizationId: string): Promise<AuditCheckResult> {
  const issues: AuditIssue[] = [];

  // Находим назначения где все структурные ссылки NULL (но назначение активно)
  const { data: assignments } = await supabase
    .from('employee_assignments')
    .select(`
      id,
      employee_id,
      org_company_id,
      org_department_id,
      org_site_id,
      org_subdivision_id,
      employees!inner(organization_id, full_name, is_archived)
    `)
    .is('effective_to', null)
    .eq('employees.organization_id', organizationId)
    .eq('employees.is_archived', false);

  if (assignments) {
    for (const assignment of assignments) {
      const hasOrphanedRefs = (
        assignment.org_company_id === null &&
        assignment.org_department_id === null &&
        assignment.org_site_id === null &&
        assignment.org_subdivision_id === null
      );

      if (hasOrphanedRefs) {
        const emp = assignment.employees as unknown as { full_name: string };
        issues.push({
          employee_id: assignment.employee_id,
          full_name: emp.full_name || 'Неизвестно',
          issue_type: 'orphaned_assignment',
          details: 'Назначение не связано ни с одним подразделением (возможно удалено)',
          severity: 'critical',
        });
      }
    }
  }

  return {
    check_name: 'orphaned',
    check_description: 'Потерянные назначения (удалённые подразделения)',
    issues_count: issues.length,
    issues,
  };
}

/**
 * Проверка 3: Сотрудники без установленной зарплаты
 */
async function checkEmployeesWithoutSalary(organizationId: string): Promise<AuditCheckResult> {
  const issues: AuditIssue[] = [];

  // Находим сотрудников без записей в tender_salary_history
  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .eq('is_archived', false);

  if (employees) {
    for (const emp of employees) {
      const { count } = await supabase
        .from('tender_salary_history')
        .select('*', { count: 'exact', head: true })
        .eq('employee_id', emp.id);

      if (!count || count === 0) {
        issues.push({
          employee_id: emp.id,
          full_name: emp.full_name || 'Неизвестно',
          issue_type: 'no_salary',
          details: 'Зарплата не установлена',
          severity: 'warning',
        });
      }
    }
  }

  return {
    check_name: 'no-salary',
    check_description: 'Сотрудники без установленной зарплаты',
    issues_count: issues.length,
    issues,
  };
}

/**
 * Проверка 4: Истёкшие патенты
 */
async function checkExpiredPatents(organizationId: string): Promise<AuditCheckResult> {
  const issues: AuditIssue[] = [];
  const today = new Date().toISOString().split('T')[0];

  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name, patent_expiry_date')
    .eq('organization_id', organizationId)
    .eq('is_archived', false)
    .not('patent_expiry_date', 'is', null);

  if (employees) {
    for (const emp of employees) {
      const expiryDate = emp.patent_expiry_date;
      if (expiryDate && expiryDate < today) {
        issues.push({
          employee_id: emp.id,
          full_name: emp.full_name || 'Неизвестно',
          issue_type: 'expired_patent',
          details: `Патент истёк ${expiryDate}`,
          severity: 'critical',
        });
      } else if (expiryDate) {
        // Проверяем истекает ли в ближайшие 30 дней
        const expiryDateObj = new Date(expiryDate);
        const daysUntilExpiry = Math.ceil((expiryDateObj.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

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
  }

  return {
    check_name: 'expired-patents',
    check_description: 'Истёкшие и истекающие патенты',
    issues_count: issues.length,
    issues,
  };
}

/**
 * Проверка 5: Отсутствует дата рождения
 */
async function checkMissingBirthDate(organizationId: string): Promise<AuditCheckResult> {
  const issues: AuditIssue[] = [];

  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name, birth_date')
    .eq('organization_id', organizationId)
    .eq('is_archived', false);

  if (employees) {
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
  }

  return {
    check_name: 'no-birthdate',
    check_description: 'Сотрудники без даты рождения',
    issues_count: issues.length,
    issues,
  };
}

/**
 * Проверка 6: Дублирующиеся записи (по ФИО)
 */
async function checkDuplicateEmployees(organizationId: string): Promise<AuditCheckResult> {
  const issues: AuditIssue[] = [];

  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .eq('is_archived', false);

  if (employees) {
    // Группируем по расшифрованному ФИО
    const nameMap = new Map<string, { id: number; full_name: string }[]>();

    for (const emp of employees) {
      const fullName = emp.full_name || '';
      const normalizedName = fullName.toLowerCase().trim();

      if (normalizedName) {
        if (!nameMap.has(normalizedName)) {
          nameMap.set(normalizedName, []);
        }
        nameMap.get(normalizedName)!.push({ id: emp.id, full_name: fullName });
      }
    }

    // Находим дубликаты
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
  }

  return {
    check_name: 'duplicates',
    check_description: 'Возможные дубликаты сотрудников',
    issues_count: issues.length,
    issues,
  };
}

/**
 * Проверка 7: Множественные активные назначения
 */
async function checkMultipleAssignments(organizationId: string): Promise<AuditCheckResult> {
  const issues: AuditIssue[] = [];

  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .eq('is_archived', false);

  if (employees) {
    for (const emp of employees) {
      const { count } = await supabase
        .from('employee_assignments')
        .select('*', { count: 'exact', head: true })
        .eq('employee_id', emp.id)
        .is('effective_to', null);

      if (count && count > 1) {
        issues.push({
          employee_id: emp.id,
          full_name: emp.full_name || 'Неизвестно',
          issue_type: 'multiple_assignments',
          details: `Имеет ${count} активных назначений`,
          severity: 'info',
        });
      }
    }
  }

  return {
    check_name: 'multiple-assignments',
    check_description: 'Сотрудники с несколькими назначениями',
    issues_count: issues.length,
    issues,
  };
}
