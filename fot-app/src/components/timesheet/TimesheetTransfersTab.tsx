import { type FC, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Loader2, UserMinus } from 'lucide-react';
import {
  timesheetService,
  type IAdminExclusionRow,
  type IAdminTransferRow,
} from '../../services/timesheetService';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';
import { TransfersList, type ITransferEditPatch } from './TransfersList';
import { ExclusionsList } from './ExclusionsList';

interface IProps {
  departmentId: string | null;
  departmentName: string;
}

export const TimesheetTransfersTab: FC<IProps> = ({ departmentId, departmentName }) => {
  const queryClient = useQueryClient();
  const { managedDepartments } = useManagedDepartments();

  const listingQuery = useQuery({
    queryKey: ['timesheet-transfers', departmentId],
    queryFn: () => timesheetService.listDepartmentTransfers(departmentId!),
    enabled: !!departmentId,
    staleTime: 0,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['timesheet-transfers'] });
    queryClient.invalidateQueries({ queryKey: ['admin-timesheet-transfers'] });
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

  const deptOptions = useMemo(
    () => managedDepartments.map(d => ({ id: d.id, name: d.name })),
    [managedDepartments],
  );

  // Адаптер: на странице руководителя в исходном эндпоинте нет поля from_department_id —
  // оно подставляется из текущего отдела (departmentId).
  const adaptedTransfers: IAdminTransferRow[] = useMemo(() => {
    const list = listingQuery.data?.transfers ?? [];
    return list.map(t => ({
      ...t,
      from_department_id: departmentId || '',
      from_department_name: departmentName || '',
      employee_position: null,
    }));
  }, [listingQuery.data?.transfers, departmentId, departmentName]);

  const adaptedExclusions: IAdminExclusionRow[] = useMemo(() => {
    const list = listingQuery.data?.exclusions ?? [];
    return list.map(e => ({
      ...e,
      department_id: departmentId,
      department_name: departmentName || '',
      employee_position: null,
    }));
  }, [listingQuery.data?.exclusions, departmentId, departmentName]);

  const totalError =
    updateTransferMutation.error
    || deleteTransferMutation.error
    || updateExclusionMutation.error
    || deleteExclusionMutation.error;

  if (!departmentId) {
    return (
      <div className="ts-transfers-tab">
        <div className="ts-transfers-empty">Выберите отдел, чтобы увидеть список переводов и исключений.</div>
      </div>
    );
  }

  const handleConfirmDeleteTransfer = (row: IAdminTransferRow) => {
    const ok = window.confirm(
      `Полностью отменить перевод сотрудника «${row.employee_full_name}» в отдел «${row.to_department_name}»? Сотрудник вернётся в исходный отдел.`,
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
    <div className="ts-transfers-tab">
      <div className="ts-transfers-tab-header">
        <div className="ts-transfers-tab-title">Переводы и исключения</div>
        <div className="ts-transfers-tab-subtitle">{departmentName || 'Отдел не выбран'}</div>
      </div>

      <div className="ts-transfers-body ts-transfers-body--inline">
        {totalError && <div className="ts-transfers-error">{(totalError as Error).message}</div>}

        {listingQuery.isLoading ? (
          <div className="ts-transfers-empty">
            <Loader2 size={16} className="ts-transfers-spinner" /> Загрузка...
          </div>
        ) : listingQuery.isError ? (
          <div className="ts-transfers-error">Не удалось загрузить список переводов</div>
        ) : (
          <>
            <section className="ts-transfers-section">
              <div className="ts-transfers-section-title">
                <ArrowRightLeft size={14} /> Переведены ({adaptedTransfers.length})
              </div>
              <TransfersList
                rows={adaptedTransfers}
                deptOptions={deptOptions}
                isPending={isPending}
                onEdit={(assignmentId, assignmentOldId, patch) => {
                  updateTransferMutation.mutate({
                    assignmentId,
                    patch: { ...patch, assignment_old_id: assignmentOldId },
                  });
                }}
                onDelete={handleConfirmDeleteTransfer}
              />
            </section>

            <section className="ts-transfers-section">
              <div className="ts-transfers-section-title">
                <UserMinus size={14} /> Исключены ({adaptedExclusions.length})
              </div>
              <ExclusionsList
                rows={adaptedExclusions}
                isPending={isPending}
                onEdit={(employeeId, effectiveDate) =>
                  updateExclusionMutation.mutate({ employeeId, effectiveDate })
                }
                onDelete={handleConfirmDeleteExclusion}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
};
