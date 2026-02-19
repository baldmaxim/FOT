import { useState, useEffect, useCallback, type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { structureApi } from '../../api/structure';
import { adminService } from '../../services/adminService';
import type { OrgCompany, OrgDepartment, OrgSubdivision, OrgStructureResponse, Organization } from '../../types';
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
  const [addType, setAddType] = useState<'company' | 'department' | 'subdivision'>('company');
  const [addParentId, setAddParentId] = useState<string | null>(null);
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
        response.data.tree.companies.forEach((c) => {
          expanded.add(`company-${c.id}`);
          c.departments.forEach((d) => {
            expanded.add(`department-${d.id}`);
          });
        });
        setExpandedNodes(expanded);
      } else {
        setError(response.error || 'Ошибка загрузки');
      }
    } catch (err) {
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
      let response;

      if (addType === 'company') {
        response = await structureApi.createCompany(newName.trim(), undefined, effectiveOrgId);
      } else if (addType === 'department') {
        response = await structureApi.createDepartment(newName.trim(), addParentId, undefined, effectiveOrgId);
      } else {
        response = await structureApi.createSubdivision(newName.trim(), addParentId, undefined, effectiveOrgId);
      }

      if (response.success) {
        setShowAddModal(false);
        setNewName('');
        await loadStructure();
      } else {
        setError(response.error || 'Ошибка создания');
      }
    } catch (err) {
      setError('Ошибка создания элемента');
    } finally {
      setSaving(false);
    }
  };

  // Удаление элемента
  const handleDelete = async (type: 'company' | 'department' | 'subdivision', id: string, name: string) => {
    if (!confirm(`Удалить "${name}"? Все дочерние элементы также будут удалены.`)) {
      return;
    }

    try {
      let response;
      if (type === 'company') {
        response = await structureApi.deleteCompany(id, effectiveOrgId);
      } else if (type === 'department') {
        response = await structureApi.deleteDepartment(id, effectiveOrgId);
      } else {
        response = await structureApi.deleteSubdivision(id, effectiveOrgId);
      }

      if (response.success) {
        await loadStructure();
      } else {
        setError(response.error || 'Ошибка удаления');
      }
    } catch (err) {
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
  const openAddModal = (type: 'company' | 'department' | 'subdivision', parentId: string | null = null) => {
    setAddType(type);
    setAddParentId(parentId);
    setNewName('');
    setShowAddModal(true);
  };

  // Рендер узла дерева
  const renderTreeNode = (
    type: 'company' | 'department' | 'subdivision',
    item: OrgCompany | OrgDepartment | OrgSubdivision,
    children?: React.ReactNode,
    level: number = 0
  ) => {
    const nodeId = `${type}-${item.id}`;
    const isExpanded = expandedNodes.has(nodeId);
    const hasChildren = type !== 'subdivision';

    const typeLabels = {
      company: 'Компания',
      department: 'Отдел',
      subdivision: 'Подразделение',
    };

    const typeColors = {
      company: styles.companyNode,
      department: styles.departmentNode,
      subdivision: styles.subdivisionNode,
    };

    return (
      <div key={item.id} className={styles.treeNode} style={{ marginLeft: level * 24 }}>
        <div className={`${styles.nodeHeader} ${typeColors[type]}`}>
          {hasChildren && (
            <button
              className={styles.expandBtn}
              onClick={() => toggleNode(nodeId)}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          )}
          {!hasChildren && <span className={styles.expandPlaceholder} />}

          <span className={styles.nodeType}>{typeLabels[type]}</span>
          <span className={styles.nodeName}>{item.name}</span>

          {isSuperAdmin && (
            <div className={styles.nodeActions}>
              {type === 'company' && (
                <button
                  className={styles.addChildBtn}
                  onClick={() => openAddModal('department', item.id)}
                  title="Добавить отдел"
                >
                  + Отдел
                </button>
              )}
              {type === 'department' && (
                <button
                  className={styles.addChildBtn}
                  onClick={() => openAddModal('subdivision', item.id)}
                  title="Добавить подразделение"
                >
                  + Подр.
                </button>
              )}
              <button
                className={styles.deleteBtn}
                onClick={() => handleDelete(type, item.id, item.name)}
                title="Удалить"
              >
                ×
              </button>
            </div>
          )}
        </div>

        {isExpanded && children && <div className={styles.nodeChildren}>{children}</div>}
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
              Компаний: {structure.stats.companies} | Отделов: {structure.stats.departments} | Подразделений: {structure.stats.subdivisions}
            </p>
          )}
        </div>

        {isSuperAdmin && (!needsOrgSelector || selectedOrgId) && (
          <button
            className={styles.addCompanyBtn}
            onClick={() => openAddModal('company')}
          >
            + Добавить компанию
          </button>
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
          {structure?.tree.companies.length === 0 && structure?.orphanDepartments.length === 0 ? (
            <div className={styles.empty}>
              <p>Структура организации пуста</p>
              <p className={styles.emptyHint}>
                Добавьте компании, отделы и подразделения вручную или импортируйте сотрудников — структура создастся автоматически
              </p>
            </div>
          ) : (
            <>
              {structure?.tree.companies.map((company) =>
                renderTreeNode(
                  'company',
                  company,
                  <>
                    {company.departments.map((dept) =>
                      renderTreeNode(
                        'department',
                        dept,
                        <>
                          {dept.subdivisions.map((sub) =>
                            renderTreeNode('subdivision', sub, null, 2)
                          )}
                        </>,
                        1
                      )
                    )}
                  </>,
                  0
                )
              )}

              {structure?.orphanDepartments && structure.orphanDepartments.length > 0 && (
                <div className={styles.orphanSection}>
                  <div className={styles.orphanHeader}>Отделы без компании</div>
                  {structure.orphanDepartments.map((dept) =>
                    renderTreeNode(
                      'department',
                      dept,
                      <>
                        {dept.subdivisions.map((sub) =>
                          renderTreeNode('subdivision', sub, null, 2)
                        )}
                      </>,
                      0
                    )
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Модалка добавления */}
      {showAddModal && (
        <div className={styles.modalOverlay} onClick={() => setShowAddModal(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>
              {addType === 'company' && 'Добавить компанию'}
              {addType === 'department' && 'Добавить отдел'}
              {addType === 'subdivision' && 'Добавить подразделение'}
            </h2>

            <div className={styles.formGroup}>
              <label>Название</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={
                  addType === 'company'
                    ? 'Название компании'
                    : addType === 'department'
                    ? 'Название отдела'
                    : 'Название подразделения'
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
