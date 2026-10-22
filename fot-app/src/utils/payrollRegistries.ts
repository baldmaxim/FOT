import type { IPayrollDormitoryStay } from '../services/dormitoryService';
import type {
  ICompensationStop,
  IDormitoryAllowanceRow,
  IDormitoryStayPeriod,
  IHousingAllowanceRow,
  IPayrollSupplementRow,
} from '../services/payrollRegistryService';
import type { IPayrollRateValue } from '../services/payrollService';
import { formatDate, formatMonthLabel } from './formatMoney';
import { moscowTodayIso, shiftMonth } from './moscowDate';
import { formatPayrollMoney } from './payrollFormat';
import { rateValueOn } from './payrollRates';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблицы окна «Справочник» на «Расчётах»: столбцы для экрана, сортировки, фильтров и выгрузки в xlsx
 * (общие функции — в tableView.ts). Экран и xlsx строятся из одних описаний — разойтись не могут.
 */

interface IEmployeeRow {
  full_name: string;
  department: string | null;
  position: string | null;
}

const orDash = (value: string | null): string => value || '—';
const money = (value: string | null): string => formatPayrollMoney(value) ?? '—';
const moneySort = (value: string | null): number | null => (value === null ? null : Number(value));

/** ФИО, Отдел, Должность — первые три столбца каждой таблицы; ширины уже — где столбцов больше. */
const employeeColumns = <Row extends IEmployeeRow>(widths = { department: 140, position: 148 }): Array<IRegistryColumn<Row>> => [
  { key: 'full_name', label: 'ФИО', type: 'text', text: row => row.full_name, sortValue: row => row.full_name },
  {
    key: 'department', label: 'Отдел', type: 'text', width: widths.department,
    text: row => orDash(row.department), sortValue: row => row.department,
  },
  {
    key: 'position', label: 'Должность', type: 'text', width: widths.position,
    text: row => orDash(row.position), sortValue: row => row.position,
  },
];

const moneyColumn = <Row,>(label: string, value: (row: Row) => string | null, width = 128): IRegistryColumn<Row> => ({
  key: 'amount',
  label,
  type: 'money',
  width,
  nowrap: true,
  numeric: true,
  text: row => money(value(row)),
  sortValue: row => moneySort(value(row)),
  exportValue: row => value(row),
});

const dateColumn = <Row,>(key: string, label: string, value: (row: Row) => string | null, width = 112): IRegistryColumn<Row> => ({
  key,
  label,
  type: 'text',
  width,
  nowrap: true,
  text: row => formatDate(value(row)),
  sortValue: row => value(row),
});

/** Квартиры «Проживания»: семь столбцов — отдел и должность уже, как у «Доплаты», без прокрутки в окне на 1280px. */
export const HOUSING_COLUMNS: ReadonlyArray<IRegistryColumn<IHousingAllowanceRow>> = [
  ...employeeColumns<IHousingAllowanceRow>({ department: 112, position: 144 }),
  moneyColumn<IHousingAllowanceRow>('Сумма, ₽/мес', row => row.amount),
  dateColumn<IHousingAllowanceRow>('check_in', 'Въезд', row => row.check_in),
  {
    // Пусто — живёт.
    key: 'check_out', label: 'Выезд', type: 'text', width: 112, nowrap: true,
    text: row => (row.check_out ? formatDate(row.check_out) : '—'),
    sortValue: row => row.check_out,
  },
  {
    key: 'address', label: 'Адрес', type: 'text', width: 152,
    text: row => orDash(row.address), sortValue: row => row.address,
  },
];

/** Период доплаты: плановая — «01.10.2026 – 31.12.2026», разовая — «октябрь 2026». */
export const supplementPeriod = (row: IPayrollSupplementRow): string => (
  row.kind === 'one_time'
    ? (row.month ? formatMonthLabel(row.month) : '—')
    : row.date_to ? `${formatDate(row.date_from)} – ${formatDate(row.date_to)}` : `с ${formatDate(row.date_from)}`
);

export const SUPPLEMENT_KIND_LABELS: Record<IPayrollSupplementRow['kind'], string> = {
  planned: 'Плановая',
  one_time: 'Разовая',
};

