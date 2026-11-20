import { useMemo, type ReactNode } from 'react';

import { useAuth } from '../../../contexts/AuthContext';
import { EmployeeCardLink } from './EmployeeCardLink';

type CardCellRenderers<Row> = Readonly<Record<'full_name', (row: Row) => ReactNode>>;

/**
 * Ячейка «Сотрудник» таблиц «Проживания» — ссылкой на карточку (там «Реквизиты» с документами), если карточка
 * доступна (/employees); иначе undefined — ФИО обычным текстом. backPath — вкладка «Проживания» и месяц для «назад».
 */
export const useEmployeeCardCell = <Row extends { employee_id: number; full_name: string }>(
  backPath: string,
): CardCellRenderers<Row> | undefined => {
  const { isAdmin, canViewPage } = useAuth();
  const canOpen = isAdmin || canViewPage('/employees');
  return useMemo(() => (canOpen ? {
    full_name: (row: Row) => <EmployeeCardLink employeeId={row.employee_id} fullName={row.full_name} backPath={backPath} />,
  } : undefined), [canOpen, backPath]);
};
