import type { FC, ReactNode } from 'react';
import { EmployeeSidebar } from './EmployeeSidebar';
import styles from './EmployeeLayout.module.css';

interface IEmployeeLayoutProps {
  children: ReactNode;
  title: string;
}

export const EmployeeLayout: FC<IEmployeeLayoutProps> = ({ children, title }) => {
  return (
    <div className={styles.app}>
      <EmployeeSidebar />
      <main className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.pageTitle}>{title}</h1>
          </div>
          <div className={styles.headerRight}>
            <button className={styles.headerBtn}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
              <span className={styles.notificationIndicator}></span>
            </button>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
};
