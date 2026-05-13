import { type FC } from 'react';
import { BuildingIcon } from '../../../components/ui/Icons';
import type { IPresenceObjectCompany } from '../../../types';
import { EmployeeRow } from './EmployeeRow';
import styles from './SkudPresencePage.module.css';

interface ICompanyGroupProps {
  company: IPresenceObjectCompany;
  isExpanded: boolean;
  onToggle: () => void;
}

export const CompanyGroup: FC<ICompanyGroupProps> = ({ company, isExpanded, onToggle }) => {
  const isClickable = company.online_count > 0;

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
        <ul className={styles.employeeList}>
          {company.employees.map(emp => <EmployeeRow key={emp.employee_id} emp={emp} />)}
        </ul>
      )}
    </div>
  );
};
