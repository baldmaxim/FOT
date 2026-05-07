import { Suspense, lazy, type FC, useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { scheduleService } from '../../services/scheduleService';
import { travelTimeService } from '../../services/travelTimeService';
import type {
  ICycleDay,
  IWorkSchedule,
  IObjectScheduleAssignment,
  ScheduleType,
  PatternType,
} from '../../types/schedule';
import type { ITravelObject } from '../../types/travel';
import { parseHMToMinutes, minutesToHM } from '../../utils/scheduleUtils';
import styles from './SchedulesPage.module.css';

const ProductionCalendarPage = lazy(() => import('../super-admin/ProductionCalendarPage').then(module => ({
  default: module.ProductionCalendarPage,
})));

type TabKey = 'templates' | 'object-assignments' | 'production-calendar';

/** Override времени для конкретного рабочего слота цикла (например, «пятница короче»). */
interface ISlotOverride {
  work_start: string;
  work_end: string;
  lunch_minutes: number;
}

/**
 * День произвольного цикла. Используется в режиме is_custom_cycle, где раскладка
 * рабочих/выходных не сводится к простому «N подряд → M подряд»
 * (например, двухнедельный цикл 6/1 → 5/2).
 */
interface ICustomDay {
  is_work: boolean;
  /** Если is_work=true и поле задано — слот переопределяет общее время. Иначе наследуется. */
  work_start: string;
  work_end: string;
  lunch_minutes: number;
  /** True = слот наследует общее время; false = у слота своё время. */
  inherits_base: boolean;
}

interface IFormState {
  id: string | null;
  name: string;
  /** Тип, как был в БД при загрузке. Нужен для понимания, конвертируется ли legacy-шаблон. */
  loaded_pattern_type: PatternType | null;
  /** Тип расписания из БД. Сохраняется как есть, если is_remote не менялся явно. */
  loaded_schedule_type: ScheduleType | null;
  is_remote: boolean;
  /**
   * Произвольный цикл: каждый день настраивается вручную (раб/вых + время).
   * Подходит для нерегулярных раскладок типа 6/1 → 5/2 или с выходными в середине цикла.
   * При false действует обычная модель «N через M».
   */
  is_custom_cycle: boolean;
  /** Массив дней произвольного цикла. Длина = эффективная cycle_length при is_custom_cycle=true. */
  custom_cycle_days: ICustomDay[];
  /** N: количество рабочих дней в цикле (используется при is_custom_cycle=false). */
  work_days_count: number;
  /** M: количество выходных дней в цикле (используется при is_custom_cycle=false). */
  off_days_count: number;
  /** Дата первого рабочего дня цикла (anchor). */
  anchor_date: string;
  /** Базовое время смены (для всех рабочих слотов кроме особых). */
  work_start: string;
  work_end: string;
  lunch_minutes: number;
  /** Особые рабочие дни цикла (для простой N/M-модели): ключ — индекс рабочего слота 0..N-1. */
  slot_overrides: Partial<Record<number, ISlotOverride>>;
  respects_holidays: boolean;
  late_threshold_minutes: number;
  full_day_threshold: string;          // "HH:MM", "" = авто (чистое время)
  weekend_full_day_threshold: string;  // "HH:MM", "" = авто (= full_day_threshold)
}

/** Создаёт массив дней произвольного цикла из «префиксного» N/M-вида. */
const buildCustomDaysFromPrefix = (
  workCount: number,
  offCount: number,
  baseStart: string,
  baseEnd: string,
  lunch: number,
  slotOverrides: Partial<Record<number, ISlotOverride>>,
): ICustomDay[] => {
  const out: ICustomDay[] = [];
  for (let i = 0; i < workCount; i++) {
    const ovr = slotOverrides[i];
    out.push({
      is_work: true,
      work_start: ovr?.work_start ?? baseStart,
      work_end: ovr?.work_end ?? baseEnd,
      lunch_minutes: ovr?.lunch_minutes ?? lunch,
      inherits_base: !ovr,
    });
  }
  for (let i = 0; i < offCount; i++) {
    out.push({
      is_work: false,
      work_start: baseStart,
      work_end: baseEnd,
      lunch_minutes: lunch,
      inherits_base: true,
    });
  }
  return out;
};

/** Ближайший понедельник (включая сегодня) к указанной дате. */
const nearestMondayOnOrBefore = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (dow - 1));
  return toISODateLocal(d);
};

const toISODateLocal = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const RHYTHM_PRESETS: Array<{ label: string; work: number; off: number }> = [
  { label: '5/2', work: 5, off: 2 },
  { label: '6/1', work: 6, off: 1 },
  { label: '2/2', work: 2, off: 2 },
  { label: '1/3', work: 1, off: 3 },
  { label: '4/2', work: 4, off: 2 },
];

const EMPTY_FORM: IFormState = {
  id: null,
  name: '',
  loaded_pattern_type: null,
  loaded_schedule_type: null,
  is_remote: false,
  is_custom_cycle: false,
  custom_cycle_days: [],
  work_days_count: 5,
  off_days_count: 2,
  anchor_date: '',
  work_start: '09:00',
  work_end: '18:00',
  lunch_minutes: 60,
  slot_overrides: {},
  respects_holidays: true,
  late_threshold_minutes: 0,
  full_day_threshold: '',
  weekend_full_day_threshold: '',
};

