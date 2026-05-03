import { type FC, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, RotateCcw, UserMinus } from 'lucide-react';
import {
  timesheetService,
  type IAdminExclusionRow,
  type IAdminTransferRow,
  type IAdminTransfersFilters,
} from '../../services/timesheetService';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';
import { TransfersList, type ITransferEditPatch } from '../../components/timesheet/TransfersList';
import { ExclusionsList } from '../../components/timesheet/ExclusionsList';
import '../timesheet/TimesheetPage.css';
import styles from './TimesheetTransfersAdminPage.module.css';

type TabType = 'all' | 'transfers' | 'exclusions';

const todayIso = (): string => new Date().toISOString().slice(0, 10);

const monthAgoIso = (): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
};

export const TimesheetTransfersAdminPage: FC = () => {
  const queryClient = useQueryClient();
  const { managedDepartments } = useManagedDepartments();

  const [from, setFrom] = useState<string>(monthAgoIso());
  const [to, setTo] = useState<string>(todayIso());
  const [departmentId, setDepartmentId] = useState<string>('');
  const [employeeQuery, setEmployeeQuery] = useState<string>('');
  const [tab, setTab] = useState<TabType>('all');

  const filters: IAdminTransfersFilters = useMemo(() => ({
    from: from || undefined,
    to: to || undefined,
    department_id: departmentId || undefined,
    employee_query: employeeQuery.trim() || undefined,
  }), [from, to, departmentId, employeeQuery]);

  const listingQuery = useQuery({
    queryKey: ['admin-timesheet-transfers', filters],
    queryFn: () => timesheetService.listAllTransfersAndExclusions(filters),
    staleTime: 0,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-timesheet-transfers'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet-transfers'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet-grid'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] });
    queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
    queryClient.invalidateQueries({ queryKey: ['structure'] });
  };

  const updateTransferMutation = useMutation({
    mutationFn: (vars: { assignmentId: string; patch: ITransferEditPatch & { assignment_old_id: string } }) =>
      timesheetService.updateTransfer(vars.assignmentId, vars.patch),
    onSuccess: invalidateAll,
  });
  const deleteTransferMutation = useMutation({
    mutationFn: (assignmentId: string) => timesheetService.deleteTransfer(assignmentId),
    onSuccess: invalidateAll,
  });
  const updateExclusionMutation = useMutation({
    mutationFn: (vars: { employeeId: number; effectiveDate: string }) =>
      timesheetService.updateExclusion(vars.employeeId, vars.effectiveDate),
    onSuccess: invalidateAll,
  });
  const deleteExclusionMutation = useMutation({
    mutationFn: (employeeId: number) => timesheetService.deleteExclusion(employeeId),
    onSuccess: invalidateAll,
  });

  const isPending =
    updateTransferMutation.isPending
    || deleteTransferMutation.isPending
    || updateExclusionMutation.isPending
    || deleteExclusionMutation.isPending;

  const totalError =
    updateTransferMutation.error
    || deleteTransferMutation.error
    || updateExclusionMutation.error
    || deleteExclusionMutation.error;

  const deptOptions = useMemo(
    () => managedDepartments.map(d => ({ id: d.id, name: d.name })),
    [managedDepartments],
  );

  const transfers: IAdminTransferRow[] = listingQuery.data?.transfers ?? [];
  const exclusions: IAdminExclusionRow[] = listingQuery.data?.exclusions ?? [];

  const handleResetFilters = () => {
    setFrom(monthAgoIso());
    setTo(todayIso());
    setDepartmentId('');
    setEmployeeQuery('');
    setTab('all');
  };

  const handleConfirmDeleteTransfer = (row: IAdminTransferRow) => {
    const ok = window.confirm(
      `Полностью отменить перевод сотрудника «${row.employee_full_name}» из «${row.from_department_name}» в «${row.to_department_name}»? Сотрудник вернётся в исходный отдел.`,
    );
    if (!ok) return;
    deleteTransferMutation.mutate(row.assignment_new_id);
  };

  const handleConfirmDeleteExclusion = (row: IAdminExclusionRow) => {
    const ok = window.confirm(
      `Отменить исключение сотрудника «${row.employee_full_name}» из табеля? Он снова появится в табеле.`,
    );
    if (!ok) return;
    deleteExclusionMutation.mutate(row.employee_id);
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.subtitle}>
          Общий список по всем подразделениям. Можно править дату и отменять перевод/исключение.
        </div>
      </div>

      <div className={styles.filters}>
        <label className={styles.field}>
          <span>Период с</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>по</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </label>
        <label className={`${styles.field} ${styles.fieldGrow}`}>
          <span>Подразделение</span>
          <select value={departmentId} onChange={e => setDepartmentId(e.target.value)}>
            <option value="">— Все —</option>
            {deptOptions.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className={`${styles.field} ${styles.fieldGrow}`}>
          <span>ФИО сотрудника</span>
          <input
            type="text"
            placeholder="Поиск по ФИО"
            value={employeeQuery}
            onChange={e => setEmployeeQuery(e.target.value)}
          />
        </label>
        <div className={styles.field}>
          <span>Тип</span>
          <div className={styles.typeButtons}>
            <button
              type="button"
              className={`${styles.typeButton} ${tab === 'all' ? styles.typeButtonActive : ''}`}
              onClick={() => setTab('all')}
            >
              Все
            </button>
            <button
              type="button"
              className={`${styles.typeButton} ${tab === 'transfers' ? styles.typeButtonActive : ''}`}
              onClick={() => setTab('transfers')}
            >
              Переводы
            </button>
            <button
              type="button"
              className={`${styles.typeButton} ${tab === 'exclusions' ? styles.typeButtonActive : ''}`}
              onClick={() => setTab('exclusions')}
            >
              Исключения
            </button>
          </div>
        </div>
        <button type="button" className={styles.btnReset} onClick={handleResetFilters}>
          <RotateCcw size={14} /> Сбросить
        </button>
      </div>

      {totalError && (
        <div className={styles.error}>{(totalError as Error).message}</div>
      )}

      {listingQuery.isLoading ? (
        <div className={styles.loading}>Загрузка…</div>
      ) : listingQuery.isError ? (
        <div className={styles.error}>Не удалось загрузить список. Попробуйте обновить страницу.</div>
      ) : (
        <>
          {(tab === 'all' || tab === 'transfers') && (
            <section className={styles.section}>
              <div className={styles.sectionTitle}>
                <ArrowRightLeft size={16} /> Переведены ({transfers.length})
              </div>
              <TransfersList
                rows={transfers}
                deptOptions={deptOptions}
                isPending={isPending}
                showFromDepartment
                showPosition
                onEdit={(assignmentId, assignmentOldId, patch) => {
                  updateTransferMutation.mutate({
                    assignmentId,
                    patch: { ...patch, assignment_old_id: assignmentOldId },
                  });
                }}
                onDelete={handleConfirmDeleteTransfer}
              />
            </section>
          )}

          {(tab === 'all' || tab === 'exclusions') && (
            <section className={styles.section}>
              <div className={styles.sectionTitle}>
                <UserMinus size={16} /> Исключены ({exclusions.length})
              </div>
              <ExclusionsList
                rows={exclusions}
                isPending={isPending}
                showDepartment
                showPosition
                onEdit={(employeeId, effectiveDate) =>
                  updateExclusionMutation.mutate({ employeeId, effectiveDate })
                }
                onDelete={handleConfirmDeleteExclusion}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
};
