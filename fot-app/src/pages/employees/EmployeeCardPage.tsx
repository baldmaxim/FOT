import { useState, useEffect, useCallback, type FC } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Archive, RotateCcw, Trash2 } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import { useAuth } from '../../contexts/AuthContext';
import { EmployeeInfoSection } from '../../components/employees/EmployeeInfoSection';
import { EmployeeHistorySection } from '../../components/employees/EmployeeHistorySection';
import { EmployeeSkudSection } from '../../components/employees/EmployeeSkudSection';
import type { Employee, EmployeeInput, EmployeeHistoryEvent } from '../../types';
import '../../styles/EmployeeCardPage.css';

export const EmployeeCardPage: FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { canAccess } = useAuth();
  const canEdit = canAccess('header');

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [history, setHistory] = useState<EmployeeHistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<EmployeeInput>>({});
  const [activeTab, setActiveTab] = useState<'info' | 'history' | 'skud'>('info');

  const loadData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const [emp, hist] = await Promise.all([
        employeeService.getById(Number(id)),
        employeeService.getHistory(Number(id)).catch(() => [] as EmployeeHistoryEvent[]),
      ]);
      setEmployee(emp);
      setHistory(hist);
    } catch {
      setError('Ошибка загрузки данных сотрудника');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  const startEditing = () => {
    if (!employee) return;
    setEditData({
      full_name: employee.full_name,
      hire_date: employee.hire_date,
      birth_date: employee.birth_date || undefined,
      current_salary: employee.current_salary,
      org_department_id: employee.org_department_id || undefined,
    });
    setIsEditing(true);
  };

  const saveEditing = async () => {
    if (!employee) return;
    try {
      await employeeService.update(employee.id, editData);
      setIsEditing(false);
      setEditData({});
      loadData();
    } catch {
      setError('Ошибка сохранения');
    }
  };

  const handleArchive = async () => {
    if (!employee || !confirm('Перевести сотрудника в архив?')) return;
    try {
      await employeeService.archive(employee.id);
      loadData();
    } catch {
      setError('Ошибка архивации');
    }
  };

  const handleRestore = async () => {
    if (!employee) return;
    try {
      await employeeService.restore(employee.id);
      loadData();
    } catch {
      setError('Ошибка восстановления');
    }
  };

  const handleDelete = async () => {
    if (!employee || !confirm('Удалить сотрудника? Это действие необратимо.')) return;
    try {
      await employeeService.delete(employee.id);
      navigate('/tender');
    } catch {
      setError('Ошибка удаления');
    }
  };

  if (loading) {
    return <div className="card-page"><div className="loading">Загрузка...</div></div>;
  }

  if (error && !employee) {
    return (
      <div className="card-page">
        <div className="card-error">
          <p>{error}</p>
          <button className="btn-back-link" onClick={() => navigate('/tender')}>
            <ArrowLeft size={16} /> Назад к списку
          </button>
        </div>
      </div>
    );
  }

  if (!employee) return null;

  return (
    <div className="card-page">
      <div className="card-top-bar">
        <button className="btn-back-link" onClick={() => navigate('/tender')}>
          <ArrowLeft size={16} /> Сотрудники
        </button>
      </div>

      {error && (
        <div className="card-error-banner">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

      <div className="card-header">
        <div className="card-header-info">
          <h1>{employee.full_name}</h1>
          {employee.position_name && (
            <span className="card-position">{employee.position_name}</span>
          )}
          {employee.is_archived && <span className="card-badge-archived">Архив</span>}
        </div>

        {canEdit && (
          <div className="card-actions">
            {!isEditing ? (
              <>
                <button className="btn-edit" onClick={startEditing}>
                  <Edit3 size={16} /> Редактировать
                </button>
                {employee.is_archived ? (
                  <button className="btn-restore" onClick={handleRestore}>
                    <RotateCcw size={16} /> Восстановить
                  </button>
                ) : (
                  <button className="btn-archive" onClick={handleArchive}>
                    <Archive size={16} /> В архив
                  </button>
                )}
                <button className="btn-delete" onClick={handleDelete}>
                  <Trash2 size={16} />
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>

      <div className="card-tabs">
        <button
          className={`card-tab ${activeTab === 'info' ? 'active' : ''}`}
          onClick={() => setActiveTab('info')}
        >
          Информация
        </button>
        <button
          className={`card-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          История
        </button>
        <button
          className={`card-tab ${activeTab === 'skud' ? 'active' : ''}`}
          onClick={() => setActiveTab('skud')}
        >
          СКУД
        </button>
      </div>

      <div className="card-content">
        {activeTab === 'info' && (
          <EmployeeInfoSection
            employee={employee}
            isEditing={isEditing}
            editData={editData}
            onEditDataChange={setEditData}
            onSave={saveEditing}
            onCancel={() => { setIsEditing(false); setEditData({}); }}
          />
        )}
        {activeTab === 'history' && (
          <EmployeeHistorySection history={history} />
        )}
        {activeTab === 'skud' && (
          <EmployeeSkudSection employeeId={employee.id} />
        )}
      </div>
    </div>
  );
};
