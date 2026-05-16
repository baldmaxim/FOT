import { type Dispatch, type FC, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { SearchInput } from '../../components/ui/SearchInput';
import { useToast } from '../../contexts/ToastContext';
import {
  salaryRaiseService,
  type SalaryRaiseCandidate,
} from '../../services/salaryRaiseService';
import {
  useSalaryRaiseCandidates,
  useSalaryRaiseObjects,
  useSalaryRaiseRequest,
} from '../../hooks/useSalaryRaiseData';
import styles from './SalaryRaiseFormPage.module.css';

const MIN_ACHIEVEMENTS = 3;

const formatSalary = (value: number | null | undefined) => (
  value != null ? `${new Intl.NumberFormat('ru-RU').format(value)} ₽` : '—'
);

const formatSalaryInput = (value: string): string => {
  const cleaned = value
    .replace(/\s+/g, '')
    .replace(/[^\d.,]/g, '')
    .replace(/\./g, ',');

  if (!cleaned) return '';

  const separatorIndex = cleaned.indexOf(',');
  const hasFraction = separatorIndex >= 0;
  const integerPartRaw = (hasFraction ? cleaned.slice(0, separatorIndex) : cleaned).replace(/\D/g, '');
  const fractionPart = (hasFraction ? cleaned.slice(separatorIndex + 1) : '')
    .replace(/\D/g, '')
    .slice(0, 2);

  const normalizedInteger = integerPartRaw.replace(/^0+(?=\d)/, '') || (integerPartRaw ? '0' : '');
  const formattedInteger = normalizedInteger
    ? new Intl.NumberFormat('ru-RU').format(Number(normalizedInteger))
    : '';

  if (hasFraction) {
    return `${formattedInteger || '0'},${fractionPart}`;
  }

  return formattedInteger;
};

const parseNumber = (value: string): number | null => {
  const normalized = value.replace(/\s+/g, '').replace(',', '.').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildEmptyAchievements = (): string[] => Array.from({ length: MIN_ACHIEVEMENTS }, () => '');

export const SalaryRaiseFormPage: FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();

  const isEdit = Boolean(id);
  const requestId = id ? Number(id) : null;
  const existingQuery = useSalaryRaiseRequest(requestId, isEdit);
  const existing = existingQuery.data ?? null;

  const [saving, setSaving] = useState(false);
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<SalaryRaiseCandidate | null>(null);
  const [isEmployeePickerOpen, setIsEmployeePickerOpen] = useState(false);
  const [currentSalary, setCurrentSalary] = useState('');
  const [requestedSalary, setRequestedSalary] = useState('');
  const [workObjectId, setWorkObjectId] = useState('');
  const [jobSummary, setJobSummary] = useState('');
  const [managerJustification, setManagerJustification] = useState('');
  const [achievements, setAchievements] = useState<string[]>(buildEmptyAchievements());

  const objectsQuery = useSalaryRaiseObjects();
  const candidatesQuery = useSalaryRaiseCandidates(employeeQuery, isEmployeePickerOpen);

  useEffect(() => {
    if (isEdit && existingQuery.isError) {
      navigate('/employee/salary-raise');
    }
  }, [existingQuery.isError, isEdit, navigate]);

  useEffect(() => {
    if (!existing) return;

    setSelectedEmployee({
      employee_id: existing.employee_id,
      full_name: existing.employee_snapshot.full_name,
      position_name: existing.employee_snapshot.position_name,
      department_name: existing.employee_snapshot.department_name,
    });
    setEmployeeQuery(existing.employee_snapshot.full_name);
    setCurrentSalary(existing.current_salary_entered != null ? formatSalaryInput(String(existing.current_salary_entered)) : '');
    setRequestedSalary(formatSalaryInput(String(existing.requested_salary)));
    setWorkObjectId(existing.work_object_id || '');
    setJobSummary(existing.job_summary || '');
    setManagerJustification(existing.manager_justification || '');
    setAchievements(
      existing.achievements.length >= MIN_ACHIEVEMENTS
        ? [...existing.achievements]
        : [...existing.achievements, ...buildEmptyAchievements()].slice(0, MIN_ACHIEVEMENTS),
    );
  }, [existing]);

  const currentSalaryValue = parseNumber(currentSalary);
  const requestedSalaryValue = parseNumber(requestedSalary);

  const raisePercentage = useMemo(() => {
    if (!currentSalaryValue || !requestedSalaryValue || currentSalaryValue <= 0) return null;
    const value = ((requestedSalaryValue - currentSalaryValue) / currentSalaryValue) * 100;
    return Math.round(value * 10) / 10;
  }, [currentSalaryValue, requestedSalaryValue]);

  const completedAchievements = useMemo(
    () => achievements.map((item) => item.trim()).filter(Boolean),
    [achievements],
  );

  const isFormValid = Boolean(
    selectedEmployee
    && currentSalaryValue
    && requestedSalaryValue
    && requestedSalaryValue > currentSalaryValue
    && workObjectId
    && jobSummary.trim()
    && managerJustification.trim()
    && completedAchievements.length >= MIN_ACHIEVEMENTS,
  );

  const showCandidates = isEmployeePickerOpen;

  const save = async (submitAfterSave: boolean) => {
    if (!isFormValid || !selectedEmployee || !currentSalaryValue || !requestedSalaryValue) {
      toast.error('Заполните все поля заявки и укажите минимум 3 достижения');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        employee_id: selectedEmployee.employee_id,
        current_salary_entered: currentSalaryValue,
        requested_salary: requestedSalaryValue,
        work_object_id: workObjectId,
        job_summary: jobSummary.trim(),
        achievements: completedAchievements,
        manager_justification: managerJustification.trim(),
      };

      const request = isEdit
        ? await salaryRaiseService.update(requestId as number, payload)
        : await salaryRaiseService.create(payload);

      if (submitAfterSave) {
        await salaryRaiseService.submit(request.id);
      }

      await queryClient.invalidateQueries({ queryKey: ['salary-raise'] });
      toast.success(submitAfterSave ? 'Заявка отправлена администратору' : 'Черновик сохранён');
      navigate('/employee/salary-raise');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить заявку');
    } finally {
      setSaving(false);
    }
  };

  const handleEmployeeInputChange = (value: string) => {
    setEmployeeQuery(value);
    setIsEmployeePickerOpen(true);
    if (selectedEmployee && value.trim() !== selectedEmployee.full_name) {
      setSelectedEmployee(null);
    }
  };

  const handleSalaryInputChange = (
    setter: Dispatch<SetStateAction<string>>,
  ) => (value: string) => {
    setter(formatSalaryInput(value));
  };

  const addAchievementField = () => {
    setAchievements((previous) => [...previous, '']);
  };

  const removeAchievementField = (index: number) => {
    setAchievements((previous) => {
      if (previous.length <= MIN_ACHIEVEMENTS) return previous;
      return previous.filter((_, currentIndex) => currentIndex !== index);
    });
  };

  const updateAchievement = (index: number, value: string) => {
    setAchievements((previous) => previous.map((item, currentIndex) => (
      currentIndex === index ? value : item
    )));
  };

  if (isEdit && existingQuery.isLoading) {
    return <div className={styles.loading}>Загрузка...</div>;
  }

  return (
    <div className={styles.page}>
      <button className={styles.backLink} onClick={() => navigate('/employee/salary-raise')}>
        ← Назад к заявкам
      </button>

      <div className={styles.section}>
        <h1 className={styles.title}>{isEdit ? 'Редактирование заявки' : 'Новая заявка на повышение'}</h1>
        <p className={styles.subtitle}>
          Заявка доступна только руководителю и отправляется администратору после проверки заполнения.
        </p>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Сотрудник</h3>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>ФИО сотрудника</label>
          <SearchInput
            value={employeeQuery}
            onValueChange={handleEmployeeInputChange}
            placeholder="Начните вводить ФИО подчинённого"
            onFocus={() => setIsEmployeePickerOpen(true)}
            onBlur={() => {
              window.setTimeout(() => setIsEmployeePickerOpen(false), 120);
            }}
            style={{ width: '100%' }}
          />
          {selectedEmployee && (
            <div className={styles.selectedEmployee}>
              <span>{selectedEmployee.full_name}</span>
              <span>{selectedEmployee.position_name || 'Должность не указана'}</span>
              <span>{selectedEmployee.department_name || 'Отдел не указан'}</span>
            </div>
          )}
          {showCandidates && (
            <div className={styles.dropdown}>
              {candidatesQuery.isLoading ? (
                <div className={styles.dropdownEmpty}>Поиск...</div>
              ) : (candidatesQuery.data ?? []).length === 0 ? (
                <div className={styles.dropdownEmpty}>Подходящих сотрудников не найдено</div>
              ) : (
                (candidatesQuery.data ?? []).map((candidate) => (
                  <button
                    key={candidate.employee_id}
                    className={styles.dropdownItem}
                    onMouseDown={() => {
                      setSelectedEmployee(candidate);
                      setEmployeeQuery(candidate.full_name);
                      setIsEmployeePickerOpen(false);
                    }}
                  >
                    <span>{candidate.full_name}</span>
                    <small>{candidate.position_name || '—'} • {candidate.department_name || '—'}</small>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Условия повышения</h3>
        <div className={styles.formGrid}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Текущий оклад</label>
            <input
              className={styles.formInput}
              inputMode="decimal"
              value={currentSalary}
              onChange={(event) => handleSalaryInputChange(setCurrentSalary)(event.target.value)}
              placeholder="Введите текущий оклад"
            />
            {existing?.employee_snapshot.current_salary != null && (
              <div className={styles.fieldHint}>
                В системе сейчас: {formatSalary(existing.employee_snapshot.current_salary)}
              </div>
            )}
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Желаемый оклад</label>
            <input
              className={styles.formInput}
              inputMode="decimal"
              value={requestedSalary}
              onChange={(event) => handleSalaryInputChange(setRequestedSalary)(event.target.value)}
              placeholder="Введите желаемый оклад"
            />
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Процент повышения</label>
            <div className={styles.previewBox}>
              {raisePercentage == null ? '—' : `${raisePercentage.toFixed(1)}%`}
            </div>
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Объект работы</label>
            <select
              className={styles.formSelect}
              value={workObjectId}
              onChange={(event) => setWorkObjectId(event.target.value)}
            >
              <option value="">Выберите объект</option>
              {(objectsQuery.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>

          <div className={styles.formGroupFull}>
            <label className={styles.formLabel}>Какая работа выполняется сотрудником</label>
            <textarea
              className={styles.formTextarea}
              value={jobSummary}
              onChange={(event) => setJobSummary(event.target.value)}
              placeholder="Кратко опишите зону ответственности и характер выполняемой работы"
            />
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <h3 className={styles.sectionTitle}>Достижения за полгода</h3>
          <button className={styles.addBtn} onClick={addAchievementField}>
            + Добавить поле
          </button>
        </div>
        <p className={styles.sectionHint}>Минимум 3 заполненных достижения. Иначе отправка формы недоступна.</p>

        <div className={styles.achievementsList}>
          {achievements.map((achievement, index) => (
            <div key={index} className={styles.achievementRow}>
              <textarea
                className={styles.formTextarea}
                value={achievement}
                onChange={(event) => updateAchievement(index, event.target.value)}
                placeholder={`Достижение ${index + 1}`}
              />
              <button
                className={styles.removeBtn}
                onClick={() => removeAchievementField(index)}
                disabled={achievements.length <= MIN_ACHIEVEMENTS}
                title="Удалить поле"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Обоснование</h3>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Почему, по вашему мнению, сотрудник заслуживает повышения ЗП?</label>
          <textarea
            className={styles.formTextarea}
            value={managerJustification}
            onChange={(event) => setManagerJustification(event.target.value)}
            placeholder="Подробно опишите причины, по которым сотрудника следует повысить"
          />
        </div>
      </div>

      <div className={styles.actions}>
        <button
          className="btn-secondary"
          onClick={() => save(false)}
          disabled={!isFormValid || saving}
        >
          {saving ? 'Сохранение...' : 'Сохранить черновик'}
        </button>
        <button
          className="btn-primary"
          onClick={() => save(true)}
          disabled={!isFormValid || saving}
        >
          {saving ? 'Отправка...' : 'Отправить заявку'}
        </button>
      </div>
    </div>
  );
};
