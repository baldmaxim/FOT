import type { FC, ReactNode } from 'react';
import styles from './Layout.module.css';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useMobileMenu } from '../../hooks/useMobileMenu';

interface ILayoutProps {
  children: ReactNode;
  title: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  showPeriodTabs?: boolean;
}

export const Layout: FC<ILayoutProps> = ({ children, title, theme, onToggleTheme, showPeriodTabs = false }) => {
  const { isOpen, open, close } = useMobileMenu();

  return (
    <div className={styles.app}>
      {isOpen && <div className={styles.overlay} onClick={close} />}
      <Sidebar theme={theme} isOpen={isOpen} onClose={close} />
      <main className={styles.main}>
        <Header title={title} theme={theme} onToggleTheme={onToggleTheme} onMenuOpen={open} showPeriodTabs={showPeriodTabs} />
        <div className={styles.content}>
          {children}
        </div>
      </main>
    </div>
  );
};
