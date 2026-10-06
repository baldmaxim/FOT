import { useCallback, useMemo, useState, type FC } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { payrollService, type IPayrollDeductionsResult, type IPayrollTermsRow } from '../../services/payrollService';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { usePayrollDeductionKinds } from '../../hooks/usePayrollDeductionKinds';
import { payrollEmployeeDeductionsKey } from '../../hooks/usePayrollEmployeeDeductions';
import { usePayrollStructureTree } from '../../hooks/useStructure';
import { useStaffSectionDepartments } from '../../hooks/useStaffSectionDepartments';
import { filterDepartmentTreeByIds } from '../../utils/departmentUtils';
import { sameDeductionKinds, toggleDeductionKind } from '../../utils/payrollDeductions';
import { SearchInput } from '../../components/ui/SearchInput';
import { DeductionKindsMenu } from '../../components/salary/DeductionKindsMenu';
import { PayrollDeductionsTable } from '../../components/salary/PayrollDeductionsTable';
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import styles from './CompensationTermsPage.module.css';

interface IPayrollDeductionsPageProps {
  /** Дата выборки условий — та же, что у «Условий оплаты». */
  date: string;
  /** Клик по строке — карточка «Подробно»; не передан — нет права на «Условия оплаты». */
  onOpenEmployee?: (row: IPayrollTermsRow) => void;
}

/** Открытый список видов: чей, у какой ячейки, что отмечено сейчас и что было при открытии. */
interface IOpenKinds {
  row: IPayrollTermsRow;
  anchor: HTMLElement;
  initial: number[];
  draft: number[];
}

/**
 * «Зарплата → Расчёты»: весь штат, у каждого в столбце «Удержание» — виды из справочника.
 * Ячейка открывает список с галочками (можно несколько и новый вид); набор сохраняется
 * при закрытии списка и сразу виден в «Удержании» карточки «Подробно».
 * Панель и таблица — как у «Условий оплаты».
 */
export const PayrollDeductionsPage: FC<IPayrollDeductionsPageProps> = ({ date, onOpenEmployee }) => {
  const { canEditPage } = useAuth();
  const { error: showError } = useToast();
  const queryClient = useQueryClient();
  const canEdit = canEditPage('/salary/payments');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [openKinds, setOpenKinds] = useState<IOpenKinds | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const kinds = usePayrollDeductionKinds();
  // Префикс 'payroll-terms': сохранение карточки перечитывает и «Расчёты».
  const listKey = useMemo(
    () => ['payroll-terms', 'deductions', 'list', date, departmentId, debouncedSearch] as const,
    [date, departmentId, debouncedSearch],
  );
  const deductions = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => payrollService.listDeductions({
      date,
      departmentId: departmentId || undefined,
      q: debouncedSearch || undefined,
    }, signal),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  /** Виды сотрудника в загруженном списке — сразу после галочек, не дожидаясь перечитывания. */
  const patchRow = useCallback((employeeId: number, kindIds: number[]) => {
    queryClient.setQueryData<IPayrollDeductionsResult>(listKey, prev => prev && {
      ...prev,
      rows: prev.rows.map(row => (row.employee_id === employeeId ? { ...row, deduction_kind_ids: kindIds } : row)),
    });
  }, [queryClient, listKey]);

  const saveMutation = useMutation({
    mutationFn: ({ employeeId, kindIds }: { employeeId: number; kindIds: number[]; previous: number[] }) =>
      payrollService.saveEmployeeDeductions(employeeId, kindIds),
    onMutate: ({ employeeId, kindIds }) => patchRow(employeeId, kindIds),
    onSuccess: (saved, { employeeId }) => {
      patchRow(employeeId, saved);
      // Карточка этого сотрудника перечитает виды.
      void queryClient.invalidateQueries({ queryKey: payrollEmployeeDeductionsKey(employeeId) });
    },
    onError: (err: Error, { employeeId, previous }) => {
      patchRow(employeeId, previous);
      showError(err.message || 'Не удалось сохранить удержания');
    },
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

  const handleOpenKinds = useCallback((row: IPayrollTermsRow, anchor: HTMLElement) => {
    const current = row.deduction_kind_ids ?? [];
    setOpenKinds({ row, anchor, initial: current, draft: current });
  }, []);

  const toggleKind = (kindId: number, checked: boolean) => {
    setOpenKinds(prev => prev && { ...prev, draft: toggleDeductionKind(prev.draft, kindId, checked, kinds.data ?? []) });
  };

  /** Закрытие списка сохраняет набор, если его меняли, и возвращает фокус на ячейку. */
  const closeKinds = () => {
    if (!openKinds) return;
    const { row, anchor, initial, draft } = openKinds;
    if (!sameDeductionKinds(initial, draft)) {
      saveMutation.mutate({ employeeId: row.employee_id, kindIds: draft, previous: initial });
    }
    if (anchor.isConnected) anchor.focus();
    setOpenKinds(null);
  };

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
        <PayrollDeductionsTable
          rows={deductions.data.rows}
          kinds={kinds.data}
          canEdit={canEdit}
          resetKey={`${departmentId}|${debouncedSearch}`}
          onOpenKinds={handleOpenKinds}
          onOpen={onOpenEmployee}
        />
      )}

      {openKinds && kinds.data && (
        <DeductionKindsMenu
          anchor={openKinds.anchor}
          subtitle={openKinds.row.full_name ?? undefined}
          kinds={kinds.data}
          selected={openKinds.draft}
          onToggle={toggleKind}
          onClose={closeKinds}
        />
      )}
    </div>
  );
};
