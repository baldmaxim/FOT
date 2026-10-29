import type { IPayrollCalcLine } from '../services/payrollService';
import type { TimesheetEmployee, TimesheetEntry, TimesheetStatus } from '../types';
import type {
  ITimesheetSalaryObject,
  ITimesheetSalaryObjectMember,
  ITimesheetSalaryResponse,
  ITimesheetSalaryRow,
  TimesheetSalaryErrorCode,
} from '../types/timesheet';
import { calcLineDaysNote, calcMissingNote } from './payrollCalc';
import { formatPaidAmount } from './payrollPaid';
import { formatTimesheetEmployeeName } from './timesheetDisplay';

/** Строка вкладки «Зарплата» у сотрудника, если он в составе (начальник участка, «Руководитель» — нет). */
export const findSalaryRow = (
  data: ITimesheetSalaryResponse | undefined,
  employee: TimesheetEmployee,
): ITimesheetSalaryRow | null => {
  if (!data) return null;
  const source = employee.source ?? 'department';
  if (source !== 'department') return null;
  return data.rows.find(row => row.employee_id === employee.id) ?? null;
};

/** «141 818,18»; суммы нет — «—». */
export const formatSalaryAmount = (amount: string | null): string => (
  amount === null ? '—' : formatPaidAmount(Number(amount))
);

/** '1.5' → '1,5'. */
export const formatKtu = (value: string): string => value.replace('.', ',');

/**
 * Суммы строки приглушены: бригада «Требует перерасчёта». Отдел — никогда: закрыт табель или нет, на экране не
 * помечается (решение 29.10.2026).
 */
export const isSalaryRowMuted = (
  data: ITimesheetSalaryResponse | undefined,
  row: ITimesheetSalaryRow | null,
): boolean => {
  if (!data || !row) return false;
  return data.kind === 'brigade' && data.state === 'stale';
};

/**
 * Подсказка «Суммы» (к выплате: начислено − удержания, без НДФЛ). Бригада — из чего она: «Доля 141 818,18 · КТУ 1,5 ·
 * 176 ч · удержано 3 500,00»; отдел — «К выплате (ФОТ)», посчитать нечем — без подсказки. Чего в сумме нет — в конце.
 */
export const salaryAmountTitle = (data: ITimesheetSalaryResponse, row: ITimesheetSalaryRow): string | undefined => {
  const parts: string[] = [];
  if (data.kind === 'brigade') {
    if (row.counted_hours === null) return undefined;
    if (row.share) parts.push(`Доля ${formatSalaryAmount(row.share)}`);
    parts.push(`КТУ ${formatKtu(row.ktu ?? '1.0')}`, `${String(row.counted_hours).replace('.', ',')} ч`);
    if (row.deducted && Number(row.deducted) > 0) parts.push(`удержано ${formatSalaryAmount(row.deducted)}`);
    if (data.state === 'fixed' && row.source === 'live') parts.push('нет в закрытом табеле — по данным портала');
    const missingObjects = row.share === null || row.share === undefined ? missingObjectsNote(data, row.employee_id) : null;
    if (missingObjects) parts.push(missingObjects);
  } else {
    if (row.payout_state === 'not_closed') return undefined;
    parts.push('К выплате (ФОТ)');
    if (row.deducted && Number(row.deducted) > 0) parts.push(`удержано ${formatSalaryAmount(row.deducted)}`);
  }
  const missing = calcMissingNote(row.missing ?? []);
  if (missing) parts.push(missing);
  return parts.join(' · ');
};

/**
 * Подсказка «Оклада» / «Переработки»: из скольких дней или часов («22 из 22 дн.», «2 ч»); строки нет (нет
 * переработки) или посчитать нечем — без подсказки.
 */
export const salaryLineTitle = (
  row: ITimesheetSalaryRow,
  line: IPayrollCalcLine | null | undefined,
): string | undefined => {
  if (row.payout_state === 'not_closed') return undefined;
  return (line ? calcLineDaysNote(line) : null) ?? undefined;
};

/** Подпись под суммой «Переработки»: часы будней и выходы сверх нормы («1 вых. · 2 ч»); у других строк — null. */
export const salaryOvertimeNote = (line: IPayrollCalcLine | null | undefined): string | null => (
  line?.code === 'overtime' ? calcLineDaysNote(line) : null
);

/** Буквы вкладки «Зарплата», под которыми — часы дня: удалёнка, работа на больничном, учебный день. */
const SALARY_LETTER_LABELS: Partial<Record<TimesheetStatus, string>> = { remote: 'УУ', sick_worked: 'РБ', study_day: 'УД' };

export interface ISalaryLetterHours {
  label: string;
  hours: number;
  /** override — часы правки «УУ» (по ним же переработка), schedule — норма дня по графику. */
  source: 'override' | 'schedule';
}

/**
 * Часы под буквой во вкладке «Зарплата», целыми, как цифры в клетках: «УУ» с правкой часов — часы правки; иначе «УУ»,
 * «РБ», «УД» — норма дня по графику (ручные «УУ» часто с 0 ч). У студенческого графика 1С ставит за РБ/УД 8 ч (7 ч
 * в предпраздник) — здесь норма графика. Нормы нет (выходной по графику) — null, в клетке только буква.
 */