const createEmptyForm = (): IFormState => ({
  ...EMPTY_FORM,
  slot_overrides: {},
  custom_cycle_days: [],
  anchor_date: nearestMondayOnOrBefore(getLocalISODate()),
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

/**
 * Конвертирует загруженный из БД шаблон в N/M-вид формы.
 *
 * Поддерживает 3 случая:
 * 1. cycle: cycle_length/cycle_days/anchor_date берём напрямую; cycle_days анализируем
 *    на «префикс рабочих + суффикс выходных» — типичная вахтовая схема.
 *    Если последовательность не такая — открываем как N=count(work), M=count(off),
 *    с предупреждением (но в БД таких нет).
 * 2. legacy 5+0/5+2/6+0: work_days как непрерывный префикс недели
 *    (5+0=пн-пт, 6+0=пн-сб). Anchor = ближайший понедельник от today.
 *    day_overrides[dow] переводим в slot_overrides[dow-1] (понедельник=slot 0).
 * 3. legacy custom: пытаемся определить N как количество work_days и M=7−N. Если
 *    не получается — берём 5/2 как fallback.
 */
const tplToFormState = (tpl: IWorkSchedule, today: string): IFormState => {
  const baseStart = tpl.work_start.slice(0, 5);
  const baseEnd = tpl.work_end.slice(0, 5);
  const lunch = tpl.lunch_minutes;

  // 1) cycle
  if (tpl.pattern_type === 'cycle' && tpl.cycle_length && tpl.cycle_days) {
    const days = tpl.cycle_days;

    // Префиксная раскладка = работа..работа..выходной..выходной (без чередований внутри).
    // Если она такая — открываем в простом N/M режиме. Иначе — в произвольном.
    let prefixWork = 0;
    while (prefixWork < days.length && days[prefixWork].work_hours > 0) prefixWork++;
    const isPrefix = days.slice(prefixWork).every(d => d.work_hours <= 0);

    if (isPrefix) {
      const n = prefixWork;
      const m = days.length - n;
      const slotOverrides: IFormState['slot_overrides'] = {};
      for (let i = 0; i < n; i++) {
        const slot = days[i];
        if (
          slot.work_start && slot.work_end
          && (slot.work_start.slice(0, 5) !== baseStart
            || slot.work_end.slice(0, 5) !== baseEnd
            || (slot.lunch_minutes ?? lunch) !== lunch)
        ) {
          slotOverrides[i] = {
            work_start: slot.work_start.slice(0, 5),
            work_end: slot.work_end.slice(0, 5),
            lunch_minutes: slot.lunch_minutes ?? lunch,
          };
        }
      }
      return {
        id: tpl.id,
        name: tpl.name,
        loaded_pattern_type: tpl.pattern_type,
        loaded_schedule_type: tpl.schedule_type,
        is_remote: tpl.schedule_type === 'remote',
        is_custom_cycle: false,
        custom_cycle_days: [],
        work_days_count: Math.max(1, n),
        off_days_count: Math.max(0, m),
        anchor_date: tpl.anchor_date ?? nearestMondayOnOrBefore(today),
        work_start: baseStart,
        work_end: baseEnd,
        lunch_minutes: lunch,
        slot_overrides: slotOverrides,
        respects_holidays: tpl.respects_holidays,
        late_threshold_minutes: tpl.late_threshold_minutes,
        full_day_threshold: minutesToHM(tpl.full_day_threshold_minutes),
        weekend_full_day_threshold: minutesToHM(tpl.weekend_full_day_threshold_minutes),
      };
    }

    // Непрефиксный (произвольный) цикл: переносим раскладку в custom_cycle_days.
    const customDays: ICustomDay[] = days.map((slot) => {
      const isWork = slot.work_hours > 0;
      const start = (slot.work_start ?? baseStart).slice(0, 5);
      const end = (slot.work_end ?? baseEnd).slice(0, 5);
      const slotLunch = slot.lunch_minutes ?? lunch;
      const inheritsBase = !isWork || (start === baseStart && end === baseEnd && slotLunch === lunch);
      return {
        is_work: isWork,
        work_start: start,
        work_end: end,
        lunch_minutes: slotLunch,
        inherits_base: inheritsBase,
      };
    });
    return {
      id: tpl.id,
      name: tpl.name,
      loaded_pattern_type: tpl.pattern_type,
      loaded_schedule_type: tpl.schedule_type,
      is_remote: tpl.schedule_type === 'remote',
      is_custom_cycle: true,
      custom_cycle_days: customDays,
      work_days_count: customDays.filter(d => d.is_work).length,
      off_days_count: customDays.filter(d => !d.is_work).length,
      anchor_date: tpl.anchor_date ?? nearestMondayOnOrBefore(today),
      work_start: baseStart,
      work_end: baseEnd,
      lunch_minutes: lunch,
      slot_overrides: {},
      respects_holidays: tpl.respects_holidays,
      late_threshold_minutes: tpl.late_threshold_minutes,
      full_day_threshold: minutesToHM(tpl.full_day_threshold_minutes),
      weekend_full_day_threshold: minutesToHM(tpl.weekend_full_day_threshold_minutes),
    };
  }

  // 2-3) legacy: используем work_days
  const workDows = (tpl.work_days || []).slice().sort((a, b) => a - b);
  const n = workDows.length || 5;
  const m = Math.max(0, 7 - n);
  const anchor = nearestMondayOnOrBefore(today);

  // day_overrides[dow] → slot_overrides[dow - 1] (понедельник=dow 1=slot 0).
  // Применимо когда work_days = [1..n] (непрерывная неделя).
  const slotOverrides: IFormState['slot_overrides'] = {};
  if (tpl.day_overrides) {
    for (const [dowStr, ovr] of Object.entries(tpl.day_overrides)) {
      const dow = Number(dowStr);
      const slotIndex = workDows.indexOf(dow);
      if (slotIndex < 0) continue;
      slotOverrides[slotIndex] = {
        work_start: ovr.work_start.slice(0, 5),
        work_end: ovr.work_end.slice(0, 5),
        lunch_minutes: lunch,
      };
    }
  }

  return {
    id: tpl.id,
    name: tpl.name,
    loaded_pattern_type: tpl.pattern_type,
    loaded_schedule_type: tpl.schedule_type,
    is_remote: tpl.schedule_type === 'remote',
    is_custom_cycle: false,
    custom_cycle_days: [],
    work_days_count: n,
    off_days_count: m,
    anchor_date: anchor,
    work_start: baseStart,
    work_end: baseEnd,
    lunch_minutes: lunch,
    slot_overrides: slotOverrides,
    respects_holidays: tpl.respects_holidays,
    late_threshold_minutes: tpl.late_threshold_minutes,
    full_day_threshold: minutesToHM(tpl.full_day_threshold_minutes),
    weekend_full_day_threshold: minutesToHM(tpl.weekend_full_day_threshold_minutes),
  };
};

/** Краткое описание ритма для таблицы шаблонов. */
const formatRhythmSummary = (tpl: IWorkSchedule): string => {
  if (tpl.pattern_type === 'cycle' && tpl.cycle_length && tpl.cycle_days) {
    const work = tpl.cycle_days.filter(s => s.work_hours > 0).length;
    const off = tpl.cycle_length - work;
    // Префиксная раскладка: первые work — рабочие, остальные — выходные.
    let prefixWork = 0;
    while (prefixWork < tpl.cycle_days.length && tpl.cycle_days[prefixWork].work_hours > 0) prefixWork++;
    const isPrefix = tpl.cycle_days.slice(prefixWork).every(d => d.work_hours <= 0);
    return isPrefix ? `${work}/${off}` : `${work}/${off} (произв., ${tpl.cycle_length}д)`;
  }
  if (tpl.pattern_type === '5+0') return '5/2';
  if (tpl.pattern_type === '5+2') return '5/2 + субботы';
  if (tpl.pattern_type === '6+0') return '6/1';
  return tpl.pattern_type;
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

  /**
   * После CRUD-операции с шаблоном/назначением — сбрасываем не только локальные кэши
   * страницы графиков, но и все производные:
   * - кэш табеля (`timesheet-page` / `timesheet` / `timesheet-grid`) — резолв расписаний
   *   приходит в payload табеля, поэтому без инвалидации покраска полного дня /
   *   weekend_threshold останется по старым значениям до F5.
   * - кэш карточки сотрудника (`employee-timesheet`).
   * - кэш approvals (`timesheet-approval`) — там тоже виден график.
   */
  const reloadScheduleData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['schedules'] }),
      queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
      queryClient.invalidateQueries({ queryKey: ['timesheet'] }),
      queryClient.invalidateQueries({ queryKey: ['timesheet-grid'] }),
      queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] }),
      queryClient.invalidateQueries({ queryKey: ['employee-timesheet'] }),
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
    setForm(tplToFormState(tpl, today));
    setShowForm(true);
  };

  const handleStartCreate = () => {
    setForm(createEmptyForm());
    setShowForm(true);
  };

  const applyRhythmPreset = (work: number, off: number) => {
    setForm(f => ({
      ...f,
      work_days_count: work,
      off_days_count: off,
      // При смене ритма — чистим overrides на индексах, которых больше нет.
      slot_overrides: Object.fromEntries(
        Object.entries(f.slot_overrides).filter(([k]) => Number(k) < work),
      ),
    }));
  };

  const setSlotOverride = (slotIndex: number, override: ISlotOverride | null) => {
    setForm(f => {
      const next = { ...f.slot_overrides };
      if (override === null) {
        delete next[slotIndex];
      } else {
        next[slotIndex] = override;
      }
      return { ...f, slot_overrides: next };
    });
  };

  const isNightShift = useMemo(() => {
    if (!/^\d{2}:\d{2}$/.test(form.work_start) || !/^\d{2}:\d{2}$/.test(form.work_end)) return false;
    return form.work_end <= form.work_start;
  }, [form.work_start, form.work_end]);

  /** Включить/выключить расширенный режим. При выключении пытаемся вернуть к простому N/M. */
  const toggleCustomCycle = (on: boolean) => {
    setForm(f => {
      if (on) {
        // Инициализируем custom_cycle_days из текущего N/M-вида.
        const days = buildCustomDaysFromPrefix(
          f.work_days_count,
          f.off_days_count,
          f.work_start,
          f.work_end,
          f.lunch_minutes,
          f.slot_overrides,
        );
        return { ...f, is_custom_cycle: true, custom_cycle_days: days };
      }
      // Выключение — пытаемся «свернуть» обратно в N/M, если раскладка префиксная.
      const days = f.custom_cycle_days;
      let prefixWork = 0;
      while (prefixWork < days.length && days[prefixWork].is_work) prefixWork++;
      const isPrefix = days.slice(prefixWork).every(d => !d.is_work);
      if (!isPrefix) {
        // Не префиксный — нельзя свернуть, остаёмся в custom-режиме.
        return f;
      }
      const n = prefixWork;
      const m = days.length - n;
      const slotOverrides: IFormState['slot_overrides'] = {};
      for (let i = 0; i < n; i++) {
        const d = days[i];
        if (!d.inherits_base) {
          slotOverrides[i] = {
            work_start: d.work_start,
            work_end: d.work_end,
            lunch_minutes: d.lunch_minutes,
          };
        }
      }
      return {
        ...f,
        is_custom_cycle: false,
        custom_cycle_days: [],
        work_days_count: Math.max(1, n),
        off_days_count: m,
        slot_overrides: slotOverrides,
      };
    });
  };

  const setCustomCycleLength = (rawLength: number) => {
    const length = Math.max(2, Math.min(28, Math.floor(rawLength) || 2));
    setForm(f => {
      const next = f.custom_cycle_days.slice(0, length);
      while (next.length < length) {
        next.push({
          is_work: true,
          work_start: f.work_start,
          work_end: f.work_end,
          lunch_minutes: f.lunch_minutes,
          inherits_base: true,
        });
      }
      return { ...f, custom_cycle_days: next };
    });
  };

  const updateCustomDay = (index: number, patch: Partial<ICustomDay>) => {
    setForm(f => ({
      ...f,
      custom_cycle_days: f.custom_cycle_days.map((day, idx) =>
        idx === index ? { ...day, ...patch } : day,
      ),
    }));
  };

  const moveCustomDay = (index: number, direction: -1 | 1) => {
    setForm(f => {
      const next = [...f.custom_cycle_days];
      const target = index + direction;
      if (target < 0 || target >= next.length) return f;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...f, custom_cycle_days: next };
    });
  };

  const handleSave = async () => {
    setError('');
    try {
      const fullDayMin = form.full_day_threshold ? parseHMToMinutes(form.full_day_threshold) : null;
      if (form.full_day_threshold && fullDayMin === null) {
        setError('Порог полного дня: формат ЧЧ:ММ');
        return;
      }
      const weekendFullDayMin = form.weekend_full_day_threshold
        ? parseHMToMinutes(form.weekend_full_day_threshold)
        : null;
      if (form.weekend_full_day_threshold && weekendFullDayMin === null) {
        setError('Минимальная длина смены в выходной: формат ЧЧ:ММ');
        return;
      }

      if (!form.anchor_date || !/^\d{4}-\d{2}-\d{2}$/.test(form.anchor_date)) {
        setError('Укажите корректную дату первого рабочего дня (YYYY-MM-DD)');
        return;
      }

      const baseShift = computeShiftHours(form.work_start, form.work_end);
      if (baseShift <= 0) {
        setError('Некорректное время начала/конца смены');
        return;
      }
      const baseNet = Math.max(0, baseShift - (form.lunch_minutes || 0) / 60);

      // Собираем cycle_days в зависимости от режима.
      const cycleDays: ICycleDay[] = [];

      if (form.is_custom_cycle) {
        const customDays = form.custom_cycle_days;
        if (customDays.length < 2 || customDays.length > 28) {
          setError('Длина произвольного цикла — от 2 до 28 дней');
          return;
        }
        if (!customDays.some(d => d.is_work)) {
          setError('В цикле должен быть хотя бы один рабочий день');
          return;
        }
        for (let i = 0; i < customDays.length; i++) {
          const day = customDays[i];
          if (!day.is_work) {
            cycleDays.push({ work_hours: 0 });
            continue;
          }
          const useStart = day.inherits_base ? form.work_start : day.work_start;
          const useEnd = day.inherits_base ? form.work_end : day.work_end;
          const useLunch = day.inherits_base ? form.lunch_minutes : day.lunch_minutes;
          const shift = computeShiftHours(useStart, useEnd);
          if (shift <= 0) {
            setError(`Некорректное время для дня № ${i + 1}`);
            return;
          }
          const net = Math.max(0, shift - (useLunch || 0) / 60);
          cycleDays.push({
            work_hours: Number(net.toFixed(4)),
            work_start: useStart,
            work_end: useEnd,
            lunch_minutes: useLunch,
          });
        }
      } else {
        // Простой N/M-режим: префиксная раскладка.
        const n = form.work_days_count;
        const m = form.off_days_count;
        if (n < 1 || n > 28) {
          setError('Количество рабочих дней — от 1 до 28');
          return;
        }
        if (m < 0 || m > 28) {
          setError('Количество выходных — от 0 до 28');
          return;
        }
        if (n + m < 2 || n + m > 28) {
          setError('Длина цикла (раб + вых) — от 2 до 28 дней');
          return;
        }
        for (let i = 0; i < n; i++) {
          const ovr = form.slot_overrides[i];
          if (ovr) {
            const ovrShift = computeShiftHours(ovr.work_start, ovr.work_end);
            if (ovrShift <= 0) {
              setError(`Некорректное время для рабочего дня № ${i + 1}`);
              return;
            }
            const ovrNet = Math.max(0, ovrShift - (ovr.lunch_minutes || 0) / 60);
            cycleDays.push({
              work_hours: Number(ovrNet.toFixed(4)),
              work_start: ovr.work_start,
              work_end: ovr.work_end,
              lunch_minutes: ovr.lunch_minutes,
            });
          } else {
            cycleDays.push({
              work_hours: Number(baseNet.toFixed(4)),
              work_start: form.work_start,
              work_end: form.work_end,
              lunch_minutes: form.lunch_minutes,
            });
          }
        }
        for (let i = 0; i < m; i++) cycleDays.push({ work_hours: 0 });
      }

      // schedule_type: cycle всегда 'shift', либо 'remote' если is_remote.
      const computedScheduleType: ScheduleType = form.is_remote ? 'remote' : 'shift';

      const payload = {
        name: form.name.trim(),
        schedule_type: computedScheduleType,
        pattern_type: 'cycle' as PatternType,
        work_start: form.work_start,
        work_end: form.work_end,
        work_hours: Number(baseNet.toFixed(4)),
        // work_days формально NOT NULL в БД, для cycle не используется резолвером.
        work_days: [1, 2, 3, 4, 5],
        office_days: null,
        // day_overrides не используется для cycle — все «особые дни» в cycle_days.
        day_overrides: null,
        lunch_minutes: form.lunch_minutes,
        respects_holidays: form.respects_holidays,
        // expected_saturdays_per_month — устаревшее поле legacy 5+2, для cycle 0.
        expected_saturdays_per_month: 0,
        late_threshold_minutes: form.late_threshold_minutes,
        full_day_threshold_minutes: fullDayMin,
        weekend_full_day_threshold_minutes: weekendFullDayMin,
        cycle_length: cycleDays.length,
        cycle_days: cycleDays,
        anchor_date: form.anchor_date,
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
            <div
              className={styles.modalOverlay}
              onMouseDown={e => { if (e.target === e.currentTarget) setShowForm(false); }}
            >
              <div className={styles.modal}>
                <div className={styles.modalHeader}>
                  <h3 className={styles.modalTitle}>
                    {form.id ? 'Редактирование графика' : 'Новый график'}
                  </h3>
                  <button type="button" className={styles.modalClose} onClick={() => setShowForm(false)} aria-label="Закрыть">
                    ✕
                  </button>
                </div>

                <div className={styles.form}>
                  {/* ─── Основное + ритм + время в одной плотной секции ─ */}
                  <section className={styles.formSection}>
                    <label style={{ gridColumn: '1 / -1' }}>
                      Название
                      <input
                        type="text"
                        value={form.name}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                        placeholder="например, ИТР 5/2"
                      />
                    </label>

                    <label className={styles.checkboxRow} style={{ gridColumn: '1 / -1' }} title="Включи, если в цикле выходные расположены нерегулярно (например, 6/1 → 5/2 двухнедельный) или нужно тонкое управление каждым днём.">
                      <input
                        type="checkbox"
                        checked={form.is_custom_cycle}
                        onChange={e => toggleCustomCycle(e.target.checked)}
                      />
                      Произвольный цикл (расширенный режим — каждый день настраивается вручную)
                    </label>

                    {!form.is_custom_cycle && (
                      <>
                        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)', alignSelf: 'center', marginRight: 4 }}>Ритм:</span>
                          {RHYTHM_PRESETS.map(preset => {
                            const active = form.work_days_count === preset.work && form.off_days_count === preset.off;
                            return (
                              <button
                                key={preset.label}
                                type="button"
                                className={`${styles.dayBtn} ${active ? styles.dayBtnActive : ''}`}
                                onClick={() => applyRhythmPreset(preset.work, preset.off)}
                              >
                                {preset.label}
                              </button>
                            );
                          })}
                        </div>

                        <label>
                          Рабочих (N)
                          <input
                            type="number"
                            min={1}
                            max={28}
                            value={form.work_days_count}
                            onChange={e => {
                              const v = Math.max(1, Math.min(28, parseInt(e.target.value) || 1));
                              setForm(f => ({
                                ...f,
                                work_days_count: v,
                                slot_overrides: Object.fromEntries(
                                  Object.entries(f.slot_overrides).filter(([k]) => Number(k) < v),
                                ),
                              }));
                            }}
                          />
                        </label>
                        <label>
                          Выходных (M)
                          <input
                            type="number"
                            min={0}
                            max={28}
                            value={form.off_days_count}
                            onChange={e => setForm({ ...form, off_days_count: Math.max(0, Math.min(28, parseInt(e.target.value) || 0)) })}
                          />
                        </label>
                      </>
                    )}

                    {form.is_custom_cycle && (
                      <label style={{ gridColumn: '1 / -1' }} title="Длина повторяющегося цикла. При увеличении новые дни добавляются как рабочие; при уменьшении — обрезаются с конца.">
                        Длина цикла (дней)
                        <input
                          type="number"
                          min={2}
                          max={28}
                          value={form.custom_cycle_days.length}
                          onChange={e => setCustomCycleLength(parseInt(e.target.value) || 0)}
                          style={{ maxWidth: 120 }}
                        />
                      </label>
                    )}

                    <label style={{ gridColumn: '1 / -1' }} title="Дата первого дня цикла (день 1 — для произвольного цикла).">
                      {form.is_custom_cycle ? 'Дата первого дня цикла' : 'Дата первого рабочего дня'}
                      <input
                        type="date"
                        value={form.anchor_date}
                        onChange={e => setForm({ ...form, anchor_date: e.target.value })}
                      />
                    </label>

                    {/* Время смены — 4 поля, при нехватке места переносятся */}
                    <div className={styles.timeRow}>
                      <label>
                        Начало
                        <input
                          type="time"
                          value={form.work_start}
                          onChange={e => setForm({ ...form, work_start: e.target.value })}
                        />
                      </label>
                      <label>
                        Конец
                        <input
                          type="time"
                          value={form.work_end}
                          onChange={e => setForm({ ...form, work_end: e.target.value })}
                        />
                      </label>
                      <label>
                        Обед, мин
                        <input
                          type="number"
                          min={0}
                          max={240}
                          value={form.lunch_minutes}
                          onChange={e => setForm({ ...form, lunch_minutes: parseInt(e.target.value) || 0 })}
                        />
                      </label>
                      <label>
                        Чистое
                        <input type="text" value={netHoursLabel} readOnly />
                      </label>
                    </div>
                    <div className={styles.patternHint}>
                      Смена: {shiftLabel}{isNightShift ? ' 🌙 (через полночь)' : ''}, чистое = смена − обед.
                    </div>

                    {/* Чекбоксы рядом */}
                    <label className={styles.checkboxRow} style={{ gridColumn: '1 / -1' }} title="СКУД-проверка отключена для удалёнки.">
                      <input
                        type="checkbox"
                        checked={form.is_remote}
                        onChange={e => setForm({ ...form, is_remote: e.target.checked })}
                      />
                      Удалённая работа (без СКУД-контроля)
                    </label>
                    <label className={styles.checkboxRow} style={{ gridColumn: '1 / -1' }} title="Если включено — мандаторные праздники (1-8 января, 23 февраля и т.д.) не считаются рабочими, даже если по циклу выпадают на рабочий слот.">
                      <input
                        type="checkbox"
                        checked={form.respects_holidays}
                        onChange={e => setForm({ ...form, respects_holidays: e.target.checked })}
                      />
                      Учитывать праздники РФ
                    </label>
                  </section>

              {/* ─── Особые рабочие дни (N/M-режим) ─────────────────────── */}
              {!form.is_custom_cycle && form.work_days_count > 0 && (
                <section className={styles.formSection}>
                  <div className={styles.sectionTitle}>
                    Особые рабочие дни цикла {Object.keys(form.slot_overrides).length > 0 ? `(${Object.keys(form.slot_overrides).length})` : ''}
                  </div>
                  <div className={styles.patternHint}>
                    Можно выделить отдельные рабочие дни цикла со своим временем (например, пятница 9:00-17:00). Без переключателя — все рабочие дни идут по общему времени выше.
                  </div>
                  <div className={styles.slotsGrid}>
                    {Array.from({ length: form.work_days_count }).map((_, idx) => {
                      const ovr = form.slot_overrides[idx];
                      const start = ovr?.work_start ?? form.work_start;
                      const end = ovr?.work_end ?? form.work_end;
                      const lunch = ovr?.lunch_minutes ?? form.lunch_minutes;
                      const slotShiftHours = computeShiftHours(start, end);
                      const slotNetHours = formatMinutes(slotShiftHours * 60 - lunch);
                      return (
                        <div key={idx} className={styles.dayOverrideCard}>
                          <div className={styles.dayOverrideHeader}>
                            <div>
                              <div className={styles.dayOverrideTitle}>Раб. день {idx + 1}</div>
                              <div className={styles.dayOverrideMeta}>
                                {ovr ? 'Особый график' : `Общий: ${form.work_start}-${form.work_end}`}
                              </div>
                            </div>
                            <label className={styles.dayOverrideToggle}>
                              <input
                                type="checkbox"
                                checked={Boolean(ovr)}
                                onChange={e => {
                                  if (e.target.checked) {
                                    setSlotOverride(idx, { work_start: form.work_start, work_end: form.work_end, lunch_minutes: form.lunch_minutes });
                                  } else {
                                    setSlotOverride(idx, null);
                                  }
                                }}
                              />
                              Особый
                            </label>
                          </div>
                          {ovr && (
                            <div className={styles.dayOverrideFields}>
                              <label>
                                Начало
                                <input type="time" value={ovr.work_start} onChange={e => setSlotOverride(idx, { ...ovr, work_start: e.target.value })} />
                              </label>
                              <label>
                                Конец
                                <input type="time" value={ovr.work_end} onChange={e => setSlotOverride(idx, { ...ovr, work_end: e.target.value })} />
                              </label>
                              <label>
                                Обед (мин)
                                <input type="number" min={0} max={240} value={ovr.lunch_minutes} onChange={e => setSlotOverride(idx, { ...ovr, lunch_minutes: parseInt(e.target.value) || 0 })} />
                              </label>
                            </div>
                          )}
                          <div className={styles.dayOverrideSummary}>
                            {start}-{end}, чистое: <strong>{slotNetHours}</strong>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* ─── Произвольный цикл: редактор каждого дня ─────────── */}
              {form.is_custom_cycle && (
                <section className={styles.formSection}>
                  <div className={styles.sectionTitle}>
                    Дни цикла ({form.custom_cycle_days.length})
                  </div>
                  <div className={styles.patternHint}>
                    Каждый день настраивается отдельно: рабочий или выходной, время смены. Стрелки ↑↓ переставляют дни в цикле.
                    Подходит для нерегулярных раскладок типа 6/1 → 5/2.
                  </div>
                  <div className={styles.slotsGrid}>
                    {form.custom_cycle_days.map((day, idx) => {
                      const useStart = day.inherits_base ? form.work_start : day.work_start;
                      const useEnd = day.inherits_base ? form.work_end : day.work_end;
                      const useLunch = day.inherits_base ? form.lunch_minutes : day.lunch_minutes;
                      const shift = day.is_work ? computeShiftHours(useStart, useEnd) : 0;
                      const net = day.is_work ? formatMinutes(shift * 60 - useLunch) : '0:00';
                      return (
                        <div key={idx} className={styles.dayOverrideCard}>
                          <div className={styles.dayOverrideHeader}>
                            <div>
                              <div className={styles.dayOverrideTitle}>День {idx + 1}</div>
                              <div className={styles.dayOverrideMeta}>
                                {day.is_work
                                  ? (day.inherits_base ? `Общий: ${form.work_start}-${form.work_end}` : `Свой: ${day.work_start}-${day.work_end}`)
                                  : 'Выходной'}
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                              <button
                                type="button"
                                className={styles.dayBtn}
                                style={{ padding: '4px 8px', fontSize: 12 }}
                                onClick={() => moveCustomDay(idx, -1)}
                                disabled={idx === 0}
                                title="Вверх"
                              >↑</button>
                              <button
                                type="button"
                                className={styles.dayBtn}
                                style={{ padding: '4px 8px', fontSize: 12 }}
                                onClick={() => moveCustomDay(idx, 1)}
                                disabled={idx === form.custom_cycle_days.length - 1}
                                title="Вниз"
                              >↓</button>
                              <label className={styles.dayOverrideToggle}>
                                <input
                                  type="checkbox"
                                  checked={day.is_work}
                                  onChange={e => updateCustomDay(idx, { is_work: e.target.checked })}
                                />
                                Раб.
                              </label>
                            </div>
                          </div>
                          {day.is_work && (
                            <>
                              <label className={styles.dayOverrideToggle} style={{ alignSelf: 'flex-start' }}>
                                <input
                                  type="checkbox"
                                  checked={!day.inherits_base}
                                  onChange={e => updateCustomDay(idx, {
                                    inherits_base: !e.target.checked,
                                    work_start: e.target.checked ? day.work_start : form.work_start,
                                    work_end: e.target.checked ? day.work_end : form.work_end,
                                    lunch_minutes: e.target.checked ? day.lunch_minutes : form.lunch_minutes,
                                  })}
                                />
                                Своё время
                              </label>
                              {!day.inherits_base && (
                                <div className={styles.dayOverrideFields}>
                                  <label>
                                    Начало
                                    <input type="time" value={day.work_start} onChange={e => updateCustomDay(idx, { work_start: e.target.value })} />
                                  </label>
                                  <label>
                                    Конец
                                    <input type="time" value={day.work_end} onChange={e => updateCustomDay(idx, { work_end: e.target.value })} />
                                  </label>
                                  <label>
                                    Обед (мин)
                                    <input type="number" min={0} max={240} value={day.lunch_minutes} onChange={e => updateCustomDay(idx, { lunch_minutes: parseInt(e.target.value) || 0 })} />
                                  </label>
                                </div>
                              )}
                            </>
                          )}
                          <div className={styles.dayOverrideSummary}>
                            {day.is_work ? `${useStart}-${useEnd}, чистое: ` : 'Выходной: '}
                            <strong>{net}</strong>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* ─── Превью на 14 дней ────────────────────────────────── */}
              {form.anchor_date && /^\d{4}-\d{2}-\d{2}$/.test(form.anchor_date) && (
                form.is_custom_cycle ? form.custom_cycle_days.length > 0 : form.work_days_count > 0
              ) && (
                <section className={styles.formSection}>
                  <div className={styles.sectionTitle}>Превью на 14 дней</div>
                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {(() => {
                      const cycleLen = form.is_custom_cycle
                        ? form.custom_cycle_days.length
                        : form.work_days_count + form.off_days_count;
                      if (cycleLen < 1) return null;
                      const anchor = new Date(`${form.anchor_date}T00:00:00`);
                      if (isNaN(anchor.getTime())) return null;
                      return Array.from({ length: 14 }).map((_, dayShift) => {
                        const d = new Date(anchor.getTime());
                        d.setDate(d.getDate() + dayShift);
                        const idx = ((dayShift % cycleLen) + cycleLen) % cycleLen;
                        const dd = String(d.getDate()).padStart(2, '0');
                        const mm = String(d.getMonth() + 1).padStart(2, '0');

                        let isWork: boolean;
                        let isOverride: boolean;
                        let title: string;

                        if (form.is_custom_cycle) {
                          const day = form.custom_cycle_days[idx];
                          isWork = day.is_work;
                          isOverride = day.is_work && !day.inherits_base;
                          title = day.is_work
                            ? `Раб. ${day.inherits_base ? form.work_start : day.work_start}-${day.inherits_base ? form.work_end : day.work_end}${isOverride ? ' (особый)' : ''}`
                            : 'Выходной';
                        } else {
                          isWork = idx < form.work_days_count;
                          const ovr = isWork ? form.slot_overrides[idx] : null;
                          isOverride = Boolean(ovr);
                          title = isWork
                            ? `Раб. ${ovr?.work_start ?? form.work_start}-${ovr?.work_end ?? form.work_end}${ovr ? ' (особый)' : ''}`
                            : 'Выходной';
                        }

                        const cls = !isWork
                          ? styles.previewDayOff
                          : isOverride
                            ? styles.previewDayOverride
                            : styles.previewDayWork;
                        return (
                          <span key={dayShift} className={`${styles.previewDay} ${cls}`} title={title}>
                            {dd}.{mm}
                          </span>
                        );
                      });
                    })()}
                  </div>
                </section>
              )}

              {/* ─── Дополнительные параметры (свёрнуто) ─────────────── */}
              <details className={styles.formAdvanced}>
                <summary>Дополнительные параметры</summary>
                <div className={styles.formAdvancedGrid}>
                  <label title="Сколько минут после начала смены не считать опозданием.">
                    Порог опоздания (минут)
                    <input
                      type="number"
                      min={0}
                      max={120}
                      value={form.late_threshold_minutes}
                      onChange={e => setForm({ ...form, late_threshold_minutes: parseInt(e.target.value) || 0 })}
                    />
                  </label>
                  <label title="Ниже этого значения рабочий день считается недоработкой (жёлтый), выше — полный день (зелёный). Пусто = чистое время смены.">
                    Порог полного дня (ЧЧ:ММ)
                    <input
                      type="time"
                      value={form.full_day_threshold}
                      onChange={e => setForm({ ...form, full_day_threshold: e.target.value })}
                      placeholder="авто"
                    />
                  </label>
                  <label title="Минимальная длительность смены, чтобы выход в выходной засчитался как полный день. Пусто = использовать обычный порог.">
                    Минимум для выхода в выходной (ЧЧ:ММ)
                    <input
                      type="time"
                      value={form.weekend_full_day_threshold}
                      onChange={e => setForm({ ...form, weekend_full_day_threshold: e.target.value })}
                      placeholder="авто"
                    />
                  </label>
                </div>
              </details>

              {form.loaded_pattern_type && form.loaded_pattern_type !== 'cycle' && (
                <div className={styles.legacyBanner}>
                  ℹ Шаблон был в legacy-формате <code>{form.loaded_pattern_type}</code>. После сохранения он будет переписан как «{form.work_days_count}/{form.off_days_count}» — все назначенные сотрудники продолжат работать без изменений.
                </div>
              )}
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
            </div>
          )}

          {loading ? (
            <div>Загрузка...</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Ритм</th>
                  <th>Смена</th>
                  <th>Обед</th>
                  <th>Праздники</th>
                  <th>Тип</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {templates.map(t => (
                  <tr key={t.id}>
                    <td>
                      {t.name}
                      {t.is_default && <span className={`${styles.badge} ${styles.badgeDefault}`} style={{ marginLeft: 8 }}>дефолт</span>}
                      {t.pattern_type !== 'cycle' && (
                        <span className={styles.badge} style={{ marginLeft: 8 }} title="Старый формат — будет переписан в N/M при сохранении">legacy</span>
                      )}
                    </td>
                    <td>
                      {formatRhythmSummary(t)}
                      {t.pattern_type === 'cycle' && t.anchor_date && (
                        <div className={styles.cellHint}>якорь {t.anchor_date}</div>
                      )}
                    </td>
                    <td>
                      {t.work_start.slice(0, 5)}–{t.work_end.slice(0, 5)} ({formatHours(Number(t.work_hours))})
                    </td>
                    <td>{t.lunch_minutes} мин</td>
                    <td>{t.respects_holidays ? 'учитывает' : 'игнорирует'}</td>
                    <td>{t.schedule_type === 'remote' ? 'Удалённо' : 'Очно'}</td>
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
