import { useState, type FC } from 'react';
import { X, Check, ChevronDown } from 'lucide-react';
import type { Employee, EmployeeInput, OrgDepartmentNode } from '../../types';

interface IDepartmentOption {
  id: string;
  name: string;
  level: number;
}

const flattenDepartments = (nodes: OrgDepartmentNode[], level = 0): IDepartmentOption[] => {
  const result: IDepartmentOption[] = [];
  for (const node of nodes) {
    result.push({ id: node.id, name: node.name, level });
    if (node.children?.length) {
      result.push(...flattenDepartments(node.children, level + 1));
    }
  }
  return result;
};

interface IEmployeeInfoSectionProps {
  employee: Employee;
  isEditing: boolean;
  editData: Partial<EmployeeInput>;
  onEditDataChange: (data: Partial<EmployeeInput>) => void;
  onSave: () => void;
  onCancel: () => void;
  departments?: OrgDepartmentNode[];
  onMoveDepartment?: (departmentId: string) => Promise<void>;
  canEdit?: boolean;
}

const formatDate = (dateStr: string | null) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('ru-RU');
};

const calculateTenure = (hireDate: string) => {
  const hire = new Date(hireDate);
  const now = new Date();
  const months = (now.getFullYear() - hire.getFullYear()) * 12 + (now.getMonth() - hire.getMonth());
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return years > 0 ? `${years} г. ${rem} мес.` : `${rem} мес.`;
};

const formatSalary = (salary: number | null) => {
  if (!salary) return '—';
  return salary.toLocaleString('ru-RU') + ' ₽';
};

export const EmployeeInfoSection: FC<IEmployeeInfoSectionProps> = ({
  employee,
  isEditing,
  editData,
  onEditDataChange,
  onSave,
  onCancel,
  departments,
  onMoveDepartment,
  canEdit,
}) => {
  const [moving, setMoving] = useState(false);
  const flatDepts = departments ? flattenDepartments(departments) : [];

  const handleDepartmentChange = async (deptId: string) => {
    if (!onMoveDepartment || !deptId) return;
    setMoving(true);
    try {
      await onMoveDepartment(deptId);
    } finally {
      setMoving(false);
    }
  };
  if (isEditing) {
    return (
      <div className="card-edit-form">
        <div className="edit-grid">
          <div className="form-group">
            <label>ФИО</label>
            <input
              type="text"
              value={editData.full_name || ''}
              onChange={e => onEditDataChange({ ...editData, full_name: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Должность</label>
            <span className="form-readonly">{employee.position_name || '—'}</span>
          </div>
          <div className="form-group">
            <label>Дата рождения</label>
            <input
              type="date"
              value={editData.birth_date || ''}
              onChange={e => onEditDataChange({ ...editData, birth_date: e.target.value || undefined })}
            />
          </div>
        </div>
        <div className="card-edit-actions">
          <button className="btn-cancel" onClick={onCancel}>
            <X size={16} /> Отмена
          </button>
          <button className="btn-save" onClick={onSave}>
            <Check size={16} /> Сохранить
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card-info-grid">
      <div className="info-item">
        <span className="info-label">ФИО</span>
        <span className="info-value">{employee.full_name}</span>
      </div>
      <div className="info-item">
        <span className="info-label">Должность</span>
        <span className="info-value">{employee.position_name || '—'}</span>
      </div>
      <div className="info-item">
        <span className="info-label">Отдел</span>
        {canEdit && flatDepts.length > 0 ? (
          <div className="info-value-select">
            <select
              className="dept-select"
              value={employee.org_department_id || ''}
              onChange={e => handleDepartmentChange(e.target.value)}
              disabled={moving}
            >
              <option value="">— Не назначен —</option>
              {flatDepts.map(d => (
                <option key={d.id} value={d.id}>
                  {'  '.repeat(d.level)}{d.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="dept-select-icon" />
            {moving && <span className="dept-moving">Сохранение...</span>}
          </div>
        ) : (
          <span className="info-value">{employee.department || '—'}</span>
        )}
      </div>
      {employee.birth_date && (
        <div className="info-item">
          <span className="info-label">Дата рождения</span>
          <span className="info-value">{formatDate(employee.birth_date)}</span>
        </div>
      )}
      {employee.country && (
        <div className="info-item">
          <span className="info-label">Страна</span>
          <span className="info-value">{employee.country}</span>
        </div>
      )}
      {employee.pension_number && (
        <div className="info-item">
          <span className="info-label">СНИЛС</span>
          <span className="info-value">{employee.pension_number}</span>
        </div>
      )}
      {employee.patent_issue_date && (
        <div className="info-item">
          <span className="info-label">Патент выдан</span>
          <span className="info-value">{formatDate(employee.patent_issue_date)}</span>
        </div>
      )}
      {employee.patent_expiry_date && (
        <div className="info-item">
          <span className="info-label">Патент до</span>
          <span className="info-value">{formatDate(employee.patent_expiry_date)}</span>
        </div>
      )}
      {employee.email && (
        <div className="info-item">
          <span className="info-label">Email</span>
          <span className="info-value">{employee.email}</span>
        </div>
      )}
    </div>
  );
};
