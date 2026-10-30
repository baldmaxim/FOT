/**
 * «К выплате (ФОТ)» — расчёт ФОТ по табелю (сервер, миграция 331): закрытый месяц — по основе закрытых подач,
 * незакрытый — по живому табелю; на экране одинаково, без пометки о закрытии. Подписи строк, дней, формул и пометок
 * для «Подробно» и расчётного листка. Строки — те же статьи, что в «Оплачено» (1С), с теми же подписями: сравнение
 * построчно. Итог — начислено минус удержано, без НДФЛ, как «Выплачено»; сумму строки ФОТ не посчитал (выработка
 * бригады не введена, почасовые условия…) — итога нет. Отпускные и больничные — суммы 1С («Оплачено», нет его —
 * ведомости выплаты) строками расчёта; сумм нет, а дни отпуска есть — под итогом «без: отпускные». KPI и прочие
 * статьи 1С ФОТ не считает.
 */
import type {
  IPayrollCalcLine,
  PayrollAbsenceStatus,
  PayrollCalc,
  PayrollCalcCounted,
  PayrollCalcLineCode,
  PayrollCalcLinePart,
  PayrollCalcMissing,
  PayrollPaidItemCode,
} from '../services/payrollService';
import { formatPaidAmount, PAYROLL_PAID_GROUPS } from './payrollPaid';

/** Порядок строк — как в листке ЗУП. */
export const PAYROLL_CALC_LINE_ORDER: readonly PayrollCalcLineCode[] = [
  'contract', 'brigade', 'bonus', 'supplement', 'overtime', 'travel', 'housing', 'vacation', 'sick_leave',
];

const PAID_LABELS = new Map<PayrollPaidItemCode, string>(
  PAYROLL_PAID_GROUPS.flatMap(group => group.items.map(item => [item.code, item.label] as const)),
);

/** Подпись строки расчёта — как у статьи «Оплачено» с тем же кодом; доля бригады — своя. */
export const calcLineLabel = (code: PayrollCalcLineCode): string => (
  code === 'brigade' ? 'Выработка бригады' : PAID_LABELS.get(code) ?? code
);

/**
 * Статья «Оплачено» (1С) для сравнения строки: доля бригады — «По трудовому договору» (так её проводит ЗУП),
 * если оклада в расчёте нет; иначе сравнивать не с чем.
 */
export const calcLinePaidItem = (
  line: IPayrollCalcLine,
  lines: readonly IPayrollCalcLine[],
): PayrollPaidItemCode | null => {
  if (line.code !== 'brigade') return line.code;
  return lines.some(item => item.code === 'contract') ? null : 'contract';
};

/** «КТУ 1,5 · 176 ч» у доли бригады. */
const formatBrigadeNote = (brigade: { ktu: string; hours: number }): string => (
  `КТУ ${brigade.ktu.replace('.', ',')} · ${String(brigade.hours).replace('.', ',')} ч`
);

