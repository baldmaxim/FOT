import { useEffect, type FC, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import styles from './Layout.module.css';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useMobileMenu } from '../../hooks/useMobileMenu';
import { useSwipe } from '../../hooks/useSwipe';
import { structureApi } from '../../api/structure';
import { STRUCTURE_QUERY_KEY } from '../../hooks/useStructure';
import { sortDepartmentTree } from '../../utils/departmentUtils';
import type { OrgStructureResponse } from '../../types';

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
  const queryClient = useQueryClient();

  // Префетч структуры отделов: используется почти на всех админ-страницах
  // (selectорах отделов, дашборде, управлении кадрами). Загружаем сразу после
  // mount Layout, чтобы по переходу на /timesheet или /staff-control данные уже были.
  useEffect(() => {
    void queryClient.prefetchQuery({
      queryKey: STRUCTURE_QUERY_KEY,
      queryFn: async () => {
        const res = await structureApi.getTree();
        if (res.error) throw new Error(res.error);
        const data = res.data as OrgStructureResponse;
        return { ...data, departments: sortDepartmentTree(data.departments || []) };
      },
      staleTime: 5 * 60_000,
    });
  }, [queryClient]);

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
