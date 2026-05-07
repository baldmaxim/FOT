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

interface IFormState {
  id: string | null;
  name: string;
  /** Тип, как был в БД при загрузке. Нужен для понимания, конвертируется ли legacy-шаблон. */
  loaded_pattern_type: PatternType | null;
  /** Тип расписания из БД. Сохраняется как есть, если is_remote не менялся явно. */
  loaded_schedule_type: ScheduleType | null;
  is_remote: boolean;
  /** N: количество рабочих дней в цикле. */
  work_days_count: number;
  /** M: количество выходных дней в цикле. */
  off_days_count: number;
  /** Дата первого рабочего дня цикла (anchor). */
  anchor_date: string;
  /** Базовое время смены (для всех рабочих слотов кроме особых). */
  work_start: string;
  work_end: string;
  lunch_minutes: number;
  /** Особые рабочие дни цикла: ключ — индекс рабочего слота 0..N-1. */
  slot_overrides: Partial<Record<number, ISlotOverride>>;
  respects_holidays: boolean;
  late_threshold_minutes: number;
  full_day_threshold: string;          // "HH:MM", "" = авто (чистое время)
  weekend_full_day_threshold: string;  // "HH:MM", "" = авто (= full_day_threshold)
}

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
    let n = 0;
    while (n < days.length && days[n].work_hours > 0) n++;
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
    return `${work}/${off}`;
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

      // Собираем cycle_days: первые N — рабочие (с базовым временем или override),
      // последние M — выходные (work_hours=0).
      const cycleDays: ICycleDay[] = [];
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
        cycle_length: n + m,
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

                    <label style={{ gridColumn: '1 / -1' }} title="Дата первого рабочего дня в цикле.">
                      Дата первого рабочего дня
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

              {/* ─── Особые дни цикла (раб. слот с другим временем) ─── */}
              {form.work_days_count > 0 && (
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

              {/* ─── Превью на 14 дней ────────────────────────────────── */}
              {form.anchor_date && /^\d{4}-\d{2}-\d{2}$/.test(form.anchor_date) && form.work_days_count > 0 && (
                <section className={styles.formSection}>
                  <div className={styles.sectionTitle}>Превью на 14 дней</div>
                  <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {(() => {
                      const cycleLen = form.work_days_count + form.off_days_count;
                      if (cycleLen < 1) return null;
                      const anchor = new Date(`${form.anchor_date}T00:00:00`);
                      if (isNaN(anchor.getTime())) return null;
                      return Array.from({ length: 14 }).map((_, dayShift) => {
                        const d = new Date(anchor.getTime());
                        d.setDate(d.getDate() + dayShift);
                        const idx = ((dayShift % cycleLen) + cycleLen) % cycleLen;
                        const isWork = idx < form.work_days_count;
                        const dd = String(d.getDate()).padStart(2, '0');
                        const mm = String(d.getMonth() + 1).padStart(2, '0');
                        const ovr = isWork ? form.slot_overrides[idx] : null;
                        const cls = !isWork
                          ? styles.previewDayOff
                          : ovr
                            ? styles.previewDayOverride
                            : styles.previewDayWork;
                        return (
                          <span
                            key={dayShift}
                            className={`${styles.previewDay} ${cls}`}
                            title={isWork
                              ? `Рабочий ${ovr?.work_start ?? form.work_start}-${ovr?.work_end ?? form.work_end}${ovr ? ' (особый)' : ''}`
                              : 'Выходной'}
                          >
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
