import { useEffect, type FC, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import styles from './Layout.module.css';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useHeaderAddonState } from './HeaderAddonContext';
import { HeaderAddonProvider } from './HeaderAddonProvider';
import { useAuth } from '../../contexts/AuthContext';
import { useMobileMenu } from '../../hooks/useMobileMenu';
import { useSidebarCollapse } from '../../hooks/useSidebarCollapse';
import { useSwipe } from '../../hooks/useSwipe';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
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
  const { isCollapsed, toggle: toggleCollapse } = useSidebarCollapse();
  const swipeHandlers = useSwipe({ isOpen, onOpen: open, onClose: close });
  const overlayHandlers = useOverlayDismiss(close);
  const queryClient = useQueryClient();
  const { addon: dynamicAddon, setAddon } = useHeaderAddonState();
  const { hideSidebar } = useAuth();

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

  const appClassName = [
    styles.app,
    isCollapsed ? styles.appCollapsed : '',
    hideSidebar ? styles.appNoSidebar : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={appClassName} {...(hideSidebar ? {} : swipeHandlers)}>
      {!hideSidebar && isOpen && <div className={styles.overlay} {...overlayHandlers} />}
      {!hideSidebar && (
        <Sidebar
          theme={theme}
          isOpen={isOpen}
          onClose={close}
          isCollapsed={isCollapsed}
          onToggleCollapse={toggleCollapse}
        />
      )}
      <main className={styles.main}>
        <Header
          title={title}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onMenuOpen={hideSidebar ? undefined : open}
          showPeriodTabs={showPeriodTabs}
          titleAddon={titleAddon ?? dynamicAddon}
        />
        <div className={styles.content}>
          <HeaderAddonProvider setAddon={setAddon}>
            {children}
          </HeaderAddonProvider>
        </div>
      </main>
    </div>
  );
};
