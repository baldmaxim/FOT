import { Suspense, lazy, type FC, useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { scheduleService } from '../../services/scheduleService';
import { travelTimeService } from '../../services/travelTimeService';
import type {
  IDayOverride,
  ICycleDay,
  IWorkSchedule,
  IObjectScheduleAssignment,
  ScheduleType,
  PatternType,
} from '../../types/schedule';
import type { ITravelObject } from '../../types/travel';
import {
  PATTERN_TYPE_LABELS,
  WEEKDAY_LABELS,
} from '../../types/schedule';
import { parseHMToMinutes, minutesToHM } from '../../utils/scheduleUtils';
import styles from './SchedulesPage.module.css';

const ProductionCalendarPage = lazy(() => import('../super-admin/ProductionCalendarPage').then(module => ({
  default: module.ProductionCalendarPage,
})));

type TabKey = 'templates' | 'object-assignments' | 'production-calendar';

/** UI-представление дня цикла. Все поля — строки (HH:MM/число) для удобства редактирования. */
interface ICycleDayDraft {
  is_work: boolean;
  work_start: string;
  work_end: string;
  lunch_minutes: number;
}

interface IFormState {
  id: string | null;
  name: string;
  /**
   * Загруженный из БД schedule_type. Нужен, чтобы при сохранении немодифицированного
   * существующего шаблона (например, hybrid-legacy) не подменять тип. UI-уровневое
   * различие сводится к чекбоксу is_remote — см. handleSave.
   */
  loaded_schedule_type: ScheduleType | null;
  is_remote: boolean;
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
  cycle_length: number;                // длина цикла (актуально при pattern_type='cycle')
  cycle_days: ICycleDayDraft[];        // массив длиной cycle_length
  anchor_date: string;                 // YYYY-MM-DD, актуально при pattern_type='cycle'
}

const makeDefaultCycleDay = (isWork: boolean): ICycleDayDraft => ({
  is_work: isWork,
  work_start: '08:00',
  work_end: '20:00',
  lunch_minutes: 60,
});

const buildCycleDaysOfLength = (
  length: number,
  template: ICycleDayDraft[] = [],
): ICycleDayDraft[] => {
  const result: ICycleDayDraft[] = [];
  for (let i = 0; i < length; i++) {
    result.push(template[i] ?? makeDefaultCycleDay(i < Math.ceil(length / 2)));
  }
  return result;
};

const EMPTY_FORM: IFormState = {
  id: null,
  name: '',
  loaded_schedule_type: null,
  is_remote: false,
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
  cycle_length: 4,
  cycle_days: buildCycleDaysOfLength(4),
  anchor_date: '',
};

const createEmptyForm = (): IFormState => ({
  ...EMPTY_FORM,
  work_days: [...EMPTY_FORM.work_days],
  day_overrides: {},
  cycle_days: buildCycleDaysOfLength(EMPTY_FORM.cycle_length),
  anchor_date: getLocalISODate(),
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
  effectiveFrom <= date && (effectiveTo === null || effectiveTo >= date);

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
  // Циклические графики: вахта/смена обычно работает в праздники.
  // schedule_type для cycle вычисляется в handleSave (всегда 'shift').
  'cycle': { respects_holidays: false, expected_saturdays_per_month: 0 },
};

const PATTERN_HINTS: Record<PatternType, string> = {
  '5+0': 'Пн–Пт по одному и тому же графику, выходные сб/вс',
  '5+2': 'Пн–Пт + N рабочих суббот в месяц (поле в «Дополнительно»)',
  '6+0': 'Пн–Сб, выходной только воскресенье',
  'custom': 'Произвольный набор дней недели — настраивается ниже',
  'cycle': 'Любой повторяющийся цикл: 2/2, сутки/трое, ночные смены',
};
const EMPTY_TEMPLATES: IWorkSchedule[] = [];
const EMPTY_OBJECT_ASSIGNMENTS: IObjectScheduleAssignment[] = [];
const EMPTY_TRAVEL_OBJECTS: ITravelObject[] = [];

export const SchedulesPage: FC = () => {
  const today = getLocalISODate();
  const queryClient = useQueryClient();
  const { isAdmin, canViewPage } = useAuth();
  // Менеджеру открыта только вкладка "Шаблоны графиков", если админ выдал
  // доступ к виртуальной странице /admin/schedules/templates без доступа
  // к /admin/schedules (управляется в матрице ролей → «Технические доступы»).
  const templatesOnly = !isAdmin && !canViewPage('/admin/schedules') && canViewPage('/admin/schedules/templates');
  const [tab, setTab] = useState<TabKey>('templates');
  useEffect(() => {
    if (templatesOnly && tab !== 'templates') setTab('templates');
  }, [templatesOnly, tab]);
  const [error, setError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<IFormState>(createEmptyForm());
  // По дефолту блок «Особые дни недели» скрыт. Открывается при редактировании
  // шаблона с уже настроенными day_overrides (см. handleStartEdit) или вручную.
  const [showOverrides, setShowOverrides] = useState(false);

  const needsTemplates = tab === 'templates' || tab === 'object-assignments';
  const needsObjectAssignments = tab === 'object-assignments';
  const needsObjects = tab === 'object-assignments';

  const templatesQuery = useQuery({
    queryKey: ['schedules', 'templates'],
    queryFn: () => scheduleService.list(),
    enabled: needsTemplates,
    staleTime: 5 * 60_000,
    placeholderData: previousData => previousData,
  });
  const objectAssignmentsQuery = useQuery({
    queryKey: ['schedules', 'object-assignments'],
    queryFn: () => scheduleService.listObjectAssignments(),
    enabled: needsObjectAssignments,
    staleTime: 5 * 60_000,
    placeholderData: previousData => previousData,
  });
  const objectsQuery = useQuery({
    queryKey: ['travel-objects'],
    queryFn: () => travelTimeService.getObjects(),
    enabled: needsObjects,
    staleTime: 5 * 60_000,
    placeholderData: previousData => previousData,
  });
  const templates = templatesQuery.data ?? EMPTY_TEMPLATES;
  const objectAssignments = objectAssignmentsQuery.data ?? EMPTY_OBJECT_ASSIGNMENTS;
  const travelObjects = objectsQuery.data ?? EMPTY_TRAVEL_OBJECTS;
  const loading = (
    (needsTemplates && templatesQuery.isPending)
    || (needsObjectAssignments && objectAssignmentsQuery.isPending)
    || (needsObjects && objectsQuery.isPending)
  );
  const queryError = (
    (needsTemplates ? templatesQuery.error : null)
    || (needsObjectAssignments ? objectAssignmentsQuery.error : null)
    || (needsObjects ? objectsQuery.error : null)
  );
  const visibleError = error || (queryError instanceof Error ? queryError.message : '');

  const reloadScheduleData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['schedules', 'templates'] }),
      queryClient.invalidateQueries({ queryKey: ['schedules', 'object-assignments'] }),
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
    const cycleLength = tpl.cycle_length ?? EMPTY_FORM.cycle_length;
    const cycleDaysFromTpl: ICycleDayDraft[] = (tpl.cycle_days ?? []).map((slot) => ({
      is_work: slot.work_hours > 0,
      work_start: (slot.work_start ?? '08:00').slice(0, 5),
      work_end: (slot.work_end ?? '20:00').slice(0, 5),
      lunch_minutes: slot.lunch_minutes ?? 0,
    }));
    setForm({
      id: tpl.id,
      name: tpl.name,
      loaded_schedule_type: tpl.schedule_type,
      is_remote: tpl.schedule_type === 'remote',
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
      cycle_length: cycleLength,
      cycle_days: buildCycleDaysOfLength(cycleLength, cycleDaysFromTpl),
      anchor_date: tpl.anchor_date ?? getLocalISODate(),
    });
    setShowOverrides(Boolean(tpl.day_overrides && Object.keys(tpl.day_overrides).length > 0));
    setShowForm(true);
  };

  const handleStartCreate = () => {
    setForm(createEmptyForm());
    setShowOverrides(false);
    setShowForm(true);
  };

  const handlePatternChange = (pattern: PatternType) => {
    setForm(f => {
      const preset = PATTERN_PRESETS[pattern];
      const nextWorkDays = preset.work_days ?? f.work_days;
      const nextDayOverrides = Object.fromEntries(
        Object.entries(f.day_overrides).filter(([day]) => nextWorkDays.includes(Number(day))),
      ) as Partial<Record<number, Pick<IDayOverride, 'work_start' | 'work_end'>>>;
      const next: IFormState = {
        ...f,
        ...preset,
        pattern_type: pattern,
        work_days: nextWorkDays,
        day_overrides: nextDayOverrides,
      };
      // При первом переключении на cycle — гарантировать наличие массива дней и якоря.
      if (pattern === 'cycle') {
        if (!next.anchor_date) next.anchor_date = getLocalISODate();
        next.cycle_days = buildCycleDaysOfLength(next.cycle_length, f.cycle_days);
      }
      return next;
    });
  };

  const handleCycleLengthChange = (rawLength: number) => {
    const length = Math.max(2, Math.min(28, Math.floor(rawLength) || 2));
    setForm(f => ({
      ...f,
      cycle_length: length,
      cycle_days: buildCycleDaysOfLength(length, f.cycle_days),
    }));
  };

  const updateCycleDay = (
    index: number,
    patch: Partial<ICycleDayDraft>,
  ): void => {
    setForm(f => ({
      ...f,
      cycle_days: f.cycle_days.map((day, idx) => (idx === index ? { ...day, ...patch } : day)),
    }));
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
      const isCycle = form.pattern_type === 'cycle';
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

      let cyclePayload: { cycle_length: number; cycle_days: ICycleDay[]; anchor_date: string } | null = null;
      let workStartForPayload = form.work_start;
      let workEndForPayload = form.work_end;
      let workDaysForPayload: number[] = form.work_days;
      let dayOverridesPayload: Record<string, IDayOverride> | null = null;
      let netHours = 0;

      if (isCycle) {
        if (!form.anchor_date) {
          setError('Укажите дату-якорь цикла');
          return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(form.anchor_date)) {
          setError('Дата-якорь: формат YYYY-MM-DD');
          return;
        }
        if (form.cycle_length < 2 || form.cycle_length > 28) {
          setError('Длина цикла должна быть от 2 до 28 дней');
          return;
        }
        if (form.cycle_days.length !== form.cycle_length) {
          setError('Дни цикла не соответствуют его длине');
          return;
        }
        const cycleDaysOut: ICycleDay[] = [];
        for (let i = 0; i < form.cycle_days.length; i++) {
          const draft = form.cycle_days[i];
          if (!draft.is_work) {
            cycleDaysOut.push({ work_hours: 0 });
            continue;
          }
          const shiftH = computeShiftHours(draft.work_start, draft.work_end);
          if (shiftH <= 0) {
            setError(`Некорректное время в дне цикла № ${i + 1}`);
            return;
          }
          const lunchH = (draft.lunch_minutes || 0) / 60;
          const netH = Math.max(0, shiftH - lunchH);
          cycleDaysOut.push({
            work_hours: Number(netH.toFixed(4)),
            work_start: draft.work_start,
            work_end: draft.work_end,
            lunch_minutes: draft.lunch_minutes,
          });
        }
        cyclePayload = {
          cycle_length: form.cycle_length,
          cycle_days: cycleDaysOut,
          anchor_date: form.anchor_date,
        };
        // Глобальные work_start/work_end/work_days для cycle не используются резолвером,
        // но колонки NOT NULL — кладём первый рабочий слот цикла или дефолт.
        const firstWorkSlot = cycleDaysOut.find(s => s.work_hours > 0);
        if (firstWorkSlot) {
          workStartForPayload = firstWorkSlot.work_start ?? form.work_start;
          workEndForPayload = firstWorkSlot.work_end ?? form.work_end;
          netHours = firstWorkSlot.work_hours;
        } else {
          netHours = 0;
        }
        workDaysForPayload = [1, 2, 3, 4, 5];
      } else {
        const computedHours = computeShiftHours(form.work_start, form.work_end);
        if (computedHours <= 0) {
          setError('Некорректное время начала/конца смены');
          return;
        }
        const lunchHours = (form.lunch_minutes || 0) / 60;
        netHours = Math.max(0, computedHours - lunchHours);
        const overridesAcc: Record<string, IDayOverride> = {};
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
          const overrideNetHours = Math.max(0, overrideHours - lunchHours);
          overridesAcc[String(day)] = {
            work_start: override.work_start,
            work_end: override.work_end,
            work_hours: Number(overrideNetHours.toFixed(4)),
          };
        }
        if (Object.keys(overridesAcc).length > 0) dayOverridesPayload = overridesAcc;
      }

      // schedule_type: для cycle всегда 'shift'; для не-cycle — 'remote' если is_remote,
      // иначе сохраняем загруженный тип (office/hybrid/shift). Это защищает legacy-шаблоны
      // hybrid/shift от случайной подмены, если пользователь только переименовал/поменял время.
      const computedScheduleType: ScheduleType = isCycle
        ? 'shift'
        : form.is_remote
          ? 'remote'
          : (form.loaded_schedule_type && form.loaded_schedule_type !== 'remote'
            ? form.loaded_schedule_type
            : 'office');

      const payload = {
        name: form.name.trim(),
        schedule_type: computedScheduleType,
        pattern_type: form.pattern_type,
        work_start: workStartForPayload,
        work_end: workEndForPayload,
        work_hours: Number(netHours.toFixed(4)),
        work_days: workDaysForPayload,
        office_days: null,
        day_overrides: dayOverridesPayload,
        lunch_minutes: form.lunch_minutes,
        respects_holidays: form.respects_holidays,
        expected_saturdays_per_month: form.expected_saturdays_per_month,
        late_threshold_minutes: form.late_threshold_minutes,
        full_day_threshold_minutes: fullDayMin,
        weekend_full_day_threshold_minutes: weekendFullDayMin,
        cycle_length: cyclePayload?.cycle_length ?? null,
        cycle_days: cyclePayload?.cycle_days ?? null,
        anchor_date: cyclePayload?.anchor_date ?? null,
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

  const activeObjectAssignments = useMemo(() => {
    const map = new Map<string, IObjectScheduleAssignment | null>();
    for (const objectItem of travelObjects) {
      const active = objectAssignments.find(assignment => (
        assignment.object_id === objectItem.id
        && isActiveScheduleAssignment(assignment.effective_from, assignment.effective_to, today)
      )) || null;
      map.set(objectItem.id, active);
    }
    return map;
  }, [travelObjects, objectAssignments, today]);

  const handleAssignObject = async (objectId: string, scheduleId: string) => {
    setError('');
    try {
      if (!scheduleId) {
        await scheduleService.removeObjectAssignment(objectId);
      } else {
        await scheduleService.assignObject(objectId, {
          schedule_id: scheduleId,
          effective_from: today,
        });
      }
      await reloadScheduleData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка назначения графика объекту');
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'templates' ? styles.tabActive : ''}`}
          onClick={() => setTab('templates')}
        >
          Шаблоны графиков
        </button>
        {!templatesOnly && (
          <button
            className={`${styles.tab} ${tab === 'object-assignments' ? styles.tabActive : ''}`}
            onClick={() => setTab('object-assignments')}
          >
            Графики объектов
          </button>
        )}
        {!templatesOnly && (
          <button
            className={`${styles.tab} ${tab === 'production-calendar' ? styles.tabActive : ''}`}
            onClick={() => setTab('production-calendar')}
          >
            Производственный календарь
          </button>
        )}
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
              {/* ─── Секция «Основное» ───────────────────────────────── */}
              <section className={styles.formSection}>
                <div className={styles.sectionTitle}>Основное</div>
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
                <div className={styles.patternHint}>{PATTERN_HINTS[form.pattern_type]}</div>
                <label className={styles.checkboxRow} title="Сотрудник работает удалённо — СКУД-проверка отключена для этого графика.">
                  <input
                    type="checkbox"
                    checked={form.is_remote}
                    onChange={e => setForm({ ...form, is_remote: e.target.checked })}
                  />
                  Удалённая работа (без СКУД-контроля)
                </label>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={form.respects_holidays}
                    onChange={e => setForm({ ...form, respects_holidays: e.target.checked })}
                  />
                  Учитывать праздники РФ (из производственного календаря)
                </label>
              </section>

              {/* ─── Секция «Время работы» ──────────────────────────────── */}
              <section className={styles.formSection}>
                <div className={styles.sectionTitle}>Время работы</div>

                {form.pattern_type !== 'cycle' && (
                  <>
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
                      Чистое рабочее время
                      <input type="text" value={netHoursLabel} readOnly />
                    </label>
                    <div className={styles.patternHint}>
                      Длина смены: {shiftLabel}. Чистое = смена − обед.
                    </div>

                    {form.pattern_type === 'custom' && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                          Рабочие дни недели
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
                    )}

                    <div style={{ gridColumn: '1 / -1' }}>
                      <button
                        type="button"
                        className={styles.toggleLink}
                        onClick={() => setShowOverrides(v => !v)}
                      >
                        {showOverrides ? '▾ Особые дни недели' : '▸ Особые дни недели (короткая пятница и т.п.)'}
                      </button>
                    </div>

                    {showOverrides && (
                      <div className={styles.dayOverridesSection}>
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
                    )}
                  </>
                )}

                {form.pattern_type === 'cycle' && (
                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div className={styles.sectionHint}>
                      Цикл повторяется бесконечно от даты-якоря. Для каждого дня цикла укажите,
                      рабочий он или выходной, и время смены. Подходит для графиков «2 через 2», «сутки/трое», ночных смен.
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '160px 200px', columnGap: 16, rowGap: 8, alignItems: 'center' }}>
                      <label style={{ margin: 0 }}>
                        Длина цикла (дней)
                        <input
                          type="number"
                          min={2}
                          max={28}
                          value={form.cycle_length}
                          onChange={e => handleCycleLengthChange(parseInt(e.target.value) || 0)}
                        />
                      </label>
                      <label style={{ margin: 0 }} title="Дата, с которой начинается отсчёт первого дня цикла">
                        Дата-якорь
                        <input
                          type="date"
                          value={form.anchor_date}
                          onChange={e => setForm({ ...form, anchor_date: e.target.value })}
                        />
                      </label>
                    </div>
                    <div className={styles.dayOverridesGrid}>
                      {form.cycle_days.map((slot, index) => {
                        const slotShiftHours = slot.is_work
                          ? computeShiftHours(slot.work_start, slot.work_end)
                          : 0;
                        const slotNetHours = slot.is_work
                          ? formatMinutes(slotShiftHours * 60 - (slot.lunch_minutes || 0))
                          : '0:00';
                        return (
                          <div key={index} className={styles.dayOverrideCard}>
                            <div className={styles.dayOverrideHeader}>
                              <div>
                                <div className={styles.dayOverrideTitle}>День {index + 1}</div>
                                <div className={styles.dayOverrideMeta}>
                                  {slot.is_work ? `Рабочий ${slot.work_start}-${slot.work_end}` : 'Выходной'}
                                </div>
                              </div>
                              <label className={styles.dayOverrideToggle}>
                                <input
                                  type="checkbox"
                                  checked={slot.is_work}
                                  onChange={e => updateCycleDay(index, { is_work: e.target.checked })}
                                />
                                Рабочий
                              </label>
                            </div>
                            {slot.is_work ? (
                              <div className={styles.dayOverrideFields}>
                                <label>
                                  Начало
                                  <input
                                    type="time"
                                    value={slot.work_start}
                                    onChange={e => updateCycleDay(index, { work_start: e.target.value })}
                                  />
                                </label>
                                <label>
                                  Конец
                                  <input
                                    type="time"
                                    value={slot.work_end}
                                    onChange={e => updateCycleDay(index, { work_end: e.target.value })}
                                  />
                                </label>
                                <label>
                                  Обед (мин)
                                  <input
                                    type="number"
                                    min={0}
                                    max={240}
                                    value={slot.lunch_minutes}
                                    onChange={e => updateCycleDay(index, { lunch_minutes: parseInt(e.target.value) || 0 })}
                                  />
                                </label>
                                <label>
                                  Длина смены
                                  <input type="text" value={formatHours(slotShiftHours)} readOnly />
                                </label>
                              </div>
                            ) : null}
                            <div className={styles.dayOverrideSummary}>
                              Чистое рабочее время: <strong>{slotNetHours}</strong>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {form.anchor_date && form.cycle_days.length === form.cycle_length && (
                      <div className={styles.sectionHint}>
                        Превью на 14 дней от {form.anchor_date}:{' '}
                        {(() => {
                          const anchor = new Date(`${form.anchor_date}T00:00:00`);
                          if (isNaN(anchor.getTime())) return '—';
                          return Array.from({ length: 14 }).map((_, dayShift) => {
                            const d = new Date(anchor.getTime());
                            d.setDate(d.getDate() + dayShift);
                            const idx = ((dayShift % form.cycle_length) + form.cycle_length) % form.cycle_length;
                            const slot = form.cycle_days[idx];
                            const dd = String(d.getDate()).padStart(2, '0');
                            const mm = String(d.getMonth() + 1).padStart(2, '0');
                            return (
                              <span
                                key={dayShift}
                                style={{
                                  display: 'inline-block',
                                  padding: '2px 6px',
                                  marginRight: 4,
                                  marginBottom: 4,
                                  borderRadius: 4,
                                  background: slot?.is_work ? 'var(--primary-light)' : 'var(--surface-hover)',
                                  color: 'var(--text-primary)',
                                  fontSize: 12,
                                }}
                                title={slot?.is_work ? `Рабочий ${slot.work_start}-${slot.work_end}` : 'Выходной'}
                              >
                                {dd}.{mm}
                              </span>
                            );
                          });
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* ─── Секция «Дополнительно» (свёрнута по умолчанию) ───── */}
              <details className={styles.formAdvanced}>
                <summary>Дополнительные параметры (пороги, особые случаи)</summary>
                <div className={styles.formAdvancedGrid}>
                  <label title="Сколько минут после начала смены не считать опозданием.">
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
                  {(form.pattern_type === '5+2' || form.pattern_type === 'custom') && (
                    <label title="Сколько суббот в месяце считаются рабочими по умолчанию для паттерна 5+2.">
                      Ожидаемые рабочие субботы в месяц
                      <input
                        type="number"
                        min={0}
                        max={5}
                        value={form.expected_saturdays_per_month}
                        onChange={e =>
                          setForm({ ...form, expected_saturdays_per_month: parseInt(e.target.value) || 0 })
                        }
                      />
                    </label>
                  )}
                </div>
              </details>

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
                    <td>
                      {PATTERN_TYPE_LABELS[t.pattern_type]}
                      {t.pattern_type === 'cycle' && t.cycle_length != null && t.cycle_days && (
                        <div className={styles.cellHint}>
                          {t.cycle_length}д: {t.cycle_days.map(s => Math.round(s.work_hours)).join('/')}
                          {t.anchor_date ? `, якорь ${t.anchor_date}` : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      {t.pattern_type === 'cycle' ? (
                        <span style={{ color: 'var(--text-secondary)' }}>цикл</span>
                      ) : (
                        <>
                          {t.work_start.slice(0, 5)}–{t.work_end.slice(0, 5)} ({formatHours(Number(t.work_hours))})
                          {t.day_overrides && (
                            <div className={styles.cellHint}>
                              Особые дни: {formatDayOverridesSummary(t.day_overrides)}
                            </div>
                          )}
                        </>
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

      {tab === 'object-assignments' && (
        <>
          <div style={{ marginBottom: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
            Для объектных строк табеля сначала используется график, назначенный объекту. Если для
            объекта график не задан, система берёт график сотрудника по обычному каскаду
            назначений.
          </div>
          {travelObjects.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-secondary)' }}>
              Нет объектов SKUD. Сначала создайте их в разделе маршрутов и объектов.
            </div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Объект</th>
                  <th>Текущий график</th>
                  <th>Действует с</th>
                  <th>Изменить</th>
                </tr>
              </thead>
              <tbody>
                {travelObjects
                  .slice()
                  .sort((left, right) => left.name.localeCompare(right.name, 'ru'))
                  .map(objectItem => {
                    const assigned = activeObjectAssignments.get(objectItem.id) || null;
                    const assignedSchedId = assigned?.schedule_id || '';
                    return (
                      <tr key={objectItem.id}>
                        <td>
                          {objectItem.name}
                          {!objectItem.is_active && (
                            <span className={`${styles.badge}`} style={{ marginLeft: 8 }}>неактивен</span>
                          )}
                        </td>
                        <td>
                          {assigned?.work_schedules?.name || (
                            <span style={{ color: 'var(--text-secondary)' }}>— не назначен —</span>
                          )}
                        </td>
                        <td>{assigned?.effective_from || '—'}</td>
                        <td>
                          <select
                            value={assignedSchedId}
                            onChange={e => handleAssignObject(objectItem.id, e.target.value)}
                          >
                            <option value="">— снять —</option>
                            {templates.map(template => (
                              <option key={template.id} value={template.id}>
                                {template.name}
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

      {tab === 'production-calendar' && (
        <Suspense fallback={<div>Загрузка производственного календаря...</div>}>
          <ProductionCalendarPage />
        </Suspense>
      )}
    </div>
  );
};
