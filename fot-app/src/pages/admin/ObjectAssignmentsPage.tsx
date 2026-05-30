import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { adminService } from '../../services/adminService';
import { useStructureTree } from '../../hooks/useStructure';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useToast } from '../../contexts/ToastContext';
import { ObjectAccessPopover } from '../../components/admin/ObjectAccessPopover';
import type { OrgDepartmentNode } from '../../types/organization';
import styles from './Admin.module.css';

const EMPTY: string[] = [];
const OBJECT_ASSIGNMENTS_KEY = ['admin-object-assignments'] as const;

interface IObjectOption { id: string; name: string }

interface IDeptNodeProps {
  node: OrgDepartmentNode;
  depth: number;
  objects: IObjectOption[];
  deptObjects: Record<string, string[]>;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onSaveDept: (departmentId: string, objectIds: string[]) => Promise<void>;
}

const DeptNode: FC<IDeptNodeProps> = ({ node, depth, objects, deptObjects, expanded, onToggleExpand, onSaveDept }) => {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  const value = deptObjects[node.id] ?? EMPTY;

  return (
    <div>
      <div className={styles.objAssignRow} style={{ paddingLeft: depth * 18 }}>
        {hasChildren ? (
          <button type="button" className={styles.objAssignExpand} onClick={() => onToggleExpand(node.id)}>
            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : (
          <span className={styles.objAssignExpandPlaceholder} />
        )}
        <span className={styles.objAssignName}>{node.name}</span>
        <div className={styles.objAssignObjCol}>
          <ObjectAccessPopover
            objects={objects}
            value={value}
            onSave={ids => onSaveDept(node.id, ids)}
            emptyLabel="— объект не назначен —"
          />
        </div>
      </div>
      {hasChildren && isExpanded && (
        <div>
          {node.children.map(child => (
            <DeptNode
              key={child.id}
              node={child}
              depth={depth + 1}
              objects={objects}
              deptObjects={deptObjects}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onSaveDept={onSaveDept}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const ObjectAssignmentsPage: FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [employeeSearch, setEmployeeSearch] = useState('');
  const debouncedSearch = useDebouncedValue(employeeSearch, 350);

  const structureQuery = useStructureTree();
  const objectsQuery = useQuery({
    queryKey: ['admin-skud-objects'],
    queryFn: () => adminService.listSkudObjectsForAssignment(),
    staleTime: 5 * 60_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: OBJECT_ASSIGNMENTS_KEY,
    queryFn: () => adminService.getObjectAssignments(),
    staleTime: 30_000,
  });

  const objects = objectsQuery.data || [];
  // Memo по data: ref карты стабилен до refetch → ObjectAccessPopover не сбрасывает draft.
  const deptObjects = useMemo(() => assignmentsQuery.data?.department_objects ?? {}, [assignmentsQuery.data]);
  const employeeObjects = useMemo(() => assignmentsQuery.data?.employee_objects ?? {}, [assignmentsQuery.data]);

  const employeesQuery = useQuery({
    queryKey: ['admin-object-assign-emp-search', debouncedSearch],
    queryFn: () => adminService.searchAllEmployees(debouncedSearch),
    enabled: debouncedSearch.trim().length >= 2,
    staleTime: 30_000,
  });

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSaveDept = async (departmentId: string, objectIds: string[]) => {
    try {
      await adminService.updateDepartmentObjectAssignment(departmentId, objectIds);
      toast.success('Объекты отдела обновлены');
      await queryClient.invalidateQueries({ queryKey: OBJECT_ASSIGNMENTS_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения');
      throw error;
    }
  };

  const handleSaveEmployee = async (employeeId: number, objectIds: string[]) => {
    try {
      await adminService.updateEmployeeObjectAssignment(employeeId, objectIds);
      toast.success('Объекты сотрудника обновлены');
      await queryClient.invalidateQueries({ queryKey: OBJECT_ASSIGNMENTS_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения');
      throw error;
    }
  };

  const departments = structureQuery.data?.departments ?? [];
  const isLoading = structureQuery.isLoading || objectsQuery.isLoading || assignmentsQuery.isLoading;

  return (
    <div className={styles.objAssignPage}>
      <p className={styles.objAssignIntro}>
        Назначьте «объекты входа» отделам/бригадам — их сотрудники (включая начальников участков) наследуют объект.
        Для сотрудников, работающих сразу на нескольких объектах, добавьте объекты персонально ниже.
        Табельщица видит табель сотрудников назначенных ей объектов.
      </p>

      <section className={styles.objAssignSection}>
        <h3 className={styles.objAssignHeading}>Отделы и бригады</h3>
        {isLoading ? (
          <div className={styles.departmentAccessEmpty}>Загрузка…</div>
        ) : departments.length === 0 ? (
          <div className={styles.departmentAccessEmpty}>Отделы не найдены</div>
        ) : (
          <div className={styles.objAssignTree}>
            {departments.map(node => (
              <DeptNode
                key={node.id}
                node={node}
                depth={0}
                objects={objects}
                deptObjects={deptObjects}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                onSaveDept={handleSaveDept}
              />
            ))}
          </div>
        )}
      </section>

      <section className={styles.objAssignSection}>
        <h3 className={styles.objAssignHeading}>Сотрудники (персональные исключения)</h3>
        <div className={styles.objAssignSearchRow}>
          <Search size={16} className={styles.objAssignSearchIcon} />
          <input
            type="text"
            value={employeeSearch}
            onChange={e => setEmployeeSearch(e.target.value)}
            placeholder="Поиск сотрудника по ФИО…"
            className={styles.objAssignSearchInput}
          />
        </div>
        {debouncedSearch.trim().length < 2 ? (
          <div className={styles.departmentAccessEmpty}>Введите минимум 2 символа</div>
        ) : employeesQuery.isLoading ? (
          <div className={styles.departmentAccessEmpty}>Поиск…</div>
        ) : (employeesQuery.data || []).length === 0 ? (
          <div className={styles.departmentAccessEmpty}>Сотрудники не найдены</div>
        ) : (
          <div className={styles.objAssignTree}>
            {(employeesQuery.data || []).map(emp => (
              <div key={emp.id} className={styles.objAssignRow}>
                <span className={styles.objAssignName}>{emp.full_name}</span>
                <div className={styles.objAssignObjCol}>
                  <ObjectAccessPopover
                    objects={objects}
                    value={employeeObjects[String(emp.id)] ?? EMPTY}
                    onSave={ids => handleSaveEmployee(emp.id, ids)}
                    emptyLabel="— объект не назначен —"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default ObjectAssignmentsPage;