/** Семь столбцов: отдел и должность уже — таблица без прокрутки влезает в окно на 1280px. */
export const SUPPLEMENT_COLUMNS: ReadonlyArray<IRegistryColumn<IPayrollSupplementRow>> = [
  ...employeeColumns<IPayrollSupplementRow>({ department: 112, position: 144 }),
  {
    key: 'kind', label: 'Вид', type: 'text', width: 92, nowrap: true,
    text: row => SUPPLEMENT_KIND_LABELS[row.kind], sortValue: row => SUPPLEMENT_KIND_LABELS[row.kind],
  },
  moneyColumn<IPayrollSupplementRow>('Сумма, ₽', row => row.amount, 112),
  {
    key: 'period', label: 'Период', type: 'text', width: 190, nowrap: true,
    text: supplementPeriod,
    // Разовая — с первого числа месяца: в одном порядке с плановыми.
    sortValue: row => (row.kind === 'one_time' ? (row.month ? `${row.month}-01` : null) : row.date_from),
  },
  {
    key: 'reason', label: 'Основание', type: 'text', width: 144,
    text: row => orDash(row.reason), sortValue: row => row.reason,
  },
];

export const COMPENSATION_STOP_COLUMNS: ReadonlyArray<IRegistryColumn<ICompensationStop>> = [
  ...employeeColumns<ICompensationStop>(),
  // Заголовок одной строкой: «БЕЗ ПРОЕЗДА С» + стрелка и воронка.
  dateColumn<ICompensationStop>('date_from', 'Без проезда с', row => row.date_from, 170),
  {
    // Пусто — бессрочно: выплату ещё не возобновили.
    key: 'date_to', label: 'По', type: 'text', width: 112, nowrap: true,
    text: row => (row.date_to ? formatDate(row.date_to) : 'бессрочно'),
    sortValue: row => row.date_to,
  },
];

/**
 * Строка таблицы «Общежитие»: проживание в общежитии (ведут кадры, здесь только 🗑) или «Доплата за
 * общежитие» — общежитие не назначено, платят значение ставки.
 */
export interface IDormitoryRegistryRow {
  /** stay:<id> / allowance:<id> — id двух таблиц могут совпасть. */
  key: string;
  full_name: string;
  department: string | null;
  position: string | null;
  /** Адрес общежития; у доплаты — null. */
  address: string | null;
  /** Въезд или «доплата с». */
  date_from: string;
  /** Выезд (в этот день уже не живёт) или «по» доплаты включительно; null — живёт / бессрочно. */
  date_to: string | null;
  /** Только у доплаты: ставка «Доплата за общежитие» за последний подходящий выбранный месяц; не задана — null. */
  amount: string | null;
  /** Строка доплаты — её правят и убирают; у проживания null. */
  allowance: IDormitoryAllowanceRow | null;
  /** Строка проживания — её только убирают (🗑); у доплаты null. */
  stay: IPayrollDormitoryStay | null;
}

const NOT_ASSIGNED = 'Не назначено';

/** Семь столбцов: отдел и должность уже, как у «Доплаты», — без прокрутки в окне на 1280px. */
export const DORMITORY_REGISTRY_COLUMNS: ReadonlyArray<IRegistryColumn<IDormitoryRegistryRow>> = [
  ...employeeColumns<IDormitoryRegistryRow>({ department: 112, position: 144 }),
  {
    key: 'address', label: 'Общежитие', type: 'text', width: 152,
    text: row => (row.allowance ? NOT_ASSIGNED : orDash(row.address)),
    sortValue: row => (row.allowance ? NOT_ASSIGNED : row.address),
  },
  dateColumn<IDormitoryRegistryRow>('date_from', 'С', row => row.date_from),
  {
    // Пусто: живёт — «—», доплату ещё не прекратили — «бессрочно».
    key: 'date_to', label: 'По', type: 'text', width: 112, nowrap: true,
    text: row => (row.date_to ? formatDate(row.date_to) : (row.allowance ? 'бессрочно' : '—')),
    sortValue: row => row.date_to,
  },
  // Значение ставки — одно на всех; у живущих и пока ставка не задана — «—».
  moneyColumn<IDormitoryRegistryRow>('Доплата, ₽/мес', row => row.amount),
];

