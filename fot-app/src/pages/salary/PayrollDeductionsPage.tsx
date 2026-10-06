import { useMemo, useState, type FC } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useAuth } from '../../contexts/AuthContext';
import { payrollService, type IPayrollTermsRow } from '../../services/payrollService';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { usePayrollDeductionKinds } from '../../hooks/usePayrollDeductionKinds';
import { usePayrollStructureTree } from '../../hooks/useStructure';
import { useStaffSectionDepartments } from '../../hooks/useStaffSectionDepartments';
import { filterDepartmentTreeByIds } from '../../utils/departmentUtils';
import { SearchInput } from '../../components/ui/SearchInput';
import { AddDeductionKindModal } from '../../components/salary/AddDeductionKindModal';
import { PayrollDeductionsTable } from '../../components/salary/PayrollDeductionsTable';
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import styles from './CompensationTermsPage.module.css';

interface IPayrollDeductionsPageProps {
  /** Дата выборки условий — та же, что у «Условий оплаты». */
  date: string;
  /** Клик по строке — карточка «Подробно»; не передан — нет права на «Условия оплаты». */
  onOpenEmployee?: (row: IPayrollTermsRow) => void;
}

/**
 * «Зарплата → Расчёты»: сотрудники с удержанием по видам справочника. Удержание задаётся в карточке
 * «Подробно» (вид + сумма); здесь — поиск, подразделение и пополнение справочника («Добавить вид»).
 * Панель и таблица — как у «Условий оплаты».
 */
export const PayrollDeductionsPage: FC<IPayrollDeductionsPageProps> = ({ date, onOpenEmployee }) => {
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/salary/payments');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [adding, setAdding] = useState(false);
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const kinds = usePayrollDeductionKinds();
  // Префикс 'payroll-terms': сохранение карточки перечитывает и «Расчёты».
  const deductions = useQuery({
    queryKey: ['payroll-terms', 'deductions', date, departmentId, debouncedSearch],
    queryFn: ({ signal }) => payrollService.listDeductions({
      date,
      departmentId: departmentId || undefined,
      q: debouncedSearch || undefined,
    }, signal),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const structureTree = usePayrollStructureTree();
  const sectionDepartments = useStaffSectionDepartments();
  // Как в «Условиях оплаты»: только ветки компаний (СУ-10, СМ, Бригады); пока id не загрузились — всё дерево.
  const departments = useMemo(() => {
    const tree = structureTree.data?.departments ?? [];
    const sections = sectionDepartments.data;
    if (!sections) return tree;
    return filterDepartmentTreeByIds(tree, new Set([...sections.su10, ...sections.sm, ...sections.brigades]));
  }, [structureTree.data, sectionDepartments.data]);

  const isPending = deductions.isPending || kinds.isPending;
  const isError = (deductions.isError && !deductions.data) || (kinds.isError && !kinds.data);
  const retry = () => {
    if (deductions.isError) void deductions.refetch();
    if (kinds.isError) void kinds.refetch();
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput clearable value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." aria-label="Поиск по ФИО" />
        </div>
        <div className={styles.department}>
          <DepartmentTreeSelect
            departments={departments}
            value={departmentId}
            onChange={setDepartmentId}
            isLoading={structureTree.isPending}
            isError={structureTree.isError}
            onRetry={() => { void structureTree.refetch(); }}
          />
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primaryButton} disabled={!canEdit} onClick={() => setAdding(true)}>
            Добавить вид
          </button>
        </div>
      </div>

      {deductions.data && !deductions.data.meta.contractors_excluded && (
        <div className={styles.warning}>
          Не найден узел «Подрядные организации» — в списке могут оказаться сотрудники подрядчиков.
        </div>
      )}

      {isPending && <div className={styles.state}>Загрузка…</div>}
      {!isPending && isError && (
        <div className={styles.stateError}>
          Не удалось загрузить удержания
          <button type="button" className={styles.retryButton} onClick={retry}>Повторить</button>
        </div>
      )}

      {deductions.data && kinds.data && (
        <PayrollDeductionsTable rows={deductions.data.rows} kinds={kinds.data} onOpen={onOpenEmployee} />
      )}

      {adding && <AddDeductionKindModal onClose={() => setAdding(false)} />}
    </div>
  );
};
