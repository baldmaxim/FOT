import { type FC } from 'react';
import { X, Check } from 'lucide-react';
import type { Employee, EmployeeInput } from '../../types';

interface IEmployeeInfoSectionProps {
  employee: Employee;
  isEditing: boolean;
  editData: Partial<EmployeeInput>;
  onEditDataChange: (data: Partial<EmployeeInput>) => void;
  onSave: () => void;
  onCancel: () => void;
}

const formatDate = (dateStr: string | null) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('ru-RU');
};

const pluralYears = (n: number): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return 'лет';
  if (mod10 === 1) return 'год';
  if (mod10 >= 2 && mod10 <= 4) return 'года';
  return 'лет';
};

const calculateTenure = (hireDate: string) => {
  const hire = new Date(hireDate);
  const now = new Date();
  const months = (now.getFullYear() - hire.getFullYear()) * 12 + (now.getMonth() - hire.getMonth());
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return years > 0 ? `${years} ${pluralYears(years)} ${rem} мес.` : `${rem} мес.`;
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
}) => {
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
    <div className="ec-info-sections-grid">
      {/* Личные данные */}
      <div className="ec-info-section">
        <div className="ec-info-section-title">Личные данные</div>
        <div className="ec-info-row">
          <span className="ec-info-label">ФИО</span>
          <span className="ec-info-val">{employee.full_name}</span>
        </div>
        {employee.birth_date && (
          <div className="ec-info-row">
            <span className="ec-info-label">Дата рождения</span>
            <span className="ec-info-val">{formatDate(employee.birth_date)}</span>
          </div>
        )}
        {employee.country && (
          <div className="ec-info-row">
            <span className="ec-info-label">Гражданство</span>
            <span className="ec-info-val">{employee.country}</span>
          </div>
        )}
        {employee.pension_number && (
          <div className="ec-info-row">
            <span className="ec-info-label">СНИЛС</span>
            <span className="ec-info-val">{employee.pension_number}</span>
          </div>
        )}
      </div>

      {/* Контакты */}
      <div className="ec-info-section">
        <div className="ec-info-section-title">Контакты</div>
        <div className="ec-info-row">
          <span className="ec-info-label">Email</span>
          <span className="ec-info-val">{employee.email || '—'}</span>
        </div>
        {employee.tab_number && (
          <div className="ec-info-row">
            <span className="ec-info-label">Табельный номер</span>
            <span className="ec-info-val">{employee.tab_number}</span>
          </div>
        )}
      </div>

      {/* Трудоустройство */}
      <div className="ec-info-section">
        <div className="ec-info-section-title">Трудоустройство</div>
        <div className="ec-info-row">
          <span className="ec-info-label">Дата найма</span>
          <span className="ec-info-val">{formatDate(employee.hire_date)}</span>
        </div>
        <div className="ec-info-row">
          <span className="ec-info-label">Стаж</span>
          <span className="ec-info-val">{calculateTenure(employee.hire_date)}</span>
        </div>
        <div className="ec-info-row">
          <span className="ec-info-label">Статус</span>
          <span className={`ec-info-val ${employee.employment_status === 'active' ? 'green' : 'red'}`}>
            {employee.employment_status === 'active' ? 'Активен' : 'Уволен'}
          </span>
        </div>
        <div className="ec-info-row">
          <span className="ec-info-label">Должность</span>
          <span className="ec-info-val">{employee.position_name || '—'}</span>
        </div>
        <div className="ec-info-row">
          <span className="ec-info-label">Отдел</span>
          <span className="ec-info-val">{employee.department || '—'}</span>
        </div>
        {employee.work_object && (
          <div className="ec-info-row">
            <span className="ec-info-label">Объект</span>
            <span className="ec-info-val">{employee.work_object}</span>
          </div>
        )}
        {employee.staff_units != null && (
          <div className="ec-info-row">
            <span className="ec-info-label">Ставка</span>
            <span className="ec-info-val">{employee.staff_units}</span>
          </div>
        )}
        {employee.current_salary != null && (
          <div className="ec-info-row">
            <span className="ec-info-label">Оклад</span>
            <span className="ec-info-val">{formatSalary(employee.current_salary)}</span>
          </div>
        )}
      </div>

      {/* Документы / Разрешения */}
      <div className="ec-info-section">
        <div className="ec-info-section-title">Документы и разрешения</div>
        {employee.patent_issue_date && (
          <div className="ec-info-row">
            <span className="ec-info-label">Патент выдан</span>
            <span className="ec-info-val">{formatDate(employee.patent_issue_date)}</span>
          </div>
        )}
        {employee.patent_expiry_date && (
          <div className="ec-info-row">
            <span className="ec-info-label">Патент до</span>
            <span className="ec-info-val">{formatDate(employee.patent_expiry_date)}</span>
          </div>
        )}
        {employee.permit_expiry_date && (
          <div className="ec-info-row">
            <span className="ec-info-label">Разрешение до</span>
            <span className="ec-info-val">{formatDate(employee.permit_expiry_date)}</span>
          </div>
        )}
        {employee.doc_receipt_date && (
          <div className="ec-info-row">
            <span className="ec-info-label">Документы получены</span>
            <span className="ec-info-val">{formatDate(employee.doc_receipt_date)}</span>
          </div>
        )}
        {employee.registration_cat1 && (
          <div className="ec-info-row">
            <span className="ec-info-label">Регистрация кат. 1</span>
            <span className="ec-info-val">{employee.registration_cat1}</span>
          </div>
        )}
        {employee.registration_cat4 && (
          <div className="ec-info-row">
            <span className="ec-info-label">Регистрация кат. 4</span>
            <span className="ec-info-val">{employee.registration_cat4}</span>
          </div>
        )}
        {!employee.patent_issue_date && !employee.patent_expiry_date && !employee.permit_expiry_date && !employee.doc_receipt_date && !employee.registration_cat1 && !employee.registration_cat4 && (
          <div className="ec-info-row">
            <span className="ec-info-label-empty">Нет данных</span>
          </div>
        )}
      </div>
    </div>
  );
};