export const getSalaryLetterHours = (
  entry: Pick<TimesheetEntry, 'status' | 'hours_worked' | 'hours_overridden'> | null | undefined,
  normHours: number,
): ISalaryLetterHours | null => {
  const label = entry ? SALARY_LETTER_LABELS[entry.status] : undefined;
  if (!entry || !label) return null;
  const overrideHours = entry.status === 'remote' && entry.hours_overridden ? Math.round(entry.hours_worked ?? 0) : 0;
  if (overrideHours > 0) return { label, hours: overrideHours, source: 'override' };
  const hours = Math.round(normHours);
  return hours > 0 ? { label, hours, source: 'schedule' } : null;
};

const SALARY_ERROR_LABELS: Record<TimesheetSalaryErrorCode, string> = {
  no_schedule: 'нет графика',
  unknown_status: 'неизвестный статус дня',
  duplicate_day: 'день в двух подачах',
  object_config: 'не задан объект табелирования',
};

const formatDayMonth = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

export interface ISalaryStateNote {
  text: string;
  tone: 'muted' | 'ok' | 'warn' | 'error';
  title?: string;
}

/**
 * Пометка состояния сумм бригады — только предупреждения: ошибка расчёта и «Требует перерасчёта». Закрыт табель или
 * нет, не пишем (решение 29.10.2026, как у отделов).
 */
export const describeSalaryState = (data: ITimesheetSalaryResponse): ISalaryStateNote | null => {
  if (data.distribution === 'error' && data.errors.length > 0) {
    const first = data.errors[0];
    const more = data.errors.length > 1 ? ` (ещё ${data.errors.length - 1})` : '';
    return {
      text: `Ошибка: ${SALARY_ERROR_LABELS[first.code]} — ${formatTimesheetEmployeeName(first.full_name)}${more}`,
      tone: 'error',
      title: data.errors
        .map(error => `${formatTimesheetEmployeeName(error.full_name)}${error.date ? `, ${formatDayMonth(error.date)}` : ''}: `
          + SALARY_ERROR_LABELS[error.code])
        .join('\n'),
    };
  }
  if (data.state === 'stale') return { text: 'Требует перерасчёта — табель открыт', tone: 'warn' };
  return null;
};

/** Пометка объекта под полем «Выработка»: не внесена / некому распределить; внесена — null. */
export const salaryObjectStateNote = (object: ITimesheetSalaryObject): string | null => {
  if (object.state === 'no_output') return 'не внесена';
  if (object.state === 'nothing_to_distribute') return 'некому распределить — часов нет';
  return null;
};

const decimalText = (value: number): string => String(Math.round(value * 100) / 100).replace('.', ',');

/**
 * Подсказка доли на объекте — из тех же целых весов, что расчёт: «228 000,00 × КТУ 1,0 × 10 ч / 38 (Σ КТУ × ч
 * объекта) = 60 000,00». Выработки нет — «выработка не внесена»; часов нет — без подсказки.
 */
export const objectShareTitle = (
  object: ITimesheetSalaryObject,
  member: ITimesheetSalaryObjectMember,
): string | undefined => {
  if (member.counted_minutes <= 0) return undefined;
  if (object.output_amount === null) return 'выработка не внесена';
  if (member.share === null || object.total_weight <= 0) return undefined;
  const ktu = decimalText(member.weight / member.counted_minutes / 10);
  return `${formatSalaryAmount(object.output_amount)} × КТУ ${ktu} × ${decimalText(member.counted_minutes / 60)} ч`
    + ` / ${decimalText(object.total_weight / 600)} (Σ КТУ × ч объекта) = ${formatSalaryAmount(member.share)}`;
};

/** Объекты, где у сотрудника есть учтённые часы, а выработка не внесена, — «выработка не внесена: ЖК Stories». */
export const missingObjectsNote = (data: ITimesheetSalaryResponse, employeeId: number): string | null => {
  const names = (data.objects ?? [])
    .filter(object => object.output_amount === null && object.members.some(member => (
      member.employee_id === employeeId && member.counted_minutes > 0
    )))
    .map(object => object.object_name);
  return names.length > 0 ? `выработка не внесена: ${names.join(', ')}` : null;
};

/**
 * Часы сотрудника по дням на всех объектах — для строки «Итого по бригаде»: часы дня складываются по объектам точно,
 * округляет их показ (formatDayHours), как дневную клетку «По сотрудникам».
 */
export const totalDaysOfEmployee = (data: ITimesheetSalaryResponse, employeeId: number): Record<string, number> => {
  const total: Record<string, number> = {};
  for (const object of data.objects ?? []) {
    const member = object.members.find(item => item.employee_id === employeeId);
    if (!member) continue;
    for (const [date, hours] of Object.entries(member.days)) {
      total[date] = Math.round(((total[date] ?? 0) + hours) * 100) / 100;
    }
  }
  return total;
};

/** Часы клетки дня — целыми, как в сетке табеля (8,5 → «9», 0,42 → «0»); дня нет — пусто. */
export const formatDayHours = (hours: number | undefined): string => (
  hours === undefined ? '' : String(Math.round(hours))
);

/** «Часы» строки и групп — сумма видимых (округлённых) цифр по дням, как в сетке табеля. */
export const displayedHours = (days: Record<string, number>): number => (
  Object.values(days).reduce((sum, hours) => sum + Math.round(hours), 0)
);

/** Выработку на объекте без часов бригады можно только стереть. */
export const isOutputClearOnly = (object: ITimesheetSalaryObject): boolean => (
  object.members.length === 0 && object.output_amount !== null
);

/** Строки бригады по ФИО: для «Итого» и порядка рабочих в группах. */
export const sortSalaryRows = (rows: readonly ITimesheetSalaryRow[]): ITimesheetSalaryRow[] => (
  [...rows].sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '', 'ru') || a.employee_id - b.employee_id)
);