/** «22 из 23 дн.», у переработки — «2 вых. · 6 ч», у доли бригады — «КТУ 1,5 · 176 ч»; дней нет — null. */
export const calcLineDaysNote = (line: IPayrollCalcLine): string | null => {
  if (line.brigade) return formatBrigadeNote(line.brigade);
  if (line.code === 'overtime') {
    const parts = [
      ...(line.days?.worked ? [`${line.days.worked} вых.`] : []),
      ...(line.hours ? [`${String(line.hours).replace('.', ',')} ч`] : []),
    ];
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (!line.days) return null;
  return line.days.norm === null ? null : `${line.days.worked} из ${line.days.norm} дн.`;
};

const MISSING_LABELS: Record<PayrollCalcMissing, string> = {
  vacation_pay: 'отпускные',
  sick_pay: 'больничные',
  educational_pay: 'учебный отпуск',
  hourly: 'почасовая оплата',
  no_terms: 'нет условий оплаты',
  no_norm: 'нет нормы графика',
  brigade_output: 'выработка бригады',
  brigade_no_hours: 'доля бригады — нет учтённых часов',
  brigade_error: 'расчёт бригады',
};

/** «без: отпускные, больничные» — что не вошло в итог; всё посчитано — null. */
export const calcMissingNote = (missing: readonly PayrollCalcMissing[]): string | null => (
  missing.length > 0 ? `без: ${missing.map(code => MISSING_LABELS[code]).join(', ')}` : null
);

export const CALC_ABSENCE_LABELS: Record<PayrollAbsenceStatus, string> = {
  vacation: 'Отпуск',
  sick: 'Больничный',
  educational_leave: 'Учебный отпуск',
  unpaid: 'Без сохранения ЗП',
};

const ABSENCE_ORDER: readonly PayrollAbsenceStatus[] = ['vacation', 'sick', 'educational_leave', 'unpaid'];

/** Месяц посчитан — закрытый или предварительно по живому табелю; иначе посчитать нечем. */
export const isCalcCounted = (calc: PayrollCalc | undefined): calc is PayrollCalcCounted => (
  calc?.state === 'closed' || calc?.state === 'preliminary'
);

/** Статус отсутствия, дни которого оплачивает строка (отпускные и больничные из 1С); у прочих строк — null. */
export const calcLineAbsence = (code: PayrollCalcLineCode): PayrollAbsenceStatus | null => {
  if (code === 'vacation') return 'vacation';
  return code === 'sick_leave' ? 'sick' : null;
};

/** Отсутствия месяца с днями: суммы отпускных и больничных — только из 1С. */
export const calcAbsenceLines = (calc: PayrollCalcCounted): Array<{ status: PayrollAbsenceStatus; label: string; days: number }> => (
  ABSENCE_ORDER
    .filter(status => (calc.absences[status] ?? 0) > 0)
    .map(status => ({ status, label: CALC_ABSENCE_LABELS[status], days: calc.absences[status] }))
);

/** Строки расчёта в порядке листка. */
export const calcLines = (calc: PayrollCalcCounted): IPayrollCalcLine[] => (
  PAYROLL_CALC_LINE_ORDER.flatMap(code => calc.lines.filter(line => line.code === code))
);

/** «253189.50» → 253 189,50 ₽ числом; не число — null. */
export const calcAmount = (amount: string | null | undefined): number | null => {
  if (amount === null || amount === undefined) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? value : null;
};

/** Сумма «К выплате (ФОТ)» за месяцы — только если итог известен в каждом; иначе null. Счёт в копейках. */
export const calcNetTotal = (calcs: ReadonlyArray<PayrollCalc | undefined>): number | null => {
  let cents = 0;
  for (const calc of calcs) {
    if (!isCalcCounted(calc) || calc.net === null) return null;
    cents += Math.round(Number(calc.net) * 100);
  }
  return cents / 100;
};

const money = (amount: string): string => formatPaidAmount(Number(amount));

/** '2.5' → '2,5'; до двух знаков. */
const decimal = (value: number): string => String(Math.round(value * 100) / 100).replace('.', ',');

/** YYYY-MM-DD → ДД.ММ. */
const dayMonth = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/** YYYY-MM-DD → ДД.ММ.ГГГГ. */
const fullDate = (iso: string): string => `${dayMonth(iso)}.${iso.slice(0, 4)}`;

/** Одна строка формулы части; equals — дописать «= сумма» (частей у строки несколько). */
const partFormula = (part: PayrollCalcLinePart, equals: boolean): string => {
  const tail = (amount: string | null): string => (equals && amount !== null ? ` = ${money(amount)}` : '');
  switch (part.kind) {
    case 'salary': {
      const base = Number(part.bonus) > 0
        ? `(оклад ${money(part.salary)} + премиальная ${money(part.bonus)})`
        : `оклад ${money(part.salary)}`;
      if (part.rounding === 'daily_kopeck' && part.daily_rate) {
        return `${base} / ${part.norm} дн. = ${money(part.daily_rate)} × ${part.days} дн.${tail(part.amount)}`;
      }
      return `${base} × ${part.days} / ${part.norm} дн.${tail(part.amount)}`;
    }
    case 'planned_supplement':
      return `плановая доплата ${money(part.base)} × ${part.days} / ${part.norm} дн.${tail(part.amount)}`;
    case 'overtime_days':
      return `${part.days} вых. × ${money(part.salary)} / ${part.norm} дн.${tail(part.amount)}`;
    case 'overtime_hours':
      return `${decimal(part.minutes / 60)} ч × ${money(part.salary)} / ${decimal(part.norm_minutes / 60)} ч${tail(part.amount)}`;
    case 'travel':
      return `ставка ${money(part.rate)} × ${part.days} / ${part.norm} дн.`;
    case 'housing':
      return part.housing === 'apartment' ? 'квартира, сумма за месяц' : 'доплата за общежитие, сумма за месяц';
    case 'one_time':
      return 'разовые доплаты месяца';
    case 'paid_1c':
      return 'начислено в 1С';
    case 'payout_1c':
      return `ведомость № ${part.doc_number} от ${fullDate(part.doc_date)}${tail(part.amount)}`;
    case 'brigade': {
      // Выработка по объектам (336): часть — объект; без объекта — нет учтённых часов на объектах (или старый бэкенд).
      const objectName = part.object_name ?? null;
      const prefix = objectName ? `${objectName}: ` : '';
      if (part.output === null) return objectName ? `${prefix}выработка не внесена` : 'выработка бригады не внесена';
      if (part.amount === null) {
        if (part.total_weight !== 0) return `${prefix}ошибка расчёта бригады`;
        return objectName ? `${prefix}нет учтённых часов` : 'нет учтённых часов бригады';
      }
      if (!objectName && part.total_weight === 0) return `нет учтённых часов на объектах = ${money(part.amount)}`;
      // Вес — КТУ × часы; в БД — КТУ в десятых × минуты, отсюда / 600.
      const ktu = decimal(part.ktu_tenths / 10);
      const hours = decimal(part.counted_minutes / 60);
      const scope = objectName ? 'объекта' : 'бригады';
      return `${prefix}выработка ${money(part.output)} × КТУ ${ktu} × ${hours} ч / ${decimal(part.total_weight / 600)} `
        + `(Σ КТУ × ч ${scope}) = ${money(part.amount)}`;
    }
  }
};

/**
 * Расшифровка строки расчёта — подстрока на часть: «оклад 150 000,00 × 22 / 22 дн.», у нескольких сегментов —
 * «с 01.09 по 15.09: … = …»; выходы, добравшие норму, — «22 дн. = 20 раб. + 2 вых. (добор нормы)»; у отпускных и
 * больничных первой строкой — дни («9 дн.»), ниже — откуда сумма. Частей нет (старый бэкенд) — прежняя подпись дней.
 */
export const calcLineFormula = (line: IPayrollCalcLine): string[] => {
  const parts = line.parts ?? [];
  if (parts.length === 0) {
    const note = calcLineDaysNote(line);
    return note ? [note] : [];
  }
  const periods = new Set(parts.map(part => ('from' in part ? `${part.from}|${part.to}` : '')));
  const withPeriod = periods.size > 1;
  const result = parts.map(part => {
    const text = partFormula(part, parts.length > 1);
    return withPeriod && 'from' in part ? `с ${dayMonth(part.from)} по ${dayMonth(part.to)}: ${text}` : text;
  });
  if (line.code === 'contract' && line.filled_dayoffs && line.days) {
    result.push(`${line.days.worked} дн. = ${line.days.worked - line.filled_dayoffs} раб. + ${line.filled_dayoffs} вых. (добор нормы)`);
  }
  if (calcLineAbsence(line.code) && line.days?.worked) result.unshift(`${line.days.worked} дн.`);
  return result;
};

/** Блоки 1С листка показывать: суммы 1С за месяц есть или расчёта ФОТ нет — иначе таблицы из одних прочерков. */
export const payslipShow1c = (hasPaid: boolean, calc: PayrollCalc | undefined): boolean => hasPaid || !isCalcCounted(calc);

/**
 * «Остаток (с НДФЛ)» — итог ФОТ минус перечисленное по ведомостям 1С, в копейках; минус — переплата. Итога нет или
 * перечисления не загрузились ('error') — null: нельзя показать весь ФОТ остатком.
 */
export const payslipRemainder = (calc: PayrollCalc | undefined, transferred: number | 'error'): number | null => {
  if (!isCalcCounted(calc) || calc.net === null || transferred === 'error') return null;
  return (Math.round(Number(calc.net) * 100) - Math.round(transferred * 100)) / 100;
};
