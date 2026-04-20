import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  adminService,
  type ManagerDepartmentImportGroupPreview,
  type ManagerDepartmentImportPreview,
} from '../../services/adminService';
import { employeeService } from '../../services/employeeService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import type { Employee } from '../../types';
import type { IUserFromApi } from './AllUsersTab';
import { getTreeFlatDepartments } from '../../utils/departmentUtils';
import styles from '../../pages/super-admin/SuperAdmin.module.css';

interface IDepartmentAccessImportTabProps {
  allUsers: IUserFromApi[];
  onReload: () => Promise<void>;
}

interface IEmployeeOption {
  id: number;
  label: string;
  full_name: string;
  hasPortalAccount: boolean;
}

const MAX_MANUAL_DEPARTMENT_RESULTS = 8;
const IMPORT_DRAFT_STORAGE_KEY = 'manager-department-import-draft-v1';

interface IImportDraftState {
  groupAssignments: Record<string, string>;
  brigadeDepartmentAssignments: Record<string, string>;
}

const buildGroupLabel = (group: ManagerDepartmentImportGroupPreview): string => (
  group.section_name ? `${group.section_name} / ${group.manager_name}` : group.manager_name
);

const buildBrigadeKey = (
  group: ManagerDepartmentImportGroupPreview,
  brigade: ManagerDepartmentImportGroupPreview['brigades'][number],
): string => `${group.group_key}::${normalizeText(brigade.brigade_name)}`;

const normalizeText = (value: string | null | undefined): string => (
  String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/ё/giu, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
);

const loadImportDraftState = (): IImportDraftState => {
  if (typeof window === 'undefined') {
    return { groupAssignments: {}, brigadeDepartmentAssignments: {} };
  }

  try {
    const raw = window.localStorage.getItem(IMPORT_DRAFT_STORAGE_KEY);
    if (!raw) {
      return { groupAssignments: {}, brigadeDepartmentAssignments: {} };
    }

    const parsed = JSON.parse(raw) as Partial<IImportDraftState>;
    return {
      groupAssignments: parsed.groupAssignments && typeof parsed.groupAssignments === 'object'
        ? Object.fromEntries(Object.entries(parsed.groupAssignments).filter(([, value]) => typeof value === 'string'))
        : {},
      brigadeDepartmentAssignments: parsed.brigadeDepartmentAssignments && typeof parsed.brigadeDepartmentAssignments === 'object'
        ? Object.fromEntries(Object.entries(parsed.brigadeDepartmentAssignments).filter(([, value]) => typeof value === 'string'))
        : {},
    };
  } catch {
    return { groupAssignments: {}, brigadeDepartmentAssignments: {} };
  }
};

const saveImportDraftState = (draft: IImportDraftState): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(IMPORT_DRAFT_STORAGE_KEY, JSON.stringify(draft));
};

const buildAutoAssignments = (
  groups: ManagerDepartmentImportGroupPreview[],
  employees: Employee[],
): Record<string, string> => {
  const employeesById = new Map(employees.map(employee => [employee.id, employee]));
  const employeesByName = employees.reduce<Map<string, Employee[]>>((acc, employee) => {
    const key = normalizeText(employee.full_name);
    const current = acc.get(key) || [];
    current.push(employee);
    acc.set(key, current);
    return acc;
  }, new Map());

  return groups.reduce<Record<string, string>>((acc, group) => {
    if (group.saved_employee_id && employeesById.has(group.saved_employee_id)) {
      acc[group.group_key] = String(group.saved_employee_id);
      return acc;
    }

    const matches = employeesByName.get(normalizeText(group.manager_name)) || [];
    if (matches.length === 1) {
      acc[group.group_key] = String(matches[0].id);
    }
    return acc;
  }, {});
};

