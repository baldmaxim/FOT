import { useState, useEffect, useCallback, type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { structureApi } from '../../api/structure';
import { adminService } from '../../services/adminService';
import type { OrgDepartmentNode, OrgStructureResponse, Organization } from '../../types';
import styles from './StructurePage.module.css';

export const StructurePage: FC = () => {
  const { hasPosition, profile } = useAuth();
  const isSuperAdmin = hasPosition('super_admin');
  const needsOrgSelector = isSuperAdmin && !profile?.organization_id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [structure, setStructure] = useState<OrgStructureResponse | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // Селектор организации для super_admin
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  // Модалки
  const [showAddModal, setShowAddModal] = useState(false);
  const [addType, setAddType] = useState<'organization' | 'department'>('department');
  const [addParentDeptId, setAddParentDeptId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  const effectiveOrgId = needsOrgSelector ? (selectedOrgId ?? undefined) : undefined;

  // Загрузка списка организаций для super_admin
  useEffect(() => {
    if (!needsOrgSelector) return;
    adminService.getOrganizations().then((orgs) => {
      setOrganizations(orgs);
      if (orgs.length === 1) setSelectedOrgId(orgs[0].id);
    }).catch(() => {
      setError('Ошибка загрузки организаций');
    });
  }, [needsOrgSelector]);

  // Загрузка структуры
  const loadStructure = useCallback(async () => {
    if (needsOrgSelector && !selectedOrgId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const response = await structureApi.getTree(effectiveOrgId);
      if (response.success && response.data) {
        setStructure(response.data);
        const expanded = new Set<string>();
        const expandDepts = (depts: OrgDepartmentNode[]) => {
          depts.forEach((d) => {
            expanded.add(`department-${d.id}`);
            if (d.children) expandDepts(d.children);
          });
        };
        expandDepts(response.data.departments);
        setExpandedNodes(expanded);
      } else {
        setError(response.error || 'Ошибка загрузки');
      }
    } catch {
      setError('Ошибка загрузки структуры');
    } finally {
      setLoading(false);
    }
  }, [effectiveOrgId, needsOrgSelector, selectedOrgId]);

  useEffect(() => {
    loadStructure();
  }, [loadStructure]);

  // Добавление элемента
  const handleAdd = async () => {
    if (!newName.trim()) return;

    try {
      setSaving(true);

      if (addType === 'organization') {
        const org = await adminService.createOrganization(newName.trim());
        setShowAddModal(false);
        setNewName('');
        const orgs = await adminService.getOrganizations();
        setOrganizations(orgs);
        setSelectedOrgId(org.id);
        return;
      }

      const response = await structureApi.createDepartment(
        newName.trim(), undefined, effectiveOrgId, addParentDeptId
      );

      if (response.success) {
        setShowAddModal(false);
        setNewName('');
        await loadStructure();
      } else {
        setError(response.error || 'Ошибка создания');
      }
    } catch {
      setError('Ошибка создания элемента');
    } finally {
      setSaving(false);
    }
  };

  // Удаление отдела
  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Удалить "${name}"? Все дочерние элементы также будут удалены.`)) {
      return;
    }

    try {
      const response = await structureApi.deleteDepartment(id, effectiveOrgId);
      if (response.success) {
        await loadStructure();
      } else {
        setError(response.error || 'Ошибка удаления');
      }
    } catch {
      setError('Ошибка удаления элемента');
    }
  };

  // Переключение раскрытия узла
  const toggleNode = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  // Открытие модалки добавления
  const openAddModal = (
    type: 'organization' | 'department',
    parentDeptId: string | null = null,
  ) => {
    setAddType(type);
    setAddParentDeptId(parentDeptId);
    setNewName('');
    setShowAddModal(true);
  };

  // Рекурсивный рендер отдела
  const renderDepartmentNode = (dept: OrgDepartmentNode, level: number) => {
    const nodeId = `department-${dept.id}`;
    const isExpanded = expandedNodes.has(nodeId);
    const hasChildren = dept.children && dept.children.length > 0;

    return (
      <div key={dept.id} className={styles.treeNode} style={{ marginLeft: level * 24 }}>
        <div className={`${styles.nodeHeader} ${styles.departmentNode}`}>
          {hasChildren ? (
            <button className={styles.expandBtn} onClick={() => toggleNode(nodeId)}>
              {isExpanded ? '▼' : '▶'}
            </button>
          ) : (
            <span className={styles.expandPlaceholder} />
          )}

          <span className={styles.nodeType}>Отдел</span>
          <span className={styles.nodeName}>{dept.name}</span>

          {isSuperAdmin && (
            <div className={styles.nodeActions}>
              <button
                className={styles.addChildBtn}
                onClick={() => openAddModal('department', dept.id)}
                title="Добавить подотдел"
              >
                + Подотдел
              </button>
              <button
                className={styles.deleteBtn}
                onClick={() => handleDelete(dept.id, dept.name)}
                title="Удалить"
              >
                ×
              </button>
            </div>
          )}
        </div>

        {isExpanded && hasChildren && (
          <div className={styles.nodeChildren}>
            {dept.children.map((child) => renderDepartmentNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading && !needsOrgSelector) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Загрузка структуры...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Структура Организации</h1>
          {structure && (
            <p className={styles.stats}>
              Отделов: {structure.stats.departments}
            </p>
          )}
        </div>

        {isSuperAdmin && (!needsOrgSelector || selectedOrgId) && (
          <div className={styles.headerActions}>
            <button
              className={styles.addDeptBtn}
              onClick={() => openAddModal('department')}
            >
              + Отдел
            </button>
          </div>
        )}
      </div>

      {needsOrgSelector && (
        <div className={styles.orgSelector}>
          <label>Организация:</label>
          <select
            value={selectedOrgId || ''}
            onChange={(e) => setSelectedOrgId(e.target.value || null)}
          >
            <option value="">-- Выберите организацию --</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
          </select>
          <button
            className={styles.addOrgBtn}
            onClick={() => openAddModal('organization')}
            title="Добавить организацию"
          >
            + Организация
          </button>
        </div>
      )}

      {error && (
        <div className={styles.error}>
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {needsOrgSelector && !selectedOrgId ? (
        <div className={styles.tree}>
          <div className={styles.empty}>
            <p>Выберите организацию для просмотра структуры</p>
          </div>
        </div>
      ) : loading ? (
        <div className={styles.loading}>Загрузка структуры...</div>
      ) : (
        <div className={styles.tree}>
          {!structure?.departments?.length ? (
            <div className={styles.empty}>
              <p>Структура организации пуста</p>
              <p className={styles.emptyHint}>
                Добавьте отделы вручную или синхронизируйте из Sigur
              </p>
            </div>
          ) : (
            structure.departments.map((dept) =>
              renderDepartmentNode(dept, 0)
            )
          )}
        </div>
      )}

      {/* Модалка добавления */}
      {showAddModal && (
        <div className={styles.modalOverlay} onClick={() => setShowAddModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>
              {addType === 'organization' ? 'Добавить организацию' : 'Добавить отдел'}
            </h2>

            <div className={styles.formGroup}>
              <label>Название</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={
                  addType === 'organization'
                    ? 'Название организации'
                    : 'Название отдела'
                }
                autoFocus
              />
            </div>

            <div className={styles.modalActions}>
              <button
                className={styles.cancelBtn}
                onClick={() => setShowAddModal(false)}
                disabled={saving}
              >
                Отмена
              </button>
              <button
                className={styles.saveBtn}
                onClick={handleAdd}
                disabled={saving || !newName.trim()}
              >
                {saving ? 'Сохранение...' : 'Добавить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StructurePage;
