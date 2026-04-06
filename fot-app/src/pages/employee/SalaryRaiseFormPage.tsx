import { type FC, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  salaryRaiseService,
  REQUEST_TYPE_LABELS,
  type SalaryRaiseRequestType,
  type IAchievement,
  type IResponsibilityChanges,
  type ISelfAssessment,
  type ISalaryRaiseRequest,
  type ISalaryRaiseAttachment,
} from '../../services/salaryRaiseService';
import styles from './SalaryRaiseFormPage.module.css';

const EMPTY_ACHIEVEMENT: IAchievement = {
  period: '', task: '', description: '', result: '', effect: '',
};

const EMPTY_RESPONSIBILITY: IResponsibilityChanges = {
  new_functions: false, new_functions_desc: '',
  team_growth: false, team_growth_desc: '',
  complexity_increase: false, complexity_increase_desc: '',
  cross_functional: false, cross_functional_desc: '',
};

const EMPTY_ASSESSMENT: ISelfAssessment = {
  strengths: '', development_areas: '', career_goals: '',
};

const EFFECT_OPTIONS = [
  'Снижение затрат',
  'Рост выручки',
  'Повышение качества',
  'Сокращение сроков',
  'Улучшение безопасности',
  'Другое',
];

const RESPONSIBILITY_ITEMS: { key: keyof IResponsibilityChanges; label: string }[] = [
  { key: 'new_functions', label: 'Появились новые функции/обязанности' },
  { key: 'team_growth', label: 'Увеличилось количество подчинённых или команда' },
  { key: 'complexity_increase', label: 'Возросла сложность задач' },
  { key: 'cross_functional', label: 'Кросс-функциональное взаимодействие' },
];

const formatSalary = (v: number | null | undefined) =>
  v != null ? new Intl.NumberFormat('ru-RU').format(v) + ' ₽' : '—';