/** Снимок xlsx таблицы: «Название_2026-10-19.xlsx», подзаголовок — дата выгрузки. */
const buildSnapshot = <Row,>(title: string, columns: ReadonlyArray<IRegistryColumn<Row>>) =>
  (rows: ReadonlyArray<Row>): ITableExportSnapshot => {
    const isoDate = moscowTodayIso();
    return buildExportTable({
      title,
      subtitle: `Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
      fileName: `${title.replace(/\s+/g, '_')}_${isoDate}.xlsx`,
      columns,
      rows,
    });
  };

export const buildHousingExport = buildSnapshot('Доплата за проживание', HOUSING_COLUMNS);
export const buildSupplementExport = buildSnapshot('Доплата', SUPPLEMENT_COLUMNS);
export const buildCompensationStopExport = buildSnapshot('Без проезда', COMPENSATION_STOP_COLUMNS);
export const buildDormitoryRegistryExport = buildSnapshot('Общежитие', DORMITORY_REGISTRY_COLUMNS);

/**
 * Ключ строки «Доплаты»: у плановой — версия журнала (у сотрудника бывают прошлые периоды; старый бэкенд
 * id не отдаёт — тогда сотрудник), у разовой — её id.
 */
export const supplementRowKey = (row: IPayrollSupplementRow): string => (
  row.kind === 'planned' ? `planned-${row.id ?? row.employee_id}` : `once-${row.id}`
);

/** Выбор месяца в таблицах «Справочника»: 24 месяца назад и 12 вперёд (доплаты и «Без проезда» бывают будущими). */
const REGISTRY_MONTHS_BACK = 24;
const REGISTRY_MONTHS_AHEAD = 12;

export const registryMonthOptions = (currentMonth: string): string[] => (
  Array.from(
    { length: REGISTRY_MONTHS_BACK + REGISTRY_MONTHS_AHEAD + 1 },
    (_, index) => shiftMonth(currentMonth, index - REGISTRY_MONTHS_BACK),
  )
);

/** ?months= сервера: пустой выбор («Весь период») — 'all', иначе месяцы через запятую. */
export const registryMonthsParam = (months: ReadonlyArray<string>): string => (
  months.length === 0 ? 'all' : [...months].sort().join(',')
);

/** Последний день месяца YYYY-MM: «2026-02» → «2026-02-28». */
const monthEnd = (month: string): string => {
  const [year, monthNumber] = month.split('-').map(Number);
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
};

/** Что делает 🗑 с периодом: закрыть датой «по» (прошлые месяцы остаются историей) или удалить строку. */
export type RegistryRemoval =
  // cutoff — с этого дня убран (1-е число текущего месяца), dateTo — новая дата «по».
  | { action: 'close'; cutoff: string; dateTo: string }
  | { action: 'delete' };

/**
 * 🗑 в таблицах периодов «Справочника» убирает сотрудника с 1-го числа текущего месяца: период закрывается
 * последним днём прошлого месяца — в прошлых месяцах строка остаётся. Период, который к этому дню ещё не
 * начался или уже целиком позади, — ошибочная строка: удаляется.
 */
export const registryRemoval = (
  period: { date_from: string; date_to: string | null },
  todayIso: string,
): RegistryRemoval => {
  const month = todayIso.slice(0, 7);
  const cutoff = `${month}-01`;
  if (period.date_from >= cutoff || (period.date_to !== null && period.date_to < cutoff)) return { action: 'delete' };
  return { action: 'close', cutoff, dateTo: monthEnd(shiftMonth(month, -1)) };
};

/** День до даты YYYY-MM-DD: «2026-12-01» → «2026-11-30». */
const dayBefore = (iso: string): string => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};

/**
 * 🗑 у проживания — квартиры в «Доплате за проживание», общежития в «Общежитии» — то же правило, что у периодов
 * «Справочника»: выезд ставится 1-м числом текущего месяца (в прошлых месяцах строка остаётся), не начавшееся
 * или прошедшее проживание удаляется. Выезд — день, когда уже не живёт, поэтому «по» периода = день до выезда.
 */
export const stayRemoval = (
  stay: { check_in: string; check_out: string | null },
  todayIso: string,
): { action: 'close'; checkOut: string } | { action: 'delete' } => {
  const removal = registryRemoval(
    { date_from: stay.check_in, date_to: stay.check_out === null ? null : dayBefore(stay.check_out) },
    todayIso,
  );
  return removal.action === 'close' ? { action: 'close', checkOut: removal.cutoff } : removal;
};

/**
 * Период «с — по» (даты YYYY-MM-DD включительно; null — без границы) задевает хоть один из месяцев.
 * Пустой выбор — «Весь период»: подходит любой.
 */
export const periodIntersectsMonths = (
  from: string | null,
  to: string | null,
  months: ReadonlyArray<string>,
): boolean => (
  months.length === 0
  || months.some(month => (from === null || from <= monthEnd(month)) && (to === null || to >= `${month}-01`))
);

/** «Доплата» в месяцах: разовая — её месяц выбран, плановая — её период задевает выбранные месяцы. */
export const supplementInMonths = (row: IPayrollSupplementRow, months: ReadonlyArray<string>): boolean => (
  row.kind === 'one_time'
    ? months.length === 0 || (row.month !== null && months.includes(row.month))
    : periodIntersectsMonths(row.date_from, row.date_to, months)
);

/** «Без проезда» в месяцах: период (пустое «по» — бессрочно) задевает выбранные месяцы. */
export const stopInMonths = (stop: ICompensationStop, months: ReadonlyArray<string>): boolean => (
  periodIntersectsMonths(stop.date_from, stop.date_to, months)
);

/** Проживание [въезд, выезд) задевает месяц: в день выезда сотрудник в общежитии уже не живёт. */
const stayTouchesMonth = (stay: IDormitoryStayPeriod, month: string): boolean => (
  stay.check_in <= monthEnd(month) && (stay.check_out === null || stay.check_out > `${month}-01`)
);

/** Доплата за общежитие положена в месяце: период задевает его и сотрудник в нём не жил в общежитии. */
const allowanceInMonth = (row: IDormitoryAllowanceRow, month: string): boolean => (
  periodIntersectsMonths(row.date_from, row.date_to, [month])
  && !row.dormitory_stays.some(stay => stayTouchesMonth(stay, month))
);

/**
 * «Доплата за общежитие» в месяцах: «Весь период» — все строки; иначе есть выбранный месяц, который задевает
 * период доплаты и в котором сотрудник не жил в общежитии (заселили позже — в месяцах проживания строки нет).
 */
export const dormitoryAllowanceInMonths = (row: IDormitoryAllowanceRow, months: ReadonlyArray<string>): boolean => (
  months.length === 0 || months.some(month => allowanceInMonth(row, month))
);

/**
 * Сумма строки доплаты за общежитие — ставка за последний выбранный месяц, в который доплата положена
 * (несколько месяцев с разными ставками — ставка последнего). Нет истории ставки или выбора — сумма сервера.
 */
const dormitoryAllowanceAmount = (
  row: IDormitoryAllowanceRow,
  months: ReadonlyArray<string>,
  rateValues: ReadonlyArray<IPayrollRateValue> | undefined,
): string | null => {
  const month = [...months].sort().reverse().find(candidate => allowanceInMonth(row, candidate));
  return rateValues && month ? rateValueOn(rateValues, month) : row.amount;
};

/**
 * Строки таблицы «Общежитие» в выбранных месяцах: кто живёт в общежитии (проживание задевает месяц) и кому
 * «Доплата за общежитие» (правило dormitoryAllowanceInMonths). «Весь период» — все строки.
 */
export const buildDormitoryRegistryRows = (
  stays: ReadonlyArray<IPayrollDormitoryStay>,
  allowances: ReadonlyArray<IDormitoryAllowanceRow>,
  months: ReadonlyArray<string>,
  allowanceRateValues?: ReadonlyArray<IPayrollRateValue>,
): IDormitoryRegistryRow[] => [
  ...stays
    .filter(stay => months.length === 0 || months.some(month => stayTouchesMonth(stay, month)))
    .map(stay => ({
      key: `stay:${stay.id}`,
      full_name: stay.full_name,
      department: stay.department,
      position: stay.position,
      address: stay.address,
      date_from: stay.check_in,
      date_to: stay.check_out,
      amount: null,
      allowance: null,
      stay,
    })),
  ...allowances
    .filter(row => dormitoryAllowanceInMonths(row, months))
    .map(row => ({
      key: `allowance:${row.id}`,
      full_name: row.full_name,
      department: row.department,
      position: row.position,
      address: null,
      date_from: row.date_from,
      date_to: row.date_to,
      amount: dormitoryAllowanceAmount(row, months, allowanceRateValues),
      allowance: row,
      stay: null,
    })),
];
