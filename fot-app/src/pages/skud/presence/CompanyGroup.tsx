import { type FC, useMemo, useState } from 'react';
import { BuildingIcon } from '../../../components/ui/Icons';
import type { IPresenceObjectCompany, IPresenceObjectEmployee } from '../../../types';
import { EmployeeRow } from './EmployeeRow';
import { isSyncedCompanyId } from './companyId.utils';
import styles from './SkudPresencePage.module.css';

interface ICompanyGroupProps {
  company: IPresenceObjectCompany;
  isExpanded: boolean;
  onToggle: () => void;
}

const NO_DEPT_KEY = '__no_dept__';
const collator = new Intl.Collator('ru', { sensitivity: 'base' });

interface IDeptBucket {
  key: string;
  name: string;
  employees: IPresenceObjectEmployee[];
}

/** Группирует сотрудников synced-компании по department_name. «Без отдела» (null) — всегда последняя. */
const groupByDepartment = (employees: IPresenceObjectEmployee[]): IDeptBucket[] => {
  const map = new Map<string, IDeptBucket>();
  for (const emp of employees) {
    const name = emp.department_name?.trim() || null;
    const key = name ?? NO_DEPT_KEY;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, name: name ?? 'Без отдела', employees: [] };
      map.set(key, bucket);
    }
    bucket.employees.push(emp);
  }
  const named: IDeptBucket[] = [];
  let noDept: IDeptBucket | null = null;
  for (const bucket of map.values()) {
    if (bucket.key === NO_DEPT_KEY) noDept = bucket;
    else named.push(bucket);
  }
  // Сортировка: по убыванию количества онлайн, при равенстве — по имени.
  named.sort((a, b) => {
    if (a.employees.length !== b.employees.length) return b.employees.length - a.employees.length;
    return collator.compare(a.name, b.name);
  });
  return noDept ? [...named, noDept] : named;
};

const DepartmentGroup: FC<{ bucket: IDeptBucket; isExpanded: boolean; onToggle: () => void }> = ({
  bucket,
  isExpanded,
  onToggle,
}) => (
  <div className={styles.departmentGroup}>
    <button
      type="button"
      className={`${styles.departmentHeader} ${isExpanded ? styles.departmentHeaderOpen : ''}`}
      onClick={onToggle}
    >
      <span className={styles.departmentName}>{bucket.name}</span>
      <span className={styles.departmentCount}>
        {bucket.employees.length}
        <span className={styles.companyCountLabel}>чел.</span>
      </span>
    </button>
    {isExpanded && (
      <ul className={styles.employeeList}>
        {bucket.employees.map(emp => (
          <EmployeeRow key={emp.employee_id} emp={emp} hideDepartment />
        ))}
      </ul>
    )}
  </div>
);

export const CompanyGroup: FC<ICompanyGroupProps> = ({ company, isExpanded, onToggle }) => {
  const isClickable = company.online_count > 0;
  const isSynced = isSyncedCompanyId(company.company_id);
  const departmentBuckets = useMemo(
    () => (isSynced ? groupByDepartment(company.employees) : []),
    [isSynced, company.employees],
  );
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(() => new Set());

  const toggleDept = (key: string): void => {
    setExpandedDepts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className={styles.company}>
      <button
        type="button"
        className={`${styles.companyHeader} ${isExpanded ? styles.companyHeaderOpen : ''}`}
        onClick={onToggle}
        disabled={!isClickable}
      >
        <span className={styles.companyName}>
          <BuildingIcon className={styles.companyIcon} />
          {company.company_name}
        </span>
        <span className={styles.companyCount}>
          {company.online_count}
          <span className={styles.companyCountLabel}>чел.</span>
        </span>
      </button>
      {isExpanded && company.employees.length > 0 && (
        isSynced ? (
          <div className={styles.departmentList}>
            {departmentBuckets.map(bucket => (
              <DepartmentGroup
                key={bucket.key}
                bucket={bucket}
                isExpanded={expandedDepts.has(bucket.key)}
                onToggle={() => toggleDept(bucket.key)}
              />
            ))}
          </div>
        ) : (
          <ul className={styles.employeeList}>
            {company.employees.map(emp => <EmployeeRow key={emp.employee_id} emp={emp} />)}
          </ul>
        )
      )}
    </div>
  );
};