export const SalaryRaiseFormPage: FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<ISalaryRaiseRequest | null>(null);

  // Блок Б
  const [requestType, setRequestType] = useState<SalaryRaiseRequestType>('performance');
  const [requestedSalary, setRequestedSalary] = useState<number>(0);
  const [desiredDate, setDesiredDate] = useState('');
  const [reasonBrief, setReasonBrief] = useState('');

  // Блок В
  const [achievements, setAchievements] = useState<IAchievement[]>([{ ...EMPTY_ACHIEVEMENT }]);

  // Блок Г
  const [responsibility, setResponsibility] = useState<IResponsibilityChanges>({ ...EMPTY_RESPONSIBILITY });

  // Блок Д
  const [selfAssessment, setSelfAssessment] = useState<ISelfAssessment>({ ...EMPTY_ASSESSMENT });

  // Вложения
  const [attachments, setAttachments] = useState<ISalaryRaiseAttachment[]>([]);
  const [uploading, setUploading] = useState<number | null>(null); // achievement index or -1 for uploading
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetIdx = useRef<number | null>(null);

  const snapshot = existing?.employee_snapshot || null;
  const currentSalary = snapshot?.salary_actual ?? snapshot?.current_salary ?? 0;
  const raisePercent = currentSalary > 0 && requestedSalary > 0
    ? (((requestedSalary - currentSalary) / currentSalary) * 100).toFixed(1)
    : '0';

  const loadExisting = useCallback(async () => {
    if (!id) return;
    try {
      const data = await salaryRaiseService.getById(Number(id));
      setExisting(data);
      setRequestType(data.request_type);
      setRequestedSalary(data.requested_salary);
      setDesiredDate(data.desired_effective_date);
      setReasonBrief(data.reason_brief);
      setAchievements(data.achievements.length > 0 ? data.achievements : [{ ...EMPTY_ACHIEVEMENT }]);
      setResponsibility({ ...EMPTY_RESPONSIBILITY, ...data.responsibility_changes });
      setSelfAssessment({ ...EMPTY_ASSESSMENT, ...data.self_assessment });
      setAttachments(data.attachments || []);
    } catch {
      navigate('/employee/salary-raise');
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => { loadExisting(); }, [loadExisting]);

  const handleSave = async (submit: boolean) => {
    setSaving(true);
    try {
      const payload = {
        request_type: requestType,
        requested_salary: requestedSalary,
        raise_percentage: parseFloat(raisePercent),
        desired_effective_date: desiredDate,
        reason_brief: reasonBrief,
        achievements: achievements.filter(a => a.task.trim()),
        responsibility_changes: responsibility,
        self_assessment: selfAssessment,
      };

      let savedId: number;
      if (isEdit) {
        const data = await salaryRaiseService.update(Number(id), payload);
        savedId = data.id;
      } else {
        const data = await salaryRaiseService.create(payload);
        savedId = data.id;
      }

      if (submit) {
        await salaryRaiseService.submit(savedId);
      }

      navigate('/employee/salary-raise');
    } catch (err) {
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  };

  const addAchievement = () => {
    if (achievements.length >= 5) return;
    setAchievements([...achievements, { ...EMPTY_ACHIEVEMENT }]);
  };

  const removeAchievement = (idx: number) => {
    if (achievements.length <= 1) return;
    setAchievements(achievements.filter((_, i) => i !== idx));
  };

  const updateAchievement = (idx: number, field: keyof IAchievement, value: string) => {
    setAchievements(prev => prev.map((a, i) => i === idx ? { ...a, [field]: value } : a));
  };

  const toggleResponsibility = (key: keyof IResponsibilityChanges) => {
    const boolKey = key as 'new_functions' | 'team_growth' | 'complexity_increase' | 'cross_functional';
    setResponsibility(prev => ({ ...prev, [boolKey]: !prev[boolKey] }));
  };

  const triggerFileUpload = (achievementIdx: number) => {
    uploadTargetIdx.current = achievementIdx;
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !existing) return;
    const idx = uploadTargetIdx.current;

    setUploading(idx);
    try {
      // 1. Получить presigned URL
      const { upload_url, r2_key } = await salaryRaiseService.getUploadUrl(
        existing.id, file.name, file.type, idx !== null ? idx : undefined,
      );
      // 2. Загрузить файл напрямую в R2
      await fetch(upload_url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      // 3. Подтвердить
      const att = await salaryRaiseService.confirmAttachment(existing.id, {
        r2_key,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
        achievement_index: idx !== null ? idx : undefined,
      });
      setAttachments(prev => [...prev, att]);
    } catch (err) {
      console.error('Upload error:', err);
    } finally {
      setUploading(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteAttachment = async (attId: number) => {
    if (!existing) return;
    try {
      await salaryRaiseService.deleteAttachment(existing.id, attId);
      setAttachments(prev => prev.filter(a => a.id !== attId));
    } catch (err) {
      console.error('Delete attachment error:', err);
    }
  };

  const getAttachmentsForAchievement = (idx: number) =>
    attachments.filter(a => a.achievement_index === idx);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  };

  if (loading) return <div className={styles.loading}>Загрузка...</div>;

  return (
    <div className={styles.page}>
      <span className={styles.backLink} onClick={() => navigate('/employee/salary-raise')}>
        ← Назад к заявкам
      </span>

      {/* Блок А — Данные сотрудника */}
      {snapshot && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span className={styles.sectionLabel}>А</span> Данные сотрудника
          </h3>
          <div className={styles.snapshotGrid}>
            <div className={styles.snapshotItem}>
              <span className={styles.snapshotLabel}>ФИО</span>
              <span className={styles.snapshotValue}>{snapshot.full_name}</span>
            </div>
            <div className={styles.snapshotItem}>
              <span className={styles.snapshotLabel}>Должность</span>
              <span className={styles.snapshotValue}>{snapshot.position_name || '—'}</span>
            </div>
            <div className={styles.snapshotItem}>
              <span className={styles.snapshotLabel}>Отдел</span>
              <span className={styles.snapshotValue}>{snapshot.department_name || '—'}</span>
            </div>
            <div className={styles.snapshotItem}>
              <span className={styles.snapshotLabel}>Объект</span>
              <span className={styles.snapshotValue}>{snapshot.work_object || '—'}</span>
            </div>
            <div className={styles.snapshotItem}>
              <span className={styles.snapshotLabel}>Текущий оклад</span>
              <span className={styles.snapshotValue}>{formatSalary(snapshot.salary_actual ?? snapshot.current_salary)}</span>
            </div>
            <div className={styles.snapshotItem}>
              <span className={styles.snapshotLabel}>Дата найма</span>
              <span className={styles.snapshotValue}>{snapshot.hire_date ? new Date(snapshot.hire_date).toLocaleDateString('ru-RU') : '—'}</span>
            </div>
            <div className={styles.snapshotItem}>
              <span className={styles.snapshotLabel}>Руководитель</span>
              <span className={styles.snapshotValue}>{snapshot.supervisor_name || '—'}</span>
            </div>
            <div className={styles.snapshotItem}>
              <span className={styles.snapshotLabel}>Последнее повышение</span>
              <span className={styles.snapshotValue}>{snapshot.last_raise_date ? new Date(snapshot.last_raise_date).toLocaleDateString('ru-RU') : '—'}</span>
            </div>
          </div>
        </div>
      )}

      {/* Блок Б — Параметры заявки */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>
          <span className={styles.sectionLabel}>Б</span> Параметры заявки
        </h3>
        <div className={styles.formGrid}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Тип повышения</label>
            <select className={styles.formSelect} value={requestType}
              onChange={e => setRequestType(e.target.value as SalaryRaiseRequestType)}>
              {(Object.entries(REQUEST_TYPE_LABELS) as [SalaryRaiseRequestType, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Запрашиваемый оклад (₽)</label>
            <input type="number" className={styles.formInput}
              value={requestedSalary || ''} onChange={e => setRequestedSalary(Number(e.target.value))}
              placeholder="Введите сумму" min={0} />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Желаемая дата</label>
            <input type="date" className={styles.formInput}
              value={desiredDate} onChange={e => setDesiredDate(e.target.value)} />
          </div>
          <div className={styles.formGroup}>
            {requestedSalary > 0 && currentSalary > 0 && (
              <div className={styles.raisePreview}>
                {formatSalary(currentSalary)} → {formatSalary(requestedSalary)} (+{raisePercent}%)
              </div>
            )}
          </div>
          <div className={styles.formGroupFull}>
            <label className={styles.formLabel}>Причина повышения</label>
            <textarea className={styles.formTextarea} value={reasonBrief}
              onChange={e => setReasonBrief(e.target.value)} placeholder="Опишите причину запроса на повышение" />
          </div>
        </div>
      </div>

      {/* Блок В — Достижения */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>
          <span className={styles.sectionLabel}>В</span> Ключевые достижения (3–5)
        </h3>
        {achievements.map((a, idx) => (
          <div key={idx} className={styles.achievementBlock}>
            <div className={styles.achievementHeader}>
              <span className={styles.achievementTitle}>Достижение {idx + 1}</span>
              {achievements.length > 1 && (
                <button className={styles.removeBtn} onClick={() => removeAchievement(idx)}>Удалить</button>
              )}
            </div>
            <div className={styles.formGrid}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Период</label>
                <input className={styles.formInput} value={a.period}
                  onChange={e => updateAchievement(idx, 'period', e.target.value)} placeholder="янв 2026 – мар 2026" />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Эффект</label>
                <select className={styles.formSelect} value={a.effect}
                  onChange={e => updateAchievement(idx, 'effect', e.target.value)}>
                  <option value="">Выберите</option>
                  {EFFECT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div className={styles.formGroupFull}>
                <label className={styles.formLabel}>Задача</label>
                <input className={styles.formInput} value={a.task}
                  onChange={e => updateAchievement(idx, 'task', e.target.value)} placeholder="Краткое описание задачи" />
              </div>
              <div className={styles.formGroupFull}>
                <label className={styles.formLabel}>Описание и результат</label>
                <textarea className={styles.formTextarea} value={a.description}
                  onChange={e => updateAchievement(idx, 'description', e.target.value)}
                  placeholder="Подробное описание выполненной работы и достигнутого результата" />
              </div>
              <div className={styles.formGroupFull}>
                <label className={styles.formLabel}>Измеримый результат</label>
                <input className={styles.formInput} value={a.result}
                  onChange={e => updateAchievement(idx, 'result', e.target.value)}
                  placeholder="Конкретные цифры, метрики" />
              </div>
            </div>
          </div>
        ))}
        {achievements.length < 5 && (
          <button className={styles.addBtn} onClick={addAchievement}>+ Добавить достижение</button>
        )}
      </div>

      {/* Блок Г — Изменение обязанностей */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>
          <span className={styles.sectionLabel}>Г</span> Изменение обязанностей
        </h3>
        {RESPONSIBILITY_ITEMS.map(({ key, label }) => {
          const boolKey = key as 'new_functions' | 'team_growth' | 'complexity_increase' | 'cross_functional';
          const descKey = `${key}_desc` as keyof IResponsibilityChanges;
          return (
            <div key={key} className={styles.toggleRow}>
              <button
                className={`${styles.toggle} ${responsibility[boolKey] ? styles.active : ''}`}
                onClick={() => toggleResponsibility(boolKey)}
                type="button"
              >
                <span className={styles.toggleKnob} />
              </button>
              <div className={styles.toggleContent}>
                <div className={styles.toggleLabel}>{label}</div>
                {responsibility[boolKey] && (
                  <textarea className={styles.formTextarea}
                    value={responsibility[descKey] as string}
                    onChange={e => setResponsibility(prev => ({ ...prev, [descKey]: e.target.value }))}
                    placeholder="Опишите подробнее" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Блок Д — Самооценка */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>
          <span className={styles.sectionLabel}>Д</span> Самооценка
        </h3>
        <div className={styles.formGroup} style={{ marginBottom: 16 }}>
          <label className={styles.formLabel}>Сильные стороны</label>
          <textarea className={styles.formTextarea} value={selfAssessment.strengths}
            onChange={e => setSelfAssessment(prev => ({ ...prev, strengths: e.target.value }))}
            placeholder="Ваши ключевые компетенции и сильные стороны" />
        </div>
        <div className={styles.formGroup} style={{ marginBottom: 16 }}>
          <label className={styles.formLabel}>Области для развития</label>
          <textarea className={styles.formTextarea} value={selfAssessment.development_areas}
            onChange={e => setSelfAssessment(prev => ({ ...prev, development_areas: e.target.value }))}
            placeholder="Что планируете улучшить" />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Карьерные цели</label>
          <textarea className={styles.formTextarea} value={selfAssessment.career_goals}
            onChange={e => setSelfAssessment(prev => ({ ...prev, career_goals: e.target.value }))}
            placeholder="Ваши карьерные цели на ближайший год" />
        </div>
      </div>

      {/* Кнопки */}
      <div className={styles.actions}>
        <button className={styles.btnSecondary} onClick={() => handleSave(false)} disabled={saving}>
          {saving ? 'Сохранение...' : 'Сохранить черновик'}
        </button>
        <button className={styles.btnPrimary} onClick={() => handleSave(true)} disabled={saving}>
          {saving ? 'Отправка...' : 'Отправить на рассмотрение'}
        </button>
      </div>
    </div>
  );
};