export const DepartmentAccessImportTab: FC<IDepartmentAccessImportTabProps> = ({ allUsers, onReload }) => {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const draftStateRef = useRef<IImportDraftState>(loadImportDraftState());
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ManagerDepartmentImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [assignmentsByGroup, setAssignmentsByGroup] = useState<Record<string, string>>({});
  const [manualDepartmentQueryByBrigade, setManualDepartmentQueryByBrigade] = useState<Record<string, string>>({});
  const [manualDepartmentSelectionByBrigade, setManualDepartmentSelectionByBrigade] = useState<Record<string, string>>({});
  const employeesQuery = useQuery<Employee[]>({
    queryKey: ['admin-users', 'department-import', 'employees'],
    queryFn: () => employeeService.getAll({ view: 'list' }),
    staleTime: 60_000,
  });
  const structureQuery = useStructureTree();

  const registeredUserByEmployeeId = useMemo(() => (
    new Map(
      allUsers
        .filter(user => user.employee_id)
        .map(user => [String(user.employee_id), user]),
    )
  ), [allUsers]);

  const employeeOptions = useMemo<IEmployeeOption[]>(() => (
    [...(employeesQuery.data || [])]
      .sort((left, right) => left.full_name.localeCompare(right.full_name, 'ru'))
      .map(employee => {
        const linkedUser = registeredUserByEmployeeId.get(String(employee.id));
        return {
          id: employee.id,
          full_name: employee.full_name,
          hasPortalAccount: Boolean(linkedUser),
          label: `${employee.full_name}${linkedUser ? ` • портал: ${linkedUser.full_name || linkedUser.email || linkedUser.id}` : ' • без аккаунта'}`,
        };
      })
  ), [employeesQuery.data, registeredUserByEmployeeId]);

  const employeeOptionMap = useMemo(
    () => new Map(employeeOptions.map(option => [String(option.id), option])),
    [employeeOptions],
  );
  const flatDepartments = useMemo(
    () => getTreeFlatDepartments(structureQuery.data?.departments || []),
    [structureQuery.data?.departments],
  );
  const departmentOptionMap = useMemo(
    () => new Map(flatDepartments.map(department => [department.id, department])),
    [flatDepartments],
  );

  useEffect(() => {
    if (!preview || !employeesQuery.data?.length) return;
    if (Object.keys(assignmentsByGroup).length > 0) return;
    const employeeIds = new Set((employeesQuery.data || []).map(employee => String(employee.id)));
    const draftGroupAssignments = Object.fromEntries(
      Object.entries(draftStateRef.current.groupAssignments)
        .filter(([groupKey, employeeId]) => (
          preview.groups.some(group => group.group_key === groupKey) && employeeIds.has(employeeId)
        )),
    );
    setAssignmentsByGroup({
      ...buildAutoAssignments(preview.groups, employeesQuery.data),
      ...draftGroupAssignments,
    });
  }, [assignmentsByGroup, employeesQuery.data, preview]);

  const selectedAssignmentCount = useMemo(() => (
    Object.values(assignmentsByGroup).filter(Boolean).length
  ), [assignmentsByGroup]);

  const getGroupDepartmentIds = (group: ManagerDepartmentImportGroupPreview): string[] => {
    const manualDepartmentIds = group.brigades
      .map(brigade => manualDepartmentSelectionByBrigade[buildBrigadeKey(group, brigade)] || null)
      .filter((value): value is string => Boolean(value));

    return [...new Set([...group.resolved_department_ids, ...manualDepartmentIds])];
  };

  const problematicState = useMemo(() => {
    if (!preview) {
      return {
        successfulBrigadesCount: 0,
        unresolvedBrigadesCount: 0,
        groupsMissingEmployeeCount: 0,
        groupsNeedingManual: [] as Array<{
          group: ManagerDepartmentImportGroupPreview;
          unresolvedBrigades: ManagerDepartmentImportGroupPreview['brigades'];
          isEmployeeMissing: boolean;
        }>,
      };
    }

    let successfulBrigadesCount = 0;
    let unresolvedBrigadesCount = 0;
    let groupsMissingEmployeeCount = 0;

    const groupsNeedingManual = preview.groups.reduce<Array<{
      group: ManagerDepartmentImportGroupPreview;
      unresolvedBrigades: ManagerDepartmentImportGroupPreview['brigades'];
      isEmployeeMissing: boolean;
    }>>((acc, group) => {
      const unresolvedBrigades = group.brigades.filter(brigade => {
        if (brigade.status === 'matched') return false;
        const brigadeKey = buildBrigadeKey(group, brigade);
        return !manualDepartmentSelectionByBrigade[brigadeKey];
      });

      const resolvedBrigadesCount = group.brigades.length - unresolvedBrigades.length;
      const isEmployeeMissing = !assignmentsByGroup[group.group_key];

      successfulBrigadesCount += resolvedBrigadesCount;
      unresolvedBrigadesCount += unresolvedBrigades.length;
      if (isEmployeeMissing) {
        groupsMissingEmployeeCount += 1;
      }

      if (isEmployeeMissing || unresolvedBrigades.length > 0) {
        acc.push({
          group,
          unresolvedBrigades,
          isEmployeeMissing,
        });
      }

      return acc;
    }, []);

    return {
      successfulBrigadesCount,
      unresolvedBrigadesCount,
      groupsMissingEmployeeCount,
      groupsNeedingManual,
    };
  }, [assignmentsByGroup, manualDepartmentSelectionByBrigade, preview]);

  const selectedResolvedLinksCount = useMemo(() => {
    if (!preview) return 0;
    return preview.groups.reduce((sum, group) => {
      if (!assignmentsByGroup[group.group_key]) return sum;
      const manualResolvedCount = group.brigades.filter(brigade => {
        const brigadeKey = buildBrigadeKey(group, brigade);
        return brigade.status !== 'matched' && Boolean(manualDepartmentSelectionByBrigade[brigadeKey]);
      }).length;
      const autoResolvedCount = group.brigades.filter(brigade => brigade.status === 'matched').length;
      return sum + autoResolvedCount + manualResolvedCount;
    }, 0);
  }, [assignmentsByGroup, manualDepartmentSelectionByBrigade, preview]);

  const applyPreviewData = (data: ManagerDepartmentImportPreview) => {
    const employeeIds = new Set((employeesQuery.data || []).map(employee => String(employee.id)));
    const draftGroupAssignments = Object.fromEntries(
      Object.entries(draftStateRef.current.groupAssignments)
        .filter(([groupKey, employeeId]) => (
          data.groups.some(group => group.group_key === groupKey) && employeeIds.has(employeeId)
        )),
    );
    const draftBrigadeAssignments = Object.fromEntries(
      Object.entries(draftStateRef.current.brigadeDepartmentAssignments)
        .filter(([brigadeKey]) => (
          data.groups.some(group => group.brigades.some(brigade => buildBrigadeKey(group, brigade) === brigadeKey))
        )),
    );

    setPreview(data);
    setAssignmentsByGroup({
      ...buildAutoAssignments(data.groups, employeesQuery.data || []),
      ...draftGroupAssignments,
    });
    setManualDepartmentQueryByBrigade({});
    setManualDepartmentSelectionByBrigade(draftBrigadeAssignments);
  };

  useEffect(() => {
    const nextDraft: IImportDraftState = {
      groupAssignments: assignmentsByGroup,
      brigadeDepartmentAssignments: manualDepartmentSelectionByBrigade,
    };
    draftStateRef.current = nextDraft;
    saveImportDraftState(nextDraft);
  }, [assignmentsByGroup, manualDepartmentSelectionByBrigade]);

  const handlePreview = async (file: File) => {
    setPreviewLoading(true);
    setSelectedFile(file);
    try {
      const data = await adminService.previewDepartmentAccessImport(file);
      applyPreviewData(data);
      toast.success(`Импорт разобран: ${data.stats.total_groups} групп`);
    } catch (error) {
      setPreview(null);
      toast.error(error instanceof Error ? error.message : 'Ошибка разбора Excel');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    if (!preview) return;

    const payloadAssignments = preview.groups
      .map(group => ({
        ...group,
        allDepartmentIds: getGroupDepartmentIds(group),
      }))
      .filter(group => assignmentsByGroup[group.group_key] && group.allDepartmentIds.length > 0)
      .reduce<Array<{ employee_id: number; department_ids: string[]; source_groups: string[] }>>((acc, group) => {
        const employeeId = Number(assignmentsByGroup[group.group_key]);
        const existing = acc.find(item => item.employee_id === employeeId);
        if (existing) {
          existing.department_ids = [...new Set([...existing.department_ids, ...group.allDepartmentIds])];
          existing.source_groups = [...new Set([...existing.source_groups, buildGroupLabel(group)])];
          return acc;
        }

        acc.push({
          employee_id: employeeId,
          department_ids: [...group.allDepartmentIds],
          source_groups: [buildGroupLabel(group)],
        });
        return acc;
      }, []);
    const payloadGroupAssignments = preview.groups
      .filter(group => assignmentsByGroup[group.group_key])
      .map(group => ({
        section_name: group.section_name,
        manager_name: group.manager_name,
        employee_id: Number(assignmentsByGroup[group.group_key]),
      }));
    const payloadBrigadeAliases = preview.groups.flatMap(group => (
      group.brigades.flatMap(brigade => {
        const brigadeKey = buildBrigadeKey(group, brigade);
        const departmentId = manualDepartmentSelectionByBrigade[brigadeKey];
        if (brigade.status === 'matched' || !departmentId) {
          return [];
        }

        return [{
          section_name: group.section_name,
          brigade_name: brigade.brigade_name,
          department_id: departmentId,
        }];
      })
    ));

    if (payloadAssignments.length === 0 && payloadGroupAssignments.length === 0 && payloadBrigadeAliases.length === 0) {
      toast.error('Сначала выберите сотрудников для групп с найденными бригадами');
      return;
    }

    setApplyLoading(true);
    try {
      const result = await adminService.applyDepartmentAccessImport({
        assignments: payloadAssignments,
        group_assignments: payloadGroupAssignments,
        brigade_aliases: payloadBrigadeAliases,
      });
      toast.success(`Применено: ${result.applied_users} сотрудников, ${result.applied_links} привязок`);
      await onReload();
      if (selectedFile) {
        const refreshedPreview = await adminService.previewDepartmentAccessImport(selectedFile);
        applyPreviewData(refreshedPreview);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка применения импорта');
    } finally {
      setApplyLoading(false);
    }
  };

  return (
    <div className={styles.importSection}>
      <div className={styles.importIntro}>
        <div>
          <h3>Импорт назначений из Excel</h3>
          <p>
            Загрузите файл с начальниками участков и бригадами, затем сопоставьте каждую группу
            сотруднику из общего синхронизированного списка. Если у сотрудника уже есть аккаунт портала,
            он автоматически наследует эти назначения через свой `employee_id`. Для проблемных бригад
            ниже можно вручную подобрать отдел из нашей базы.
          </p>
        </div>
        <div className={styles.importActions}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => fileRef.current?.click()}
            disabled={previewLoading || employeesQuery.isPending}
          >
            {previewLoading ? 'Разбираю файл...' : 'Загрузить Excel'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              void handlePreview(file);
            }}
          />
        </div>
      </div>

      <div className={styles.importFileInfo}>
        Сотрудники для сопоставления:{' '}
        <strong>
          {employeesQuery.isPending
            ? 'загрузка...'
            : employeesQuery.isError
              ? 'ошибка загрузки'
              : `${employeeOptions.length} в общем списке`}
        </strong>
      </div>

      {selectedFile && (
        <div className={styles.importFileInfo}>
          Файл: <strong>{selectedFile.name}</strong>
        </div>
      )}

      {preview && (
        <>
          <div className={styles.importStats}>
            <div className={styles.importStatCard}>
              <span>Группы</span>
              <strong>{preview.stats.total_groups}</strong>
            </div>
            <div className={styles.importStatCard}>
              <span>Связки в файле</span>
              <strong>{preview.stats.total_links}</strong>
            </div>
            <div className={styles.importStatCard}>
              <span>Найдено бригад</span>
              <strong>{problematicState.successfulBrigadesCount}</strong>
            </div>
            <div className={styles.importStatCard}>
              <span>Нужно дозаполнить</span>
              <strong>{problematicState.unresolvedBrigadesCount}</strong>
            </div>
          </div>

          <div className={styles.importSuccessSummary}>
            Успешно: <strong>{problematicState.successfulBrigadesCount}</strong>
          </div>

          {problematicState.groupsNeedingManual.length > 0 && (
            <div className={styles.importProblemSummary}>
              <div>Нужно выбрать отдел вручную: <strong>{problematicState.unresolvedBrigadesCount}</strong></div>
              <div>Нужно выбрать сотрудника: <strong>{problematicState.groupsMissingEmployeeCount}</strong></div>
              <div>Назначено групп: <strong>{selectedAssignmentCount}</strong></div>
              <div>К применению связок: <strong>{selectedResolvedLinksCount}</strong></div>
            </div>
          )}

          {problematicState.groupsNeedingManual.length === 0 ? (
            <div className={styles.importAllGood}>
              Успешно: все строки уже сопоставлены. Ручное дозаполнение не требуется.
            </div>
          ) : (
            <div className={styles.importGroupList}>
              {problematicState.groupsNeedingManual.map(({ group, unresolvedBrigades, isEmployeeMissing }) => {
              const selectedEmployee = employeeOptionMap.get(assignmentsByGroup[group.group_key] || '');
              const manualIssues: string[] = [];
              if (unresolvedBrigades.length > 0) {
                manualIssues.push(`Проблемных строк: ${unresolvedBrigades.length}`);
              }
              if (isEmployeeMissing) {
                manualIssues.push('Не выбран сотрудник');
              }
              const groupDepartmentIds = getGroupDepartmentIds(group);
              return (
                <div key={group.group_key} className={styles.importGroupCard}>
                  <div className={styles.importGroupHeader}>
                    <div>
                      <div className={styles.importGroupTitle}>{group.manager_name}</div>
                      <div className={styles.importGroupMeta}>
                        {group.section_name || 'Без раздела'} • {group.brigade_count} бригад
                      </div>
                      {manualIssues.length > 0 && (
                        <div className={styles.importIssueBadges}>
                          {manualIssues.map(issue => (
                            <span key={issue} className={styles.importIssueBadge}>{issue}</span>
                          ))}
                        </div>
                      )}
                      {selectedEmployee && (
                        <div className={styles.importMatchedEmployee}>
                          Сопоставлено: {selectedEmployee.full_name}
                          {selectedEmployee.hasPortalAccount ? ' • уже есть аккаунт' : ' • аккаунта ещё нет'}
                        </div>
                      )}
                      {isEmployeeMissing && (
                        <div className={styles.importManualNotice}>
                          Нужно выбрать сотрудника из общего списка
                        </div>
                      )}
                      <div className={styles.importGroupTargetInfo}>
                        К применению отделов: <strong>{groupDepartmentIds.length}</strong>
                      </div>
                    </div>
                    <select
                      className={styles.importUserSelect}
                      value={assignmentsByGroup[group.group_key] || ''}
                      onChange={(event) => setAssignmentsByGroup(prev => {
                        const next = { ...prev };
                        if (event.target.value) {
                          next[group.group_key] = event.target.value;
                        } else {
                          delete next[group.group_key];
                        }
                        return next;
                      })}
                      disabled={employeesQuery.isPending || employeeOptions.length === 0}
                    >
                      <option value="">Не назначено</option>
                      {employeeOptions.map(option => (
                        <option key={option.id} value={String(option.id)}>{option.label}</option>
                      ))}
                    </select>
                  </div>

                  {unresolvedBrigades.length > 0 ? (
                    <div className={styles.importBrigadeList}>
                      {unresolvedBrigades.map(brigade => (
                      (() => {
                        const brigadeKey = buildBrigadeKey(group, brigade);
                        const selectedDepartmentId = manualDepartmentSelectionByBrigade[brigadeKey] || null;
                        const selectedDepartment = selectedDepartmentId ? departmentOptionMap.get(selectedDepartmentId) : null;
                        const currentQuery = manualDepartmentQueryByBrigade[brigadeKey] ?? brigade.brigade_name;
                        const normalizedQuery = normalizeText(currentQuery);
                        const manualDepartmentMatches = brigade.status === 'matched'
                          ? []
                          : flatDepartments
                              .filter(department => (
                                !department.hasChildren && (
                                  normalizedQuery.length > 0
                                    ? normalizeText(department.name).includes(normalizedQuery)
                                    : true
                                )
                              ))
                              .slice(0, MAX_MANUAL_DEPARTMENT_RESULTS);

                        return (
                          <div
                            key={`${group.group_key}-${brigade.row_number}-${brigade.brigade_name}`}
                            className={`${styles.importBrigadeItem} ${
                              brigade.status === 'matched'
                                ? styles.importBrigadeMatched
                                : styles.importBrigadeIssue
                            }`}
                          >
                            <div className={styles.importBrigadeName}>{brigade.brigade_name}</div>
                            <div className={styles.importBrigadeMeta}>
                              {brigade.status === 'matched'
                                ? brigade.department_name || 'Подразделение найдено'
                                : brigade.status === 'ambiguous'
                                  ? `Неоднозначно: ${(brigade.candidates || []).map(candidate => candidate.name || candidate.id).join(', ')}`
                                  : 'Подразделение не найдено'}
                            </div>

                            {brigade.status !== 'matched' && (
                              <div className={styles.importDepartmentSearch}>
                                <input
                                  type="text"
                                  value={currentQuery}
                                  className={styles.importDepartmentSearchInput}
                                  placeholder="Поиск отдела в базе..."
                                  onChange={(event) => setManualDepartmentQueryByBrigade(prev => ({
                                    ...prev,
                                    [brigadeKey]: event.target.value,
                                  }))}
                                />

                                {selectedDepartment && (
                                  <div className={styles.importDepartmentSelected}>
                                    Выбрано вручную: {selectedDepartment.name}
                                    <button
                                      type="button"
                                      className={styles.importDepartmentClear}
                                      onClick={() => setManualDepartmentSelectionByBrigade(prev => {
                                        const next = { ...prev };
                                        delete next[brigadeKey];
                                        return next;
                                      })}
                                    >
                                      Очистить
                                    </button>
                                  </div>
                                )}

                                <div className={styles.importDepartmentResults}>
                                  {manualDepartmentMatches.length > 0 ? (
                                    manualDepartmentMatches.map(department => (
                                      <button
                                        key={department.id}
                                        type="button"
                                        className={`${styles.importDepartmentResult} ${
                                          selectedDepartmentId === department.id ? styles.importDepartmentResultActive : ''
                                        }`}
                                        onClick={() => {
                                          setManualDepartmentSelectionByBrigade(prev => ({
                                            ...prev,
                                            [brigadeKey]: department.id,
                                          }));
                                          setManualDepartmentQueryByBrigade(prev => ({
                                            ...prev,
                                            [brigadeKey]: department.name,
                                          }));
                                        }}
                                      >
                                        {department.name}
                                      </button>
                                    ))
                                  ) : (
                                    <div className={styles.importDepartmentEmpty}>
                                      Поиск не дал совпадений
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()
                      ))}
                    </div>
                  ) : (
                    <div className={styles.importGroupResolvedHint}>
                      Все отделы по этой группе уже найдены. Осталось только выбрать сотрудника.
                    </div>
                  )}
                </div>
              );
              })}
            </div>
          )}

          <div className={styles.importFooter}>
            <div className={styles.importFooterHint}>
              Импорт применяет только группы, у которых выбран сотрудник и найдены подразделения.
              Для сотрудников без аккаунта назначения сохраняются заранее и начнут работать сразу после регистрации
              и привязки пользователя к тому же сотруднику. Для проблемных строк можно выбрать отдел вручную прямо здесь.
            </div>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => void handleApply()}
              disabled={applyLoading || selectedResolvedLinksCount === 0}
            >
              {applyLoading ? 'Применяю...' : 'Применить назначения'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
