import type { FC, ReactNode } from 'react';
import styles from './Layout.module.css';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useMobileMenu } from '../../hooks/useMobileMenu';
import { useSwipe } from '../../hooks/useSwipe';

interface ILayoutProps {
  children: ReactNode;
  title: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  showPeriodTabs?: boolean;
  titleAddon?: ReactNode;
}

export const Layout: FC<ILayoutProps> = ({
  children,
  title,
  theme,
  onToggleTheme,
  showPeriodTabs = false,
  titleAddon,
}) => {
  const { isOpen, open, close } = useMobileMenu();
  const swipeHandlers = useSwipe({ isOpen, onOpen: open, onClose: close });

  return (
    <div className={styles.app} {...swipeHandlers}>
      {isOpen && <div className={styles.overlay} onClick={close} />}
      <Sidebar theme={theme} isOpen={isOpen} onClose={close} />
      <main className={styles.main}>
        <Header
          title={title}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onMenuOpen={open}
          showPeriodTabs={showPeriodTabs}
          titleAddon={titleAddon}
        />
        <div className={styles.content}>
          {children}
        </div>
      </main>
    </div>
  );
};
