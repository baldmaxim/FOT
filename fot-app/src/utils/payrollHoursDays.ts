/**
 * Расшифровка оклада по часам (с ноября 2026) в листке карточки «Зарплата»: таблица «Часы по дням» и подписи под
 * «По трудовому договору» — откуда часы табеля и норма. Данные — hours_by_day и norm_plan расчёта (только в листке);
 * их нет (старый бэкенд, месяц по дням) — расшифровки нет. Снимок нормы показывается, только если его сумма равна
 * норме формулы: иначе цифры разошлись бы, и тогда остаётся одна норма формулы.
 */
import type { IPayrollCalcHoursDay, IPayrollNormPlan, PayrollCalcCounted } from '../services/payrollService';

const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;

/** Минуты → часы строкой: 7260 → «121», 450 → «7,5». */
export const formatHours = (minutes: number): string => (
  String(Math.round((minutes / 60) * 100) / 100).replace('.', ',')
);

/** «04.11 Ср». */
const dayLabel = (iso: string): string => {
  const [year, month, day] = iso.split('-').map(Number);
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}`;
};

/** Норма формулы оклада — из части salary_hours; нет — оклад не по часам. */
const formulaNormMinutes = (calc: PayrollCalcCounted): number | null => {
  for (const line of calc.lines) {
    for (const part of line.parts ?? []) {
      if (part.kind === 'salary_hours') return part.norm_minutes;
    }
  }
  return null;
};

/** Оклад месяца считается по часам: есть часть salary_hours. */
export const isSalaryByHoursCalc = (calc: PayrollCalcCounted): boolean => formulaNormMinutes(calc) !== null;

const planTotal = (plan: IPayrollNormPlan): number => (
  Object.values(plan.days).reduce((sum, minutes) => sum + minutes, 0) + (plan.saturdays + plan.sundays) * plan.quota_minutes
);

/** Снимок нормы, сходящийся с формулой; иначе null. */
const usablePlan = (calc: PayrollCalcCounted): IPayrollNormPlan | null => {
  const norm = formulaNormMinutes(calc);
  const plan = calc.norm_plan ?? null;
  return plan && norm !== null && planTotal(plan) === norm ? plan : null;
};

export interface IHoursDayRow {
  date: string;
  /** «04.11 Ср». */
  label: string;
  /** Норма дня по графику; null — снимка нет (колонки «График» нет); 0 — день без нормы. */
  normMinutes: number | null;
  /** Рабочий день без нормы в снимке — плановая Сб/Вс по квоте. */
  quota: boolean;
  /** Часы табеля к оплате; null — нет. */
  paidMinutes: number | null;
  contractMinutes: number;
  overtimeMinutes: number;
  hourlyMinutes: number;
  brigade: boolean;
  /** Дата после as_of предварительного расчёта — табеля ещё нет. */
  future: boolean;
}

export interface IHoursDaysTable {
  rows: IHoursDayRow[];
  /** Есть снимок нормы — колонка «График» и строка квоты. */
  hasNorm: boolean;
  /** «Квота суббот (2 × 10 ч)» и её минуты; нет квоты или снимка — null. */
  quota: { label: string; minutes: number } | null;
  totals: { norm: number | null; paid: number; contract: number; overtime: number };
}

const quotaName = (plan: IPayrollNormPlan): string => {
  if (plan.saturdays > 0 && plan.sundays > 0) return `${plan.saturdays + plan.sundays} Сб/Вс`;
  return plan.saturdays > 0 ? `${plan.saturdays} Сб` : `${plan.sundays} Вс`;
};

/** Таблица «Часы по дням»: даты нормы и даты с часами, по порядку; итог = часы формулы. Нет расшифровки — null. */
export const buildHoursDaysTable = (calc: PayrollCalcCounted): IHoursDaysTable | null => {
  const days = calc.hours_by_day;
  if (!days || days.length === 0) return null;
  const plan = usablePlan(calc);
  const asOf = calc.state === 'preliminary' ? calc.as_of : null;
  const byDate = new Map<string, IPayrollCalcHoursDay>(days.map(day => [day.date, day]));
  const dates = [...new Set([...Object.keys(plan?.days ?? {}), ...byDate.keys()])].sort();
  const rows = dates.map((date): IHoursDayRow => {
    const day = byDate.get(date);
    const normMinutes = plan ? plan.days[date] ?? 0 : null;
    return {
      date,
      label: dayLabel(date),
      normMinutes,
      quota: Boolean(plan && day?.kind === 'workday' && normMinutes === 0),
      paidMinutes: day?.paid_minutes ?? null,
      contractMinutes: day?.contract_minutes ?? 0,
      overtimeMinutes: day?.overtime_minutes ?? 0,
      hourlyMinutes: day?.hourly_minutes ?? 0,
      brigade: day?.kind === 'brigade',
      future: asOf !== null && date > asOf,
    };
  });
  const quotaDays = plan ? plan.saturdays + plan.sundays : 0;
  const sum = (pick: (row: IHoursDayRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  return {
    rows,
    hasNorm: plan !== null,
    quota: plan && quotaDays > 0
      ? { label: `Квота (${quotaName(plan)} × ${formatHours(plan.quota_minutes)} ч)`, minutes: quotaDays * plan.quota_minutes }
      : null,
    totals: {
      norm: plan ? planTotal(plan) : null,
      paid: sum(row => row.paidMinutes ?? 0),
      contract: sum(row => row.contractMinutes),
      overtime: sum(row => row.overtimeMinutes),
    },
  };
};

/** «норма 230 ч = 21 дн. × 10 ч + 2 Сб × 10 ч»; у дней разные часы — «209 ч за 21 дн. графика». */
const normNote = (plan: IPayrollNormPlan): string => {
  const values = Object.values(plan.days);
  const dayMinutes = values.reduce((sum, minutes) => sum + minutes, 0);
  const uniform = values.length > 0 && values.every(minutes => minutes === values[0]);
  const daysPart = uniform
    ? `${values.length} дн. × ${formatHours(values[0])} ч`
    : `${formatHours(dayMinutes)} ч за ${values.length} дн. графика`;
  const quotaPart = plan.saturdays + plan.sundays > 0 ? ` + ${quotaName(plan)} × ${formatHours(plan.quota_minutes)} ч` : '';
  return `норма ${formatHours(planTotal(plan))} ч = ${daysPart}${quotaPart}`;
};

/**
 * Подписи под формулой «По трудовому договору» месяца с окладом по часам: часы табеля окладных дней и их число; куда
 * ушли часы, если не все в оклад (переработка, сверх нормы не оплачивается); из чего норма. Нет расшифровки — [].
 */
export const salaryHoursNotes = (calc: PayrollCalcCounted): string[] => {
  const norm = formulaNormMinutes(calc);
  if (norm === null || !calc.hours_by_day) return [];
  // Окладные дни: не бригада и не почасовой сегмент (у них своя часть формулы).
  const salaryDays = calc.hours_by_day.filter(day => day.kind !== 'brigade' && day.hourly_minutes === 0);
  const paid = salaryDays.reduce((sum, day) => sum + (day.paid_minutes ?? 0), 0);
  const contract = salaryDays.reduce((sum, day) => sum + day.contract_minutes, 0);
  const overtime = salaryDays.reduce((sum, day) => sum + day.overtime_minutes, 0);
  const unpaid = Math.max(0, paid - contract - overtime);
  const workedDays = salaryDays.filter(day => (day.paid_minutes ?? 0) > 0).length;
  const notes = [`часы табеля ${formatHours(paid)} ч за ${workedDays} дн.`];
  if (overtime > 0 || unpaid > 0) {
    const parts = [`в оклад ${formatHours(contract)} ч`];
    if (overtime > 0) parts.push(`${formatHours(overtime)} ч — «Переработка»`);
    if (unpaid > 0) parts.push(`${formatHours(unpaid)} ч сверх нормы не оплачиваются`);
    notes.push(parts.join('; '));
  }
  const plan = usablePlan(calc);
  notes.push(plan ? normNote(plan) : `норма ${formatHours(norm)} ч — по графику месяца`);
  return notes;
};
