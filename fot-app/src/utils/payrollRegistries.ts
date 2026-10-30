import type { IPayrollDormitoryStay } from '../services/dormitoryService';
import type {
  ICompensationStop,
  IDormitoryStayPeriod,
  IHousingAllowanceRow,
  IOvertimeStop,
  IPayrollSupplementRow,
  PayrollSupplementKind,
} from '../services/payrollRegistryService';
import { formatDate, formatMonthLabel } from './formatMoney';
import { moscowTodayIso, shiftMonth } from './moscowDate';
import { formatPayrollMoney } from './payrollFormat';
import {
  buildExportTable,
  type IRegistryColumn,
  type IRegistryRowGroup,
  type ITableExportSnapshot,
} from './tableView';

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

/** «Квартира» (квартиры «Проживания»): семь столбцов — отдел и должность уже, как у «Доплаты», без прокрутки в окне на 1280px. */
export const HOUSING_COLUMNS: ReadonlyArray<IRegistryColumn<IHousingAllowanceRow>> = [
  ...employeeColumns<IHousingAllowanceRow>({ department: 112, position: 144 }),
  // Ставка за день (миграция 339): расчёт — ставка × дни проживания без отпуска и больничного.
  moneyColumn<IHousingAllowanceRow>('Ставка, ₽/день', row => row.amount),
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

/**
 * Вид строки общей таблицы «Доплата»: плановая, разовая или квартира «Проживания». 'apartment' — внутренний:
 * ✎ и 🗑 открывают окно квартиры, а на экране и в xlsx это «Плановая» с основанием «Квартира».
 */
export type SupplementRowKind = PayrollSupplementKind | 'apartment';

/** Основание строки квартиры в общей таблице «Доплата»: сумма у неё — ставка за день, а не за месяц. */
export const APARTMENT_REASON = 'Квартира, ₽/день';

/** Поля периода доплаты: у разовой — месяц, у плановой и квартиры — даты «с — по» включительно. */
interface ISupplementPeriodFields {
  kind: SupplementRowKind;
  month: string | null;
  date_from: string | null;
  date_to: string | null;
}

/** Период доплаты: плановая и квартира — «01.10.2026 – 31.12.2026» или «с 01.10.2026», разовая — «октябрь 2026». */
export const supplementPeriod = (row: ISupplementPeriodFields): string => (
  row.kind === 'one_time'
    ? (row.month ? formatMonthLabel(row.month) : '—')
    : row.date_to ? `${formatDate(row.date_from)} – ${formatDate(row.date_to)}` : `с ${formatDate(row.date_from)}`
);

/** Начало периода для сортировки: разовая — с первого числа месяца, в одном порядке с плановыми. */
const supplementPeriodSort = (row: ISupplementPeriodFields): string | null => (
  row.kind === 'one_time' ? (row.month ? `${row.month}-01` : null) : row.date_from
);

export const SUPPLEMENT_KIND_LABELS: Record<PayrollSupplementKind, string> = {
  planned: 'Плановая',
  one_time: 'Разовая',
};

/** «Вид» на экране и в xlsx: квартира — «Плановая» (её месяц — тоже ежемесячная доплата). */
const supplementKindLabel = (kind: SupplementRowKind): string => SUPPLEMENT_KIND_LABELS[kind === 'apartment' ? 'planned' : kind];

/**
 * Строка общей таблицы «Доплата» за выбранные месяцы: плановая или разовая доплата либо квартира «Проживания».
 * Исходная запись — в supplement или housing: ✎ и 🗑 работают с ней.
 */
export interface ISupplementRegistryRow extends ISupplementPeriodFields {
  /** planned-<id> / once-<id> / apartment-<id> — id таблиц могут совпасть. */
  key: string;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** Плановая — ₽/мес, разовая — ₽, квартира — ставка ₽/день; numeric строкой. */
  amount: string;
  reason: string | null;
  can_edit: boolean;
  supplement: IPayrollSupplementRow | null;
  housing: IHousingAllowanceRow | null;
}

/**
 * Семь столбцов: «Период» различает строки одного сотрудника (их ФИО — один раз, SUPPLEMENT_GROUP). Отдел и
 * должность уже — таблица без прокрутки влезает в окно на 1280px.
 */
export const SUPPLEMENT_COLUMNS: ReadonlyArray<IRegistryColumn<ISupplementRegistryRow>> = [
  ...employeeColumns<ISupplementRegistryRow>({ department: 112, position: 144 }),
  {
    key: 'kind', label: 'Вид', type: 'text', width: 92, nowrap: true,
    text: row => supplementKindLabel(row.kind), sortValue: row => supplementKindLabel(row.kind),
  },
  moneyColumn<ISupplementRegistryRow>('Сумма, ₽', row => row.amount, 112),
  {
    key: 'period', label: 'Период', type: 'text', width: 190, nowrap: true,
    text: supplementPeriod,
    sortValue: supplementPeriodSort,
  },
  {
    key: 'reason', label: 'Основание', type: 'text', width: 144,
    text: row => orDash(row.reason), sortValue: row => row.reason,
  },
];

/**
 * Строки одного сотрудника в «Доплате» и «Удержаниях» «Справочника»: ФИО, отдел и должность — один раз, его строки —
 * под ним (xlsx — с ФИО в каждой строке: фильтр Excel по сотруднику не теряет строк).
 */
export const EMPLOYEE_ROW_GROUP: IRegistryRowGroup<{ employee_id: number }> = {
  key: row => row.employee_id,
  columns: ['full_name', 'department', 'position'],
};

/** «Плановые доплаты»: пять столбцов — вид и основание у плановой не нужны. */
export const PLANNED_SUPPLEMENT_COLUMNS: ReadonlyArray<IRegistryColumn<IPayrollSupplementRow>> = [
  ...employeeColumns<IPayrollSupplementRow>(),
  moneyColumn<IPayrollSupplementRow>('Сумма, ₽/мес', row => row.amount),
  {
    key: 'period', label: 'Период', type: 'text', width: 190, nowrap: true,
    text: supplementPeriod,
    sortValue: row => row.date_from,
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

export const OVERTIME_STOP_COLUMNS: ReadonlyArray<IRegistryColumn<IOvertimeStop>> = [
  ...employeeColumns<IOvertimeStop>(),
  // Заголовок одной строкой: «БЕЗ ПЕРЕРАБОТКИ С» + стрелка и воронка.
  dateColumn<IOvertimeStop>('date_from', 'Без переработки с', row => row.date_from, 200),
  {
    // Пусто — бессрочно: оплату переработки ещё не возобновили.
    key: 'date_to', label: 'По', type: 'text', width: 112, nowrap: true,
    text: row => (row.date_to ? formatDate(row.date_to) : 'бессрочно'),
    sortValue: row => row.date_to,
  },
];

/**
 * Строка таблицы «Общежитие» — кто живёт в общежитии компании (миграция 339: список гасит авто-доплату за общежитие;
 * те же записи, что у кадров «Проживание»).
 */
export interface IDormitoryRegistryRow {
  /** stay:<id>. */
  key: string;
  full_name: string;
  department: string | null;
  position: string | null;
  address: string | null;
  /** Въезд. */
  date_from: string;
  /** Выезд — в этот день уже не живёт; null — живёт. */
  date_to: string | null;
  stay: IPayrollDormitoryStay;
}

/** Шесть столбцов: отдел и должность уже, как у «Доплаты», — без прокрутки в окне на 1280px. */
export const DORMITORY_REGISTRY_COLUMNS: ReadonlyArray<IRegistryColumn<IDormitoryRegistryRow>> = [
  ...employeeColumns<IDormitoryRegistryRow>({ department: 112, position: 144 }),
  {
    key: 'address', label: 'Общежитие', type: 'text', width: 200,
    text: row => orDash(row.address),
    sortValue: row => row.address,
  },
  dateColumn<IDormitoryRegistryRow>('date_from', 'Въезд', row => row.date_from),
  {
    // Пусто — живёт.
    key: 'date_to', label: 'Выезд', type: 'text', width: 112, nowrap: true,
    text: row => (row.date_to ? formatDate(row.date_to) : '—'),
    sortValue: row => row.date_to,
  },
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

export const buildHousingExport = buildSnapshot('Квартира', HOUSING_COLUMNS);
export const buildSupplementExport = buildSnapshot('Доплата', SUPPLEMENT_COLUMNS);
export const buildPlannedSupplementExport = buildSnapshot('Плановые доплаты', PLANNED_SUPPLEMENT_COLUMNS);
export const buildCompensationStopExport = buildSnapshot('Без проезда', COMPENSATION_STOP_COLUMNS);
export const buildOvertimeStopExport = buildSnapshot('Без переработки', OVERTIME_STOP_COLUMNS);
export const buildDormitoryRegistryExport = buildSnapshot('Общежитие', DORMITORY_REGISTRY_COLUMNS);

/**
 * Ключ строки «Доплаты»: у плановой — версия журнала (у сотрудника бывают прошлые периоды; старый бэкенд
 * id не отдаёт — тогда сотрудник), у разовой — её id.
 */
export const supplementRowKey = (row: IPayrollSupplementRow): string => (
  row.kind === 'planned' ? `planned-${row.id ?? row.employee_id}` : `once-${row.id}`
);

/** Ключ строки квартиры: в общей таблице «Доплата» рядом с доплатами, id которых могут совпасть. */
export const housingRowKey = (row: IHousingAllowanceRow): string => `apartment-${row.id}`;

/** ✎ и 🗑 у доплаты — по праву правки сотрудника: любой период плановой правится по id строки (миграция 337). */
export const canEditSupplement = (row: IPayrollSupplementRow): boolean => row.can_edit;

/** ✎ и 🗑 у строки общей таблицы «Доплата»: доплата — правило canEditSupplement, квартира — право правки. */
export const canEditSupplementRow = (row: ISupplementRegistryRow): boolean => (
  row.supplement ? canEditSupplement(row.supplement) : row.can_edit
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
 * 🗑 у проживания — квартиры и общежития (миграция 339: деньги по дням, выезд 1-м числом обнулил бы месяц): идущее
 * проживание — окно «Дата выезда» (по умолчанию сегодня), не начавшееся (въезд сегодня или позже) или уже
 * закончившееся — ошибочная строка, удаляется.
 */
export const stayRemovalMode = (
  stay: { check_in: string; check_out: string | null },
  todayIso: string,
): 'checkout' | 'delete' => (
  stay.check_in >= todayIso || (stay.check_out !== null && stay.check_out <= todayIso) ? 'delete' : 'checkout'
);

/**
 * Дата выезда из окна 🗑 (день, когда уже не живёт): позже въезда и не позже прежнего выезда — сервер выезд
 * только приближает. null — можно сохранять.
 */
export const stayCheckoutError = (value: string, stay: { check_in: string; check_out: string | null }): string | null => {
  if (!value) return 'Укажите дату выезда';
  if (value <= stay.check_in) return `Дата выезда — позже въезда (${formatDate(stay.check_in)})`;
  if (stay.check_out !== null && value > stay.check_out) return `Дата выезда — не позже прежней (${formatDate(stay.check_out)})`;
  return null;
};

/** 🗑 у плановой: убрать с 1-го числа (период закрывается) или снять ошибочную; у разовой — null (удаляется). */
export const plannedRemoval = (row: IPayrollSupplementRow, todayIso: string): RegistryRemoval | null => (
  row.kind === 'planned' && row.date_from !== null
    ? registryRemoval({ date_from: row.date_from, date_to: row.date_to }, todayIso)
    : null
);

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

/** Порядок доплат сотрудника в «Доплате»: плановые, квартира, разовые. */
const SUPPLEMENT_KIND_ORDER: Record<SupplementRowKind, number> = { planned: 0, apartment: 1, one_time: 2 };

const compareSupplementRows = (a: ISupplementRegistryRow, b: ISupplementRegistryRow): number => (
  a.full_name.localeCompare(b.full_name, 'ru')
  || a.employee_id - b.employee_id
  || SUPPLEMENT_KIND_ORDER[a.kind] - SUPPLEMENT_KIND_ORDER[b.kind]
  || (supplementPeriodSort(a) ?? '').localeCompare(supplementPeriodSort(b) ?? '')
  || Number(b.amount) - Number(a.amount)
);

/**
 * Строки общей таблицы «Доплата» в выбранных месяцах: плановые по периоду и разовые за месяц (supplementInMonths)
 * и квартиры — сервер их уже отобрал по месяцам (?months=); «по» квартиры — день до выезда. Порядок — по сотруднику,
 * у него — плановые, квартира, разовые по периоду: сортировка таблицы устойчивая, строки сотрудника идут подряд.
 * Пока один из источников не загружен (или не загрузился) — undefined: строки из половины данных не строятся.
 */
export const buildSupplementRegistryRows = (
  supplements: ReadonlyArray<IPayrollSupplementRow> | undefined,
  housing: ReadonlyArray<IHousingAllowanceRow> | undefined,
  months: ReadonlyArray<string>,
): ISupplementRegistryRow[] | undefined => {
  if (!supplements || !housing) return undefined;
  const rows: ISupplementRegistryRow[] = [
    ...supplements
      .filter(row => supplementInMonths(row, months))
      .map(row => ({ ...row, key: supplementRowKey(row), supplement: row, housing: null })),
    ...housing.map(row => ({
      key: housingRowKey(row),
      kind: 'apartment' as const,
      employee_id: row.employee_id,
      full_name: row.full_name,
      department: row.department,
      position: row.position,
      amount: row.amount,
      date_from: row.check_in,
      date_to: row.check_out === null ? null : dayBefore(row.check_out),
      month: null,
      reason: APARTMENT_REASON,
      can_edit: row.can_edit,
      supplement: null,
      housing: row,
    })),
  ];
  return rows.sort(compareSupplementRows);
};

/** «Без проезда» и «Без переработки» в месяцах: период (пустое «по» — бессрочно) задевает выбранные месяцы. */
export const stopInMonths = (
  stop: Pick<ICompensationStop, 'date_from' | 'date_to'>,
  months: ReadonlyArray<string>,
): boolean => (
  periodIntersectsMonths(stop.date_from, stop.date_to, months)
);

/** Проживание [въезд, выезд) задевает месяц: в день выезда сотрудник в общежитии уже не живёт. */
const stayTouchesMonth = (stay: IDormitoryStayPeriod, month: string): boolean => (
  stay.check_in <= monthEnd(month) && (stay.check_out === null || stay.check_out > `${month}-01`)
);

/** Строки таблицы «Общежитие» в выбранных месяцах: проживание задевает месяц. «Весь период» — все строки. */
export const buildDormitoryRegistryRows = (
  stays: ReadonlyArray<IPayrollDormitoryStay>,
  months: ReadonlyArray<string>,
): IDormitoryRegistryRow[] => stays
  .filter(stay => months.length === 0 || months.some(month => stayTouchesMonth(stay, month)))
  .map(stay => ({
    key: `stay:${stay.id}`,
    full_name: stay.full_name,
    department: stay.department,
    position: stay.position,
    address: stay.address,
    date_from: stay.check_in,
    date_to: stay.check_out,
    stay,
  }));
