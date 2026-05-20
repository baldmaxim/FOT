import React, { useState, useCallback } from 'react';
import { auditApi, type AuditSummary, type AuditCheckResult } from '../../api/audit';
import { useToast } from '../../contexts/ToastContext';
import styles from './DataAuditPage.module.css';

// Иконки
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M23 4v6h-6M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const ChevronDownIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const AlertCircleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const AlertTriangleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const InfoIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

const CheckCircleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const ClipboardIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
  </svg>
);

// Названия проверок
const CHECK_NAMES: Record<string, string> = {
  'unassigned': 'Без назначений',
  'orphaned': 'Потерянные назначения',
  'no-salary': 'Без зарплаты',
  'expired-patents': 'Патенты',
  'no-birthdate': 'Без даты рождения',
  'duplicates': 'Дубликаты',
  'multiple-assignments': 'Несколько назначений',
};

export const DataAuditPage: React.FC = () => {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditSummary | null>(null);
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());

  const runAudit = useCallback(async () => {
    setLoading(true);
    setAuditResult(null);

    try {
      const response = await auditApi.runFullAudit();

      if (response.data) {
        setAuditResult(response.data);
        // Раскрываем проверки с критическими проблемами
        const criticalChecks = response.data.checks
          .filter(c => c.issues.some(i => i.severity === 'critical'))
          .map(c => c.check_name);
        setExpandedChecks(new Set(criticalChecks));

        if (response.data.total_issues === 0) {
          toast.success('Аудит завершён. Проблем не обнаружено!');
        } else {
          toast.info(`Аудит завершён. Найдено ${response.data.total_issues} проблем`);
        }
      } else {
        toast.error(response.error || 'Ошибка запуска аудита');
      }
    } catch {
      toast.error('Ошибка запуска аудита');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const toggleCheck = (checkName: string) => {
    setExpandedChecks(prev => {
      const newSet = new Set(prev);
      if (newSet.has(checkName)) {
        newSet.delete(checkName);
      } else {
        newSet.add(checkName);
      }
      return newSet;
    });
  };

  const getCheckIcon = (check: AuditCheckResult) => {
    if (check.issues_count === 0) return <CheckCircleIcon />;
    const hasCritical = check.issues.some(i => i.severity === 'critical');
    const hasWarning = check.issues.some(i => i.severity === 'warning');
    if (hasCritical) return <AlertCircleIcon />;
    if (hasWarning) return <AlertTriangleIcon />;
    return <InfoIcon />;
  };

  const getCheckSeverity = (check: AuditCheckResult): 'critical' | 'warning' | 'info' | 'success' => {
    if (check.issues_count === 0) return 'success';
    const hasCritical = check.issues.some(i => i.severity === 'critical');
    const hasWarning = check.issues.some(i => i.severity === 'warning');
    if (hasCritical) return 'critical';
    if (hasWarning) return 'warning';
    return 'info';
  };

  const formatDate = (isoString: string) => {
    return new Date(isoString).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1>Аудит данных</h1>
          <p>Проверка целостности и качества данных о сотрудниках</p>
        </div>

        <button
          className={styles.runButton}
          onClick={runAudit}
          disabled={loading}
        >
          {loading ? (
            <>
              <RefreshIcon />
              Проверка...
            </>
          ) : auditResult ? (
            <>
              <RefreshIcon />
              Перезапустить
            </>
          ) : (
            <>
              <PlayIcon />
              Запустить аудит
            </>
          )}
        </button>
      </div>

      {loading && (
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <span>Выполняется проверка данных...</span>
        </div>
      )}

      {!loading && !auditResult && (
        <div className={styles.empty}>
          <ClipboardIcon className={styles.emptyIcon} />
          <h3>Аудит не запущен</h3>
          <p>Нажмите кнопку "Запустить аудит" для проверки данных</p>
        </div>
      )}

      {!loading && auditResult && (
        <>
          {/* Summary */}
          <div className={styles.summary}>
            <div className={styles.summaryCard}>
              <h3>Всего сотрудников</h3>
              <div className={styles.summaryValue}>{auditResult.total_employees}</div>
            </div>
            <div className={`${styles.summaryCard} ${auditResult.total_issues === 0 ? styles.success : ''}`}>
              <h3>Всего проблем</h3>
              <div className={styles.summaryValue}>{auditResult.total_issues}</div>
            </div>
            <div className={`${styles.summaryCard} ${styles.critical}`}>
              <h3>Критичных</h3>
              <div className={styles.summaryValue}>{auditResult.critical_count}</div>
            </div>
            <div className={`${styles.summaryCard} ${styles.warning}`}>
              <h3>Предупреждений</h3>
              <div className={styles.summaryValue}>{auditResult.warning_count}</div>
            </div>
            <div className={`${styles.summaryCard} ${styles.info}`}>
              <h3>Информационных</h3>
              <div className={styles.summaryValue}>{auditResult.info_count}</div>
            </div>
          </div>

          {/* Check Results */}
          <div className={styles.checks}>
            {auditResult.checks.map(check => {
              const severity = getCheckSeverity(check);
              const isExpanded = expandedChecks.has(check.check_name);

              return (
                <div key={check.check_name} className={styles.checkCard}>
                  <div
                    className={styles.checkHeader}
                    onClick={() => toggleCheck(check.check_name)}
                  >
                    <div className={styles.checkInfo}>
                      <div className={`${styles.checkIcon} ${styles[severity]}`}>
                        {getCheckIcon(check)}
                      </div>
                      <div>
                        <h4 className={styles.checkTitle}>
                          {CHECK_NAMES[check.check_name] || check.check_name}
                        </h4>
                        <p className={styles.checkDescription}>
                          {check.check_description}
                        </p>
                      </div>
                    </div>

                    <div className={styles.checkBadge}>
                      <span className={`${styles.issueCount} ${styles[severity]}`}>
                        {check.issues_count === 0 ? 'OK' : check.issues_count}
                      </span>
                      {check.issues_count > 0 && (
                        <ChevronDownIcon
                          className={`${styles.expandIcon} ${isExpanded ? styles.expanded : ''}`}
                        />
                      )}
                    </div>
                  </div>

                  {isExpanded && check.issues_count > 0 && (
                    <div className={styles.issuesList}>
                      {check.issues.map((issue, idx) => (
                        <div key={`${issue.employee_id}-${idx}`} className={styles.issueItem}>
                          <div className={styles.issueEmployee}>
                            <span className={`${styles.severityDot} ${styles[issue.severity]}`} />
                            <span className={styles.employeeName}>{issue.full_name}</span>
                            <span className={styles.employeeId}>ID: {issue.employee_id}</span>
                          </div>
                          <span className={styles.issueDetails}>{issue.details}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {isExpanded && check.issues_count === 0 && (
                    <div className={styles.noIssues}>
                      Проблем не обнаружено
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className={styles.timestamp}>
            Последний аудит: {formatDate(auditResult.run_at)}
          </div>
        </>
      )}
    </div>
  );
};
