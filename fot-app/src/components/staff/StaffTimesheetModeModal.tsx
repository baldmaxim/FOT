import { useCallback, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import {
  adminService,
  TIMESHEET_MODE_BATCH_LIMIT,
  type ITimesheetModeDepartment,
  type ITimesheetModeEmployee,
  type TimesheetExportMode,
} from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { OrgDepartmentNode } from '../../types/organization';
import type { IFlatDepartmentOption } from '../../utils/departmentUtils';
import { TimesheetModeDepartmentsList } from './TimesheetModeDepartmentsList';
import { TimesheetModeEmployeesList, type ISelectedEmployee } from './TimesheetModeEmployeesList';
import { TimesheetModeOptionsColumn } from './TimesheetModeOptionsColumn';
import type { ITimesheetModeCurrent, TimesheetModeTab } from './timesheetModeLabels';

interface IProps {
  /** Плоское дерево из StaffControlPage — уже с учётом скоупа пользователя. */
  departments: IFlatDepartmentOption[];
  /** Дерево для фильтра отдела во вкладке «Сотрудники». */
  deptTree: OrgDepartmentNode[];
  /** Отдел, выбранный на странице, — начальный фильтр вкладки «Сотрудники». */
  initialDepartmentId: string;
  onClose: () => void;
}

const TABS: ReadonlyArray<[TimesheetModeTab, string]> = [
  ['department', 'Отделы'],
  ['brigade', 'Бригады'],
  ['employee', 'Сотрудники'],
];

const EMPTY_EMPLOYEE_IDS: number[] = [];

/**
 * Окно «Режим табелирования» (миграция 249): режим отделам, бригадам и отдельным
 * сотрудникам. Правая колонка и кнопки общие; смена вкладки сбрасывает выбор.
 *
 * Личный режим сотрудника важнее режима отдела; массовая запись отделам личные режимы
 * не трогает. Права записи проверяет сервер целиком по пакету.
 */
export const StaffTimesheetModeModal: FC<IProps> = ({ departments, deptTree, initialDepartmentId, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const [tab, setTab] = useState<TimesheetModeTab>('department');
  const [selectedDepts, setSelectedDepts] = useState<Set<string>>(new Set());
  const [selectedEmployees, setSelectedEmployees] = useState<Map<number, ISelectedEmployee>>(new Map());
  const [visibleEmployeeIds, setVisibleEmployeeIds] = useState<number[]>(EMPTY_EMPLOYEE_IDS);
  // undefined — вариант справа не выбран: «Назначить» заблокирована, иначе одно случайное
  // нажатие применило бы режим без явного выбора.
  const [mode, setMode] = useState<TimesheetExportMode | undefined>(undefined);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isEmployeeTab = tab === 'employee';

  const modesQuery = useQuery({
    queryKey: ['admin-timesheet-mode-departments'],
    queryFn: () => adminService.listTimesheetModeDepartments(),
    staleTime: 30_000,
  });
  const deptModeById = useMemo(() => {
    const map = new Map<string, ITimesheetModeDepartment>();
    for (const row of modesQuery.data ?? []) map.set(row.id, row);
    return map;
  }, [modesQuery.data]);

  // В allDepts есть служебные узлы kind: 'object' и контейнеры-предки с inScope: false — их
  // нельзя ни показывать, ни выбирать. Плюс пересечение с серверным списком.
  const selectableDepts = useMemo(
    () => (isEmployeeTab ? [] : departments.filter(d => {
      if (!d.inScope || d.kind !== tab) return false;
      const row = deptModeById.get(d.id);
      if (!row) return false;
      // Подрядные организации ведут не кадры — во вкладке «Отделы» они только мешают.
      return !(tab === 'department' && row.is_contractor);
    })),
    [departments, deptModeById, tab, isEmployeeTab],
  );

  // Режимы сотрудников: видимые на странице ∪ выбранные (выбранный может быть на другой
  // странице — отметка «сейчас» у него должна работать). Пакетами по 500.
  const employeeModeIds = useMemo(() => {
    const ids = new Set<number>(visibleEmployeeIds);
    for (const id of selectedEmployees.keys()) ids.add(id);
    return [...ids].sort((a, b) => a - b);
  }, [visibleEmployeeIds, selectedEmployees]);
  const employeeModesQuery = useQuery({
    queryKey: ['admin-timesheet-modes', 'modal', employeeModeIds],
    queryFn: () => adminService.getTimesheetModesForEmployees(employeeModeIds, { includeCanEdit: true }),
    enabled: isEmployeeTab && employeeModeIds.length > 0,
    placeholderData: previous => previous,
    staleTime: 30_000,
  });
  const employeeModeById = useMemo(() => {
    const map = new Map<number, ITimesheetModeEmployee>();
    for (const row of employeeModesQuery.data ?? []) map.set(row.employee_id, row);
    return map;
  }, [employeeModesQuery.data]);

  const selectedCount = isEmployeeTab ? selectedEmployees.size : selectedDepts.size;

  const current: ITimesheetModeCurrent | null = useMemo(() => {
    if (selectedCount !== 1) return null;
    if (isEmployeeTab) {
      const [id] = selectedEmployees.keys();
      const row = employeeModeById.get(id);
      return row ? { mode: row.effective_mode, objectId: row.effective_object_id } : null;
    }
    const [id] = selectedDepts;
    const row = deptModeById.get(id);
    return row ? { mode: row.effective_mode, objectId: row.object_id } : null;
  }, [selectedCount, isEmployeeTab, selectedEmployees, employeeModeById, selectedDepts, deptModeById]);

  const personalInSelectedDepts = useMemo(() => {
    let count = 0;
    for (const id of selectedDepts) count += deptModeById.get(id)?.personal_mode_count ?? 0;
    return count;
  }, [selectedDepts, deptModeById]);

  const changeTab = (next: TimesheetModeTab): void => {
    if (next === tab) return;
    setTab(next);
    setSelectedDepts(new Set());
    setSelectedEmployees(new Map());
  };

  // Выбор построчный: в плоском списке связь «родитель — потомки» не видна.
  const toggleDept = (id: string): void => {
    setSelectedDepts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleEmployee = (id: number, employee: ISelectedEmployee): void => {
    if (!selectedEmployees.has(id) && selectedEmployees.size >= TIMESHEET_MODE_BATCH_LIMIT) {
      toast.error(`Максимум ${TIMESHEET_MODE_BATCH_LIMIT} за раз`);
      return;
    }
    setSelectedEmployees(prev => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < TIMESHEET_MODE_BATCH_LIMIT) next.set(id, employee);
      return next;
    });
  };

  const handleVisibleIdsChange = useCallback((ids: number[]) => setVisibleEmployeeIds(ids), []);

  const canApply = selectedCount > 0
    && selectedCount <= TIMESHEET_MODE_BATCH_LIMIT
    && mode !== undefined
    && !busy
    && (mode !== 'object' || Boolean(objectId));

  /** nextMode: null — сброс явного режима; выбор справа при этом не учитывается. */
  const applyMode = async (nextMode: TimesheetExportMode | null): Promise<void> => {
    if (selectedCount > TIMESHEET_MODE_BATCH_LIMIT) {
      toast.error(`Выбрано ${selectedCount} — максимум ${TIMESHEET_MODE_BATCH_LIMIT} за раз`);
      return;
    }
    const nextObjectId = nextMode === 'object' ? objectId : null;
    setBusy(true);
    try {
      let affected: number;
      if (isEmployeeTab) {
        const ids = [...selectedEmployees.keys()];
        if (ids.length === 0) return;
        ({ affected } = await adminService.bulkUpdateEmployeeTimesheetModes(ids, nextMode, nextObjectId));
      } else {
        // Страховка: только строки текущей вкладки. Скрытые поиском применяются — выбраны осознанно.
        const allowed = new Set(selectableDepts.map(d => d.id));
        const ids = [...selectedDepts].filter(id => allowed.has(id));
        if (ids.length === 0) {
          toast.error('Нет выбранных подразделений в текущей вкладке');
          return;
        }
        ({ affected } = await adminService.bulkUpdateDepartmentTimesheetModes(ids, nextMode, nextObjectId));
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-timesheet-mode-departments'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-timesheet-modes'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet'] }),
      ]);
      const what = isEmployeeTab ? 'сотрудников' : 'подразделений';
      toast.success(nextMode === null ? `Явный режим сброшен: ${what} ${affected}` : `Режим применён: ${what} ${affected}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось применить режим');
    } finally {
      setBusy(false);
    }
  };

  const handleReset = (): void => {
    const message = isEmployeeTab
      ? `Сбросить личный режим у выбранных сотрудников (${selectedCount})?\nОни вернутся к режиму своего отдела.`
      : `Сбросить явный режим у выбранных подразделений (${selectedCount})?\nОни вернутся к режиму по умолчанию — тому, что даёт назначение объектов.`;
    if (window.confirm(message)) void applyMode(null);
  };

  const hint = isEmployeeTab
    ? 'Личный режим важнее режима отдела. «Сбросить явный режим» вернёт сотрудника к режиму его отдела.'
    : personalInSelectedDepts > 0
      ? `Режим получат сотрудники подразделения без личного режима. У ${personalInSelectedDepts} из выбранных личный режим — он останется.`
      : 'Режим получат сотрудники подразделения без личного режима.';

  return (
    <div className="sc-overlay" {...dismiss}>
      <div className="sc-modal sc-modal--full" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Режим табелирования</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="sc-modal-body sc-mode-body">
          <div className="sc-obj-col">
            <div className="sc-mode-kind-filter" role="tablist" aria-label="Кому задать режим">
              {TABS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  className={`sc-btn ${tab === value ? 'apply' : 'cancel'}`}
                  onClick={() => changeTab(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {isEmployeeTab ? (
              <TimesheetModeEmployeesList
                deptTree={deptTree}
                initialDepartmentId={initialDepartmentId}
                selected={selectedEmployees}
                onToggle={toggleEmployee}
                modeById={employeeModeById}
                modesLoading={employeeModesQuery.isFetching && !employeeModesQuery.data}
                onVisibleIdsChange={handleVisibleIdsChange}
              />
            ) : (
              <TimesheetModeDepartmentsList
                key={tab}
                kind={tab}
                selectable={selectableDepts}
                modeById={deptModeById}
                loading={modesQuery.isLoading}
                selected={selectedDepts}
                onToggle={toggleDept}
              />
            )}
          </div>

          <TimesheetModeOptionsColumn
            mode={mode}
            objectId={objectId}
            onSelect={(nextMode, nextObjectId) => { setMode(nextMode); setObjectId(nextObjectId); }}
            current={current}
            hint={hint}
          />
        </div>

        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={busy}>Закрыть</button>
          <button
            className="sc-btn secondary"
            onClick={handleReset}
            disabled={busy || selectedCount === 0}
            title={isEmployeeTab ? 'Вернуть выбранных сотрудников к режиму отдела' : 'Вернуть выбранные подразделения к режиму по умолчанию'}
          >
            Сбросить явный режим
          </button>
          <button className="sc-btn apply" onClick={() => void applyMode(mode ?? null)} disabled={!canApply}>
            <Check size={15} className="sc-mode-apply-icon" />
            {busy ? 'Применение…' : `Назначить (${selectedCount})`}
          </button>
        </div>
      </div>
    </div>
  );
};
