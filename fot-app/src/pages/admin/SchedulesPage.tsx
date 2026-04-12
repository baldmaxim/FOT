import { Suspense, lazy, type FC, useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { scheduleService } from '../../services/scheduleService';
import { workCategoryService } from '../../services/workCategoryService';
import type {
  IDayOverride,
  IWorkSchedule,
  ICategorySchedule,
  IWorkCategory,
  ScheduleType,
  PatternType,
} from '../../types/schedule';
import {
  PATTERN_TYPE_LABELS,
  SCHEDULE_TYPE_LABELS,
  WEEKDAY_LABELS,
} from '../../types/schedule';
import { parseHMToMinutes, minutesToHM } from '../../utils/scheduleUtils';
import styles from './SchedulesPage.module.css';

const ProductionCalendarPage = lazy(() => import('../super-admin/ProductionCalendarPage').then(module => ({
  default: module.ProductionCalendarPage,
})));

type TabKey = 'templates' | 'category-assignments' | 'category-manage' | 'production-calendar';

interface IFormState {
  id: string | null;
  name: string;
  schedule_type: ScheduleType;
  pattern_type: PatternType;
  work_start: string;
  work_end: string;
  work_days: number[];
  day_overrides: Partial<Record<number, Pick<IDayOverride, 'work_start' | 'work_end'>>>;
  lunch_minutes: number;
  respects_holidays: boolean;
  expected_saturdays_per_month: number;
  late_threshold_minutes: number;
  full_day_threshold: string;          // "HH:MM", "" = авто (чистое время)
  weekend_full_day_threshold: string;  // "HH:MM", "" = авто (= full_day_threshold)
}

const EMPTY_FORM: IFormState = {
  id: null,
  name: '',
  schedule_type: 'office',
  pattern_type: '5+0',
  work_start: '09:00',
  work_end: '18:00',
  work_days: [1, 2, 3, 4, 5],
  day_overrides: {},
  lunch_minutes: 35,
  respects_holidays: true,
  expected_saturdays_per_month: 0,
  late_threshold_minutes: 0,
  full_day_threshold: '',
  weekend_full_day_threshold: '',
};

const createEmptyForm = (): IFormState => ({
  ...EMPTY_FORM,
  work_days: [...EMPTY_FORM.work_days],
  day_overrides: {},
});

const formatHours = (decimalHours: number): string => {
  const total = Math.max(0, Math.round(decimalHours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
};

const formatMinutes = (minutes: number): string => {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
};

const getLocalISODate = (): string => {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
};

const isActiveScheduleAssignment = (effectiveFrom: string, effectiveTo: string | null, date: string): boolean =>
  effectiveFrom <= date && (effectiveTo === null || effectiveTo > date);

/** Длина смены по началу/концу (с учётом ночной смены) в десятичных часах */
const computeShiftHours = (start: string, end: string): number => {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some(n => Number.isNaN(n))) return 0;
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes / 60;
};

const buildDayOverrideDrafts = (
  overrides: IWorkSchedule['day_overrides'],
): Partial<Record<number, Pick<IDayOverride, 'work_start' | 'work_end'>>> => {
  if (!overrides) return {};
  return Object.fromEntries(
    Object.entries(overrides).map(([day, override]) => [
      Number(day),
      {
        work_start: override.work_start.slice(0, 5),
        work_end: override.work_end.slice(0, 5),
      },
    ]),
  ) as Partial<Record<number, Pick<IDayOverride, 'work_start' | 'work_end'>>>;
};

const formatDayOverridesSummary = (overrides: IWorkSchedule['day_overrides']): string => {
  if (!overrides) return '';
  return Object.entries(overrides)
    .sort(([dayA], [dayB]) => Number(dayA) - Number(dayB))
    .map(([day, override]) => `${WEEKDAY_LABELS[Number(day) - 1]} ${override.work_start.slice(0, 5)}-${override.work_end.slice(0, 5)}`)
    .join(', ');
};

const PATTERN_PRESETS: Record<PatternType, Partial<IFormState>> = {
  '5+0': { work_days: [1, 2, 3, 4, 5], expected_saturdays_per_month: 0 },
  '5+2': { work_days: [1, 2, 3, 4, 5], expected_saturdays_per_month: 2 },
  '6+0': { work_days: [1, 2, 3, 4, 5, 6], expected_saturdays_per_month: 0 },
  'custom': {},
};
const EMPTY_TEMPLATES: IWorkSchedule[] = [];
const EMPTY_ASSIGNMENTS: ICategorySchedule[] = [];
const EMPTY_WORK_CATEGORIES: IWorkCategory[] = [];

export const SchedulesPage: FC = () => {
  const today = getLocalISODate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>('templates');
  const [error, setError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<IFormState>(createEmptyForm());

  // Форма категории
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [editingCategoryCode, setEditingCategoryCode] = useState<string | null>(null);
  const [categoryForm, setCategoryForm] = useState({ code: '', name: '', description: '', sort_order: 0 });

  const needsTemplates = tab === 'templates' || tab === 'category-assignments';
  const needsAssignments = tab === 'category-assignments';
  const needsWorkCategories = tab === 'category-assignments' || tab === 'category-manage';

  const templatesQuery = useQuery({
    queryKey: ['schedules', 'templates'],
    queryFn: () => scheduleService.list(),
    enabled: needsTemplates,
    staleTime: 5 * 60_000,
    placeholderData: previousData => previousData,
  });
  const assignmentsQuery = useQuery({
    queryKey: ['schedules', 'category-assignments'],
    queryFn: () => scheduleService.listCategories(),
    enabled: needsAssignments,
    staleTime: 5 * 60_000,
    placeholderData: previousData => previousData,
  });
  const workCategoriesQuery = useQuery({
    queryKey: ['work-categories'],
    queryFn: () => workCategoryService.list(),
    enabled: needsWorkCategories,
    staleTime: 5 * 60_000,
    placeholderData: previousData => previousData,
  });
  const templates = templatesQuery.data ?? EMPTY_TEMPLATES;
  const assignments = assignmentsQuery.data ?? EMPTY_ASSIGNMENTS;
  const workCategories = workCategoriesQuery.data ?? EMPTY_WORK_CATEGORIES;
  const loading = (
    (needsTemplates && templatesQuery.isPending)
    || (needsAssignments && assignmentsQuery.isPending)
    || (needsWorkCategories && workCategoriesQuery.isPending)
  );
  const queryError = (
    (needsTemplates ? templatesQuery.error : null)
    || (needsAssignments ? assignmentsQuery.error : null)
    || (needsWorkCategories ? workCategoriesQuery.error : null)
  );
  const visibleError = error || (queryError instanceof Error ? queryError.message : '');

  const reloadScheduleData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['schedules', 'templates'] }),
      queryClient.invalidateQueries({ queryKey: ['schedules', 'category-assignments'] }),
      queryClient.invalidateQueries({ queryKey: ['work-categories'] }),
    ]);
  };

  const shiftHours = useMemo(
    () => computeShiftHours(form.work_start, form.work_end),
    [form.work_start, form.work_end],
  );

  const shiftLabel = useMemo(() => formatHours(shiftHours), [shiftHours]);

  const netHoursLabel = useMemo(() => {
    const totalMinutes = Math.max(0, Math.round(shiftHours * 60 - form.lunch_minutes));
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }, [shiftHours, form.lunch_minutes]);

  const handleStartEdit = (tpl: IWorkSchedule) => {
    setForm({
      id: tpl.id,
      name: tpl.name,
      schedule_type: tpl.schedule_type,
      pattern_type: tpl.pattern_type,
      work_start: tpl.work_start.slice(0, 5),
      work_end: tpl.work_end.slice(0, 5),
      work_days: tpl.work_days,
      day_overrides: buildDayOverrideDrafts(tpl.day_overrides),
      lunch_minutes: tpl.lunch_minutes,
      respects_holidays: tpl.respects_holidays,
      expected_saturdays_per_month: tpl.expected_saturdays_per_month,
      late_threshold_minutes: tpl.late_threshold_minutes,
      full_day_threshold: minutesToHM(tpl.full_day_threshold_minutes),
      weekend_full_day_threshold: minutesToHM(tpl.weekend_full_day_threshold_minutes),
    });
    setShowForm(true);
  };

  const handleStartCreate = () => {
    setForm(createEmptyForm());
    setShowForm(true);
  };

  const handlePatternChange = (pattern: PatternType) => {
    setForm(f => {
      const preset = PATTERN_PRESETS[pattern];
      const nextWorkDays = preset.work_days ?? f.work_days;
      const nextDayOverrides = Object.fromEntries(
        Object.entries(f.day_overrides).filter(([day]) => nextWorkDays.includes(Number(day))),
      ) as Partial<Record<number, Pick<IDayOverride, 'work_start' | 'work_end'>>>;
      return { ...f, pattern_type: pattern, ...preset, work_days: nextWorkDays, day_overrides: nextDayOverrides };
    });
  };

  const toggleWorkDay = (day: number) => {
    setForm(f => {
      const has = f.work_days.includes(day);
      const next = has ? f.work_days.filter(d => d !== day) : [...f.work_days, day].sort();
      if (next.length === 0) return f;
      const nextDayOverrides = { ...f.day_overrides };
      if (has) delete nextDayOverrides[day];
      return { ...f, work_days: next, day_overrides: nextDayOverrides };
    });
  };

  const toggleDayOverride = (day: number) => {
    setForm(f => {
      const nextDayOverrides = { ...f.day_overrides };
      if (nextDayOverrides[day]) {
        delete nextDayOverrides[day];
      } else {
        nextDayOverrides[day] = {
          work_start: f.work_start,
          work_end: f.work_end,
        };
      }
      return { ...f, day_overrides: nextDayOverrides };
    });
  };

  const updateDayOverride = (day: number, field: 'work_start' | 'work_end', value: string) => {
    setForm(f => ({
      ...f,
      day_overrides: {
        ...f.day_overrides,
        [day]: {
          work_start: f.day_overrides[day]?.work_start ?? f.work_start,
          work_end: f.day_overrides[day]?.work_end ?? f.work_end,
          [field]: value,
        },
      },
    }));
  };

  const handleSave = async () => {
    setError('');
    try {
      const computedHours = computeShiftHours(form.work_start, form.work_end);
      if (computedHours <= 0) {
        setError('Некорректное время начала/конца смены');
        return;
      }
      const fullDayMin = form.full_day_threshold ? parseHMToMinutes(form.full_day_threshold) : null;
      if (form.full_day_threshold && fullDayMin === null) {
        setError('Порог полного дня: формат ЧЧ:ММ');
        return;
      }
      const weekendFullDayMin = form.weekend_full_day_threshold
        ? parseHMToMinutes(form.weekend_full_day_threshold)
        : null;
      if (form.weekend_full_day_threshold && weekendFullDayMin === null) {
        setError('Порог полного дня (выходной): формат ЧЧ:ММ');
        return;
      }
      const dayOverridesPayload: Record<string, IDayOverride> = {};
      for (const day of form.work_days) {
        const override = form.day_overrides[day];
        if (!override) continue;
        const overrideHours = computeShiftHours(override.work_start, override.work_end);
        if (overrideHours <= 0) {
          setError(`Некорректное время для дня ${WEEKDAY_LABELS[day - 1]}`);
          return;
        }
        if (override.work_start === form.work_start && override.work_end === form.work_end) {
          continue;
        }
        dayOverridesPayload[String(day)] = {
          work_start: override.work_start,
          work_end: override.work_end,
          work_hours: Number(overrideHours.toFixed(4)),
        };
      }
      const payload = {
        name: form.name.trim(),
        schedule_type: form.schedule_type,
        pattern_type: form.pattern_type,
        work_start: form.work_start,
        work_end: form.work_end,
        work_hours: Number(computedHours.toFixed(4)),
        work_days: form.work_days,
        office_days: null,
        day_overrides: Object.keys(dayOverridesPayload).length > 0 ? dayOverridesPayload : null,
        lunch_minutes: form.lunch_minutes,
        respects_holidays: form.respects_holidays,
        expected_saturdays_per_month: form.expected_saturdays_per_month,
        late_threshold_minutes: form.late_threshold_minutes,
        full_day_threshold_minutes: fullDayMin,
        weekend_full_day_threshold_minutes: weekendFullDayMin,
      };
      if (!payload.name) {
        setError('Название обязательно');
        return;
      }
      if (form.id) {
        await scheduleService.update(form.id, payload);
      } else {
        await scheduleService.create(payload);
      }
      setShowForm(false);
      setForm(createEmptyForm());
      await reloadScheduleData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить шаблон?')) return;
    setError('');
    try {
      await scheduleService.remove(id);
      await reloadScheduleData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  };

  // Для каждой активной категории — текущее назначение на сегодня
  const activeAssignments = useMemo(() => {
    const map = new Map<string, ICategorySchedule | null>();
    for (const cat of workCategories.filter(c => c.is_active)) {
      const active = assignments.find(a => a.category === cat.code && isActiveScheduleAssignment(a.effective_from, a.effective_to, today)) || null;
      map.set(cat.code, active);
    }
    return map;
  }, [workCategories, assignments, today]);

  const handleAssignCategory = async (category: string, scheduleId: string) => {
    setError('');
    try {
      if (!scheduleId) {
        await scheduleService.removeCategoryAssignment(category);
      } else {
        await scheduleService.assignCategory(category, {
          schedule_id: scheduleId,
          effective_from: today,
        });
      }
      await reloadScheduleData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка назначения');
    }
  };

  /* ─── CRUD категорий ─── */

  const handleStartCreateCategory = () => {
    setEditingCategoryCode(null);
    setCategoryForm({ code: '', name: '', description: '', sort_order: workCategories.length * 10 + 10 });
    setShowCategoryForm(true);
  };

  const handleStartEditCategory = (cat: IWorkCategory) => {
    setEditingCategoryCode(cat.code);
    setCategoryForm({
      code: cat.code,
      name: cat.name,
      description: cat.description || '',
      sort_order: cat.sort_order,
    });
    setShowCategoryForm(true);
  };

  const handleSaveCategory = async () => {
    setError('');
    try {
      const code = categoryForm.code.trim().toLowerCase();
      const name = categoryForm.name.trim();
      if (!name) {
        setError('Название обязательно');
        return;
      }
      if (!/^[a-z0-9_]+$/.test(code)) {
        setError('Код: только a-z, 0-9, _');
        return;
      }
      if (editingCategoryCode) {
        const payload: { code?: string; name: string; description: string | null; sort_order: number } = {
          name,
          description: categoryForm.description || null,
          sort_order: categoryForm.sort_order,
        };
        if (code !== editingCategoryCode) payload.code = code;
        await workCategoryService.update(editingCategoryCode, payload);
      } else {
        await workCategoryService.create({
          code,
          name,
          description: categoryForm.description || null,
          sort_order: categoryForm.sort_order,
        });
      }
      setShowCategoryForm(false);
      setEditingCategoryCode(null);
      await reloadScheduleData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  };

  const handleDeleteCategory = async (code: string) => {
    if (!confirm('Удалить категорию?')) return;
    setError('');
    try {
      await workCategoryService.remove(code);
      await reloadScheduleData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>Графики работы</h2>
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'templates' ? styles.tabActive : ''}`}
          onClick={() => setTab('templates')}
        >
          Шаблоны графиков
        </button>
        <button
          className={`${styles.tab} ${tab === 'category-manage' ? styles.tabActive : ''}`}
          onClick={() => setTab('category-manage')}
        >
          Категории труда
        </button>
        <button
          className={`${styles.tab} ${tab === 'category-assignments' ? styles.tabActive : ''}`}
          onClick={() => setTab('category-assignments')}
        >
          Привязка графиков к категориям
        </button>
        <button
          className={`${styles.tab} ${tab === 'production-calendar' ? styles.tabActive : ''}`}
          onClick={() => setTab('production-calendar')}
        >
          Производственный календарь
        </button>
      </div>

      {visibleError && <div className={styles.error}>{visibleError}</div>}

      {tab === 'templates' && (
        <>
          <div className={styles.toolbar}>
            <button className={styles.btn} onClick={handleStartCreate}>
              + Новый шаблон
            </button>
          </div>

          {showForm && (
            <div className={styles.form}>
              <label>
                Название
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="ИТР 5+2"
                />
              </label>
              <label>
                Паттерн
                <select
                  value={form.pattern_type}
                  onChange={e => handlePatternChange(e.target.value as PatternType)}
                >
                  {(Object.keys(PATTERN_TYPE_LABELS) as PatternType[]).map(p => (
                    <option key={p} value={p}>
                      {PATTERN_TYPE_LABELS[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Тип работы
                <select
                  value={form.schedule_type}
                  onChange={e => setForm({ ...form, schedule_type: e.target.value as ScheduleType })}
                >
                  {(Object.keys(SCHEDULE_TYPE_LABELS) as ScheduleType[]).map(t => (
                    <option key={t} value={t}>
                      {SCHEDULE_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Начало смены
                <input
                  type="time"
                  value={form.work_start}
                  onChange={e => setForm({ ...form, work_start: e.target.value })}
                />
              </label>
              <label>
                Конец смены
                <input
                  type="time"
                  value={form.work_end}
                  onChange={e => setForm({ ...form, work_end: e.target.value })}
                />
              </label>
              <label>
                Длина смены (с обедом)
                <input type="text" value={shiftLabel} readOnly />
              </label>
              <label>
                Обед (минут)
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={form.lunch_minutes}
                  onChange={e => setForm({ ...form, lunch_minutes: parseInt(e.target.value) || 0 })}
                />
              </label>
              <label>
                Ожидаемые рабочие субботы в месяц
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={form.expected_saturdays_per_month}
                  onChange={e =>
                    setForm({ ...form, expected_saturdays_per_month: parseInt(e.target.value) || 0 })
                  }
                  disabled={form.pattern_type !== '5+2' && form.pattern_type !== 'custom'}
                />
              </label>
              <label>
                Порог опоздания (минут)
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={form.late_threshold_minutes}
                  onChange={e =>
                    setForm({ ...form, late_threshold_minutes: parseInt(e.target.value) || 0 })
                  }
                />
              </label>
              <label title="Ниже этого значения день считается недоработкой (жёлтый), выше — полный день (зелёный). Пусто = чистое время смены (без обеда).">
                Порог полного дня (ЧЧ:ММ)
                <input
                  type="time"
                  value={form.full_day_threshold}
                  onChange={e => setForm({ ...form, full_day_threshold: e.target.value })}
                  placeholder="авто"
                />
              </label>
              <label title="Порог для дней, когда сотрудник вышел в выходной. Пусто = использовать обычный порог.">
                Порог полного дня, выходной (ЧЧ:ММ)
                <input
                  type="time"
                  value={form.weekend_full_day_threshold}
                  onChange={e => setForm({ ...form, weekend_full_day_threshold: e.target.value })}
                  placeholder="авто"
                />
              </label>
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Рабочие дни
                </div>
                <div className={styles.daysRow}>
                  {WEEKDAY_LABELS.map((label, idx) => {
                    const day = idx + 1;
                    const active = form.work_days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        className={`${styles.dayBtn} ${active ? styles.dayBtnActive : ''}`}
                        onClick={() => toggleWorkDay(day)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className={styles.dayOverridesSection}>
                <div className={styles.sectionTitle}>Детальная настройка по дням</div>
                <div className={styles.sectionHint}>
                  Если, например, в пятницу короткий день, включите для пятницы своё время и задайте
                  отдельное окончание смены.
                </div>
                <div className={styles.dayOverridesGrid}>
                  {form.work_days.map(day => {
                    const override = form.day_overrides[day];
                    const dayStart = override?.work_start ?? form.work_start;
                    const dayEnd = override?.work_end ?? form.work_end;
                    const dayShiftHours = computeShiftHours(dayStart, dayEnd);
                    const dayNetHours = formatMinutes(dayShiftHours * 60 - form.lunch_minutes);
                    return (
                      <div key={day} className={styles.dayOverrideCard}>
                        <div className={styles.dayOverrideHeader}>
                          <div>
                            <div className={styles.dayOverrideTitle}>{WEEKDAY_LABELS[day - 1]}</div>
                            <div className={styles.dayOverrideMeta}>
                              {override ? 'Индивидуальное расписание' : `Общий график ${form.work_start}-${form.work_end}`}
                            </div>
                          </div>
                          <label className={styles.dayOverrideToggle}>
                            <input
                              type="checkbox"
                              checked={Boolean(override)}
                              onChange={() => toggleDayOverride(day)}
                            />
                            Своё время
                          </label>
                        </div>

                        {override ? (
                          <div className={styles.dayOverrideFields}>
                            <label>
                              Начало
                              <input
                                type="time"
                                value={dayStart}
                                onChange={e => updateDayOverride(day, 'work_start', e.target.value)}
                              />
                            </label>
                            <label>
                              Конец
                              <input
                                type="time"
                                value={dayEnd}
                                onChange={e => updateDayOverride(day, 'work_end', e.target.value)}
                              />
                            </label>
                            <label>
                              Длина смены
                              <input type="text" value={formatHours(dayShiftHours)} readOnly />
                            </label>
                          </div>
                        ) : (
                          <div className={styles.dayOverrideSummary}>
                            Наследует общий график: {form.work_start}-{form.work_end}, смена {shiftLabel}
                          </div>
                        )}

                        <div className={styles.dayOverrideSummary}>
                          Чистое рабочее время: <strong>{dayNetHours}</strong>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <label className={styles.checkboxRow} style={{ gridColumn: '1 / -1' }}>
                <input
                  type="checkbox"
                  checked={form.respects_holidays}
                  onChange={e => setForm({ ...form, respects_holidays: e.target.checked })}
                />
                Учитывать праздники РФ (из производственного календаря)
              </label>
              <div className={styles.hint}>
                Чистое рабочее время: <strong>{netHoursLabel}</strong> (длина смены − обед)
              </div>
              <div className={styles.actions}>
                <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setShowForm(false)}>
                  Отмена
                </button>
                <button className={styles.btn} onClick={handleSave}>
                  Сохранить
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div>Загрузка...</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Паттерн</th>
                  <th>Смена</th>
                  <th>Обед</th>
                  <th>Субботы</th>
                  <th>Праздники</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {templates.map(t => (
                  <tr key={t.id}>
                    <td>
                      {t.name}
                      {t.is_default && <span className={`${styles.badge} ${styles.badgeDefault}`} style={{ marginLeft: 8 }}>дефолт</span>}
                    </td>
                    <td>{PATTERN_TYPE_LABELS[t.pattern_type]}</td>
                    <td>
                      {t.work_start.slice(0, 5)}–{t.work_end.slice(0, 5)} ({formatHours(Number(t.work_hours))})
                      {t.day_overrides && (
                        <div className={styles.cellHint}>
                          Особые дни: {formatDayOverridesSummary(t.day_overrides)}
                        </div>
                      )}
                    </td>
                    <td>{t.lunch_minutes} мин</td>
                    <td>{t.expected_saturdays_per_month}</td>
                    <td>{t.respects_holidays ? 'учитывает' : 'игнорирует'}</td>
                    <td>
                      <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => handleStartEdit(t)}>
                        Ред.
                      </button>{' '}
                      <button
                        className={`${styles.btn} ${styles.btnDanger}`}
                        onClick={() => handleDelete(t.id)}
                        disabled={t.is_default}
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {tab === 'category-assignments' && (
        <>
          <div style={{ marginBottom: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
            Сотруднику без индивидуального графика и без графика отдела автоматически назначается
            график его категории труда. Категорию ставит администратор на странице «Управление
            кадрами», а сами категории создаются на вкладке «Категории труда».
          </div>
          {workCategories.filter(c => c.is_active).length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-secondary)' }}>
              Нет активных категорий труда. Создайте их на вкладке «Категории труда».
            </div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Категория</th>
                  <th>Текущий график</th>
                  <th>Действует с</th>
                  <th>Изменить</th>
                </tr>
              </thead>
              <tbody>
                {workCategories
                  .filter(c => c.is_active)
                  .map(cat => {
                    const assigned = activeAssignments.get(cat.code) || null;
                    const assignedSchedId = assigned?.schedule_id || '';
                    return (
                      <tr key={cat.code}>
                        <td>{cat.name}</td>
                        <td>
                          {assigned?.work_schedules?.name || (
                            <span style={{ color: 'var(--text-secondary)' }}>— не назначен —</span>
                          )}
                        </td>
                        <td>{assigned?.effective_from || '—'}</td>
                        <td>
                          <select
                            value={assignedSchedId}
                            onChange={e => handleAssignCategory(cat.code, e.target.value)}
                          >
                            <option value="">— снять —</option>
                            {templates.map(t => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </>
      )}

      {tab === 'category-manage' && (
        <>
          <div className={styles.toolbar}>
            <button className={styles.btn} onClick={handleStartCreateCategory}>
              + Новая категория
            </button>
          </div>

          {showCategoryForm && (
            <div className={styles.form}>
              <label>
                Код (латиница, без пробелов)
                <input
                  type="text"
                  value={categoryForm.code}
                  onChange={e => setCategoryForm({ ...categoryForm, code: e.target.value.toLowerCase() })}
                  placeholder="office_manager"
                />
              </label>
              <label>
                Название
                <input
                  type="text"
                  value={categoryForm.name}
                  onChange={e => setCategoryForm({ ...categoryForm, name: e.target.value })}
                  placeholder="Руководитель (офис)"
                />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Описание
                <input
                  type="text"
                  value={categoryForm.description}
                  onChange={e => setCategoryForm({ ...categoryForm, description: e.target.value })}
                  placeholder="Необязательно"
                />
              </label>
              <label>
                Сортировка
                <input
                  type="number"
                  value={categoryForm.sort_order}
                  onChange={e =>
                    setCategoryForm({ ...categoryForm, sort_order: parseInt(e.target.value) || 0 })
                  }
                />
              </label>
              <div className={styles.actions}>
                <button
                  className={`${styles.btn} ${styles.btnSecondary}`}
                  onClick={() => {
                    setShowCategoryForm(false);
                    setEditingCategoryCode(null);
                  }}
                >
                  Отмена
                </button>
                <button className={styles.btn} onClick={handleSaveCategory}>
                  Сохранить
                </button>
              </div>
            </div>
          )}

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Код</th>
                <th>Название</th>
                <th>Описание</th>
                <th>Сортировка</th>
                <th>Активна</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {workCategories.map(cat => (
                <tr key={cat.code}>
                  <td>
                    <code>{cat.code}</code>
                  </td>
                  <td>{cat.name}</td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                    {cat.description || '—'}
                  </td>
                  <td>{cat.sort_order}</td>
                  <td>{cat.is_active ? 'да' : 'нет'}</td>
                  <td>
                    <button
                      className={`${styles.btn} ${styles.btnSecondary}`}
                      onClick={() => handleStartEditCategory(cat)}
                    >
                      Ред.
                    </button>{' '}
                    <button
                      className={`${styles.btn} ${styles.btnDanger}`}
                      onClick={() => handleDeleteCategory(cat.code)}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === 'production-calendar' && (
        <Suspense fallback={<div>Загрузка производственного календаря...</div>}>
          <ProductionCalendarPage />
        </Suspense>
      )}
    </div>
  );
};
