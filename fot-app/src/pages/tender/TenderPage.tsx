import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Users, Plus, Upload, Search, Archive, Trash2, Edit3, X, Check, ChevronDown, ChevronUp, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { adminService } from '../../services/adminService';
import { useAuth } from '../../contexts/AuthContext';
import type { Employee, EmployeeInput, Organization } from '../../types';
import '../../styles/TenderPage.css';

export const TenderPage: React.FC = () => {
  const { hasPosition, canAccess, profile } = useAuth();
  const isSuperAdmin = hasPosition('super_admin');
  const needsOrgSelector = isSuperAdmin && !profile?.organization_id;
  const canEdit = canAccess('header'); // header и выше (admin, super_admin)
  const [deleting, setDeleting] = useState(false);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const effectiveOrgId = needsOrgSelector ? (selectedOrgId ?? undefined) : undefined;

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  // Filter states
  const [positionFilter, setPositionFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');

  // Expanded row state
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  // Modal states
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form state for adding
  const [formData, setFormData] = useState<EmployeeInput>({
    full_name: '',
    hire_date: new Date().toISOString().split('T')[0],
    current_salary: null,
  });

  // Edit form state
  const [editFormData, setEditFormData] = useState<Partial<EmployeeInput>>({});

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

  const loadEmployees = useCallback(async () => {
    if (needsOrgSelector && !selectedOrgId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await employeeService.getAll(effectiveOrgId);
      setEmployees(data.filter(e => showArchived ? e.is_archived : !e.is_archived));
    } catch {
      setError('Ошибка загрузки сотрудников');
    } finally {
      setLoading(false);
    }
  }, [showArchived, effectiveOrgId, needsOrgSelector, selectedOrgId]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  // Extract unique positions and groups for filters
  const { positions, groups } = useMemo(() => {
    const posSet = new Set<string>();
    const groupSet = new Set<string>();

    employees.forEach(emp => {
      if (emp.position_name) posSet.add(emp.position_name);
      if (emp.department) groupSet.add(emp.department);
    });

    return {
      positions: Array.from(posSet).sort((a, b) => a.localeCompare(b, 'ru')),
      groups: Array.from(groupSet).sort((a, b) => a.localeCompare(b, 'ru')),
    };
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    return employees.filter(emp => {
      const matchesSearch = searchQuery === '' ||
        emp.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (emp.position_name || '').toLowerCase().includes(searchQuery.toLowerCase());

      const matchesPosition = positionFilter === '' || emp.position_name === positionFilter;
      const matchesGroup = groupFilter === '' || emp.department === groupFilter;

      return matchesSearch && matchesPosition && matchesGroup;
    });
  }, [employees, searchQuery, positionFilter, groupFilter]);

  const handleAddEmployee = async () => {
    if (!formData.full_name || !formData.hire_date) return;

    try {
      await employeeService.create(formData);
      setShowAddModal(false);
      setFormData({
        full_name: '',
        hire_date: new Date().toISOString().split('T')[0],
        current_salary: null,
      });
      loadEmployees();
    } catch {
      setError('Ошибка добавления сотрудника');
    }
  };

  const handleRowClick = (emp: Employee) => {
    if (expandedId === emp.id) {
      setExpandedId(null);
      setIsEditing(false);
    } else {
      setExpandedId(emp.id);
      setIsEditing(false);
    }
  };

  const handleArchive = async (id: number) => {
    if (!confirm('Перевести сотрудника в архив?')) return;
    try {
      await employeeService.archive(id);
      loadEmployees();
      setExpandedId(null);
    } catch {
      setError('Ошибка архивации');
    }
  };

  const handleRestore = async (id: number) => {
    try {
      await employeeService.restore(id);
      loadEmployees();
      setExpandedId(null);
    } catch {
      setError('Ошибка восстановления');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Удалить сотрудника? Это действие необратимо.')) return;
    try {
      await employeeService.delete(id);
      loadEmployees();
      setExpandedId(null);
    } catch {
      setError('Ошибка удаления');
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const result = await employeeService.import(file);
      alert(`Импортировано: ${result.imported} сотрудников`);
      loadEmployees();
    } catch {
      setError('Ошибка импорта');
    } finally {
      e.target.value = '';
    }
  };

  const handleDeleteAll = async () => {
    if (!confirm('ВНИМАНИЕ! Удалить ВСЕХ сотрудников? Это действие необратимо!')) return;
    if (!confirm('Вы уверены? Это удалит ВСЕ данные сотрудников!')) return;

    setDeleting(true);
    try {
      const result = await employeeService.deleteAll();
      alert(`Удалено ${result.deleted} сотрудников`);
      loadEmployees();
    } catch {
      setError('Ошибка удаления');
    } finally {
      setDeleting(false);
    }
  };

  const startEditing = (emp: Employee) => {
    setEditFormData({
      full_name: emp.full_name,
      position_id: emp.position_id || undefined,
      hire_date: emp.hire_date,
      birth_date: emp.birth_date || undefined,
      current_salary: emp.current_salary,
      org_department_id: emp.org_department_id || undefined,
    });
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditFormData({});
  };

  const saveEditing = async (id: number) => {
    try {
      await employeeService.update(id, editFormData);
      setIsEditing(false);
      setEditFormData({});
      loadEmployees();
    } catch {
      setError('Ошибка сохранения');
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('ru-RU');
  };

  const formatSalary = (salary: number | null) => {
    if (!salary) return '—';
    return salary.toLocaleString('ru-RU') + ' ₽';
  };

  const calculateTenure = (hireDate: string) => {
    const hire = new Date(hireDate);
    const now = new Date();
    const months = (now.getFullYear() - hire.getFullYear()) * 12 + (now.getMonth() - hire.getMonth());
    const years = Math.floor(months / 12);
    const remainingMonths = months % 12;

    if (years > 0) {
      return `${years} г. ${remainingMonths} мес.`;
    }
    return `${remainingMonths} мес.`;
  };

  const clearFilters = () => {
    setPositionFilter('');
    setGroupFilter('');
    setSearchQuery('');
  };

  const hasActiveFilters = positionFilter !== '' || groupFilter !== '' || searchQuery !== '';

  return (
    <div className="tender-page">
      <div className="tender-header">
        <div className="tender-title">
          <Users size={24} />
          <h1>Сотрудники</h1>
        </div>
      </div>

      {error && (
        <div className="error-banner" style={{ background: '#fef2f2', color: '#dc2626', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>
          {error}
          <button onClick={() => setError('')} style={{ marginLeft: '12px' }}>×</button>
        </div>
      )}

      {needsOrgSelector && (
        <div className="org-selector" style={{ marginBottom: 16 }}>
          <select
            value={selectedOrgId || ''}
            onChange={(e) => setSelectedOrgId(e.target.value || null)}
            className="filter-select"
          >
            <option value="">Выберите организацию</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="tender-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            type="text"
            placeholder="Поиск..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <select
          className="filter-select"
          value={positionFilter}
          onChange={e => setPositionFilter(e.target.value)}
        >
          <option value="">Все должности</option>
          {positions.map(pos => (
            <option key={pos} value={pos}>{pos}</option>
          ))}
        </select>

        <select
          className="filter-select"
          value={groupFilter}
          onChange={e => setGroupFilter(e.target.value)}
        >
          <option value="">Все группы</option>
          {groups.map(group => (
            <option key={group} value={group}>{group}</option>
          ))}
        </select>

        {hasActiveFilters && (
          <button
            className="btn-clear-filters"
            onClick={clearFilters}
            title="Сбросить фильтры"
          >
            <X size={16} />
          </button>
        )}

        <button
          className={`btn-archive-toggle ${showArchived ? 'active' : ''}`}
          onClick={() => setShowArchived(!showArchived)}
        >
          <Archive size={16} />
          <span>{showArchived ? 'Архив' : 'Архив'}</span>
        </button>

        {canEdit && (
          <div className="tender-actions">
            <button className="btn-import" onClick={() => setShowImportModal(true)}>
              <Upload size={18} />
              <span>Импорт</span>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              accept=".xlsx,.xls"
              onChange={handleImport}
              hidden
            />
            <button className="btn-add" onClick={() => setShowAddModal(true)}>
              <Plus size={18} />
              <span>Сотрудник</span>
            </button>
            {isSuperAdmin && (
              <button
                className="btn-clear-all"
                onClick={handleDeleteAll}
                disabled={deleting}
                title="Удалить всех сотрудников (для разработки)"
              >
                <AlertTriangle size={16} />
                <span>{deleting ? 'Удаление...' : 'Очистить'}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : filteredEmployees.length === 0 ? (
        <div className="empty-state">
          <Users size={48} />
          <p>Сотрудники не найдены</p>
        </div>
      ) : (
        <div className="employees-table">
          <div className="table-header">
            <span style={{ width: '40px', textAlign: 'center' }}>№</span>
            <span>ФИО</span>
            <span>Должность</span>
            <span>Стаж</span>
            <span>Зарплата</span>
            <span>Дата найма</span>
            <span>Группа</span>
            <span style={{ width: '30px' }}></span>
          </div>
          {filteredEmployees.map((emp, index) => (
            <React.Fragment key={emp.id}>
              <div
                className={`table-row ${expandedId === emp.id ? 'expanded' : ''} ${emp.is_archived ? 'archived' : ''}`}
                onClick={() => handleRowClick(emp)}
              >
                <span className="col-number" style={{ width: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  {index + 1}
                </span>
                <span className="col-name">{emp.full_name}</span>
                <span className="col-position">{emp.position_name || '—'}</span>
                <span className="col-tenure">{calculateTenure(emp.hire_date)}</span>
                <span className="col-salary">{formatSalary(emp.current_salary)}</span>
                <span className="col-date">{formatDate(emp.hire_date)}</span>
                <span className="col-group">{emp.department || '—'}</span>
                <span className="col-chevron" style={{ width: '30px', display: 'flex', justifyContent: 'center' }}>
                  {expandedId === emp.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </span>
              </div>

              {/* Expanded Details */}
              {expandedId === emp.id && (
                <div className="employee-expanded">
                  {isEditing ? (
                    <div className="expanded-edit-form">
                      <div className="edit-grid">
                        <div className="form-group">
                          <label>ФИО</label>
                          <input
                            type="text"
                            value={editFormData.full_name || ''}
                            onChange={e => setEditFormData({ ...editFormData, full_name: e.target.value })}
                          />
                        </div>
                        <div className="form-group">
                          <label>Должность</label>
                          <span style={{ padding: '8px 0', color: 'var(--text-muted)' }}>
                            {employees.find(e => e.id === expandedId)?.position_name || '—'}
                          </span>
                        </div>
                        <div className="form-group">
                          <label>Дата найма</label>
                          <input
                            type="date"
                            value={editFormData.hire_date || ''}
                            onChange={e => setEditFormData({ ...editFormData, hire_date: e.target.value })}
                          />
                        </div>
                        <div className="form-group">
                          <label>Дата рождения</label>
                          <input
                            type="date"
                            value={editFormData.birth_date || ''}
                            onChange={e => setEditFormData({ ...editFormData, birth_date: e.target.value || undefined })}
                          />
                        </div>
                        <div className="form-group">
                          <label>Зарплата</label>
                          <input
                            type="number"
                            value={editFormData.current_salary || ''}
                            onChange={e => setEditFormData({ ...editFormData, current_salary: e.target.value ? Number(e.target.value) : null })}
                          />
                        </div>
                      </div>
                      <div className="expanded-actions">
                        <button className="btn-cancel" onClick={cancelEditing}>
                          <X size={16} />
                          Отмена
                        </button>
                        <button className="btn-save" onClick={() => saveEditing(emp.id)}>
                          <Check size={16} />
                          Сохранить
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="expanded-view">
                      <div className="expanded-info">
                        <div className="info-item">
                          <span className="info-label">Должность</span>
                          <span className="info-value">{emp.position_name || '—'}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Дата найма</span>
                          <span className="info-value">{formatDate(emp.hire_date)}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Стаж</span>
                          <span className="info-value">{calculateTenure(emp.hire_date)}</span>
                        </div>
                        {emp.birth_date && (
                          <div className="info-item">
                            <span className="info-label">Дата рождения</span>
                            <span className="info-value">{formatDate(emp.birth_date)}</span>
                          </div>
                        )}
                        <div className="info-item">
                          <span className="info-label">Группа</span>
                          <span className="info-value">{emp.department || '—'}</span>
                        </div>
                        <div className="info-item highlight">
                          <span className="info-label">Зарплата</span>
                          <span className="info-value">{formatSalary(emp.current_salary)}</span>
                        </div>
                      </div>
                      {canEdit && (
                        <div className="expanded-actions">
                          <button className="btn-edit" onClick={(e) => { e.stopPropagation(); startEditing(emp); }}>
                            <Edit3 size={16} />
                            Редактировать
                          </button>
                          {emp.is_archived ? (
                            <button className="btn-restore" onClick={(e) => { e.stopPropagation(); handleRestore(emp.id); }}>
                              Восстановить
                            </button>
                          ) : (
                            <button className="btn-archive" onClick={(e) => { e.stopPropagation(); handleArchive(emp.id); }}>
                              <Archive size={16} />
                              В архив
                            </button>
                          )}
                          <button className="btn-delete" onClick={(e) => { e.stopPropagation(); handleDelete(emp.id); }}>
                            <Trash2 size={16} />
                            Удалить
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Add Employee Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>Добавить сотрудника</h3>

            <div className="form-group">
              <label>ФИО</label>
              <input
                type="text"
                value={formData.full_name}
                onChange={e => setFormData({ ...formData, full_name: e.target.value })}
                placeholder="Иванов Иван Иванович"
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Дата найма</label>
                <input
                  type="date"
                  value={formData.hire_date}
                  onChange={e => setFormData({ ...formData, hire_date: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>Зарплата</label>
                <input
                  type="number"
                  value={formData.current_salary || ''}
                  onChange={e => setFormData({ ...formData, current_salary: e.target.value ? Number(e.target.value) : null })}
                  placeholder="50000"
                />
              </div>
            </div>

            <div className="modal-actions">
              <button onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="btn-primary" onClick={handleAddEmployee}>
                Добавить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div className="modal-overlay" onClick={() => setShowImportModal(false)}>
          <div className="import-modal" onClick={e => e.stopPropagation()}>
            <div className="import-modal-header">
              <div className="import-modal-icon">
                <FileSpreadsheet size={24} />
              </div>
              <div className="import-modal-title">
                <h3>Импорт сотрудников</h3>
                <p>Загрузите Excel файл (.xlsx, .xls)</p>
              </div>
              <button className="import-modal-close" onClick={() => setShowImportModal(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="import-modal-body">
              <table className="import-columns-table">
                <thead>
                  <tr>
                    <th className="import-col-num">№</th>
                    <th className="import-col-name">Столбец</th>
                    <th className="import-col-required">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { n: 1, name: 'ФИО полное' },
                    { n: 2, name: 'Должность' },
                    { n: 3, name: 'Отдел' },
                    { n: 4, name: 'Подразделение' },
                    { n: 5, name: 'Дата приёма' },
                    { n: 6, name: 'Дата рождения' },
                    { n: 7, name: 'Зарплата' },
                    { n: 8, name: 'Страна' },
                    { n: 9, name: 'СНИЛС' },
                    { n: 10, name: 'Дата выдачи патента' },
                    { n: 11, name: 'Дата окончания патента' },
                    { n: 12, name: 'Компания' },
                    { n: 13, name: 'Email' },
                  ].map(col => (
                    <tr key={col.n}>
                      <td className="import-col-num">{col.n}</td>
                      <td className="import-col-name">{col.name}</td>
                      <td className="import-col-required"></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="import-hints">
                <div className="import-hint">
                  <span className="import-hint-icon">📅</span>
                  <span>Форматы дат: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД</span>
                </div>
                <div className="import-hint accent">
                  <span className="import-hint-icon">✨</span>
                  <span>Компании, отделы и подразделения автоматически добавляются в структуру</span>
                </div>
              </div>
            </div>

            <div className="import-modal-footer">
              <button className="import-btn-cancel" onClick={() => setShowImportModal(false)}>
                Отмена
              </button>
              <button
                className="import-btn-submit"
                onClick={() => {
                  setShowImportModal(false);
                  fileInputRef.current?.click();
                }}
              >
                <Upload size={18} />
                Выбрать файл
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
