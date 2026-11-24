import type { IRegistryRowTone } from '../components/ui/registry/RegistryTable';
import type {
  IApartmentResident,
  ICompanyApartment,
  IDormitory,
  ICompensationMonthRow,
  IDormitoryResident,
  IDormitoryStay,
} from '../services/dormitoryService';
import { formatDate } from './formatMoney';
import { moscowTodayIso, shiftMonth } from './moscowDate';
import { formatPayrollMoney } from './payrollFormat';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблицы вкладки «Проживание» «Управления кадрами» (миграция 371): «Квартира» (квартиры и жильцы), «Общежитие»,
 * «Компенсация аренды» — столбцы для экрана, сортировки, фильтров и xlsx (общие функции — в tableView.ts).
 * Столбцы и порядок — как в 1С («Учёт квартир», отчёт «Проживающие в общежитии», «Список сотрудников для получения
 * возмещения за проживание»).
 */

const orDash = (value: string | null | undefined): string => (value ? value : '—');
const dateOrDash = (value: string | null | undefined): string => (value ? formatDate(value) : '—');
const countText = (value: number | null): string => (value === null ? '—' : String(value));

/** «19.11.2026 6:17» из «2026-11-19T06:17:13» (время МСК с сервера). */
export const formatPassTime = (value: string | null): string => {
  if (!value) return '—';
  const [date, time = ''] = value.split('T');
  const [hours = '', minutes = ''] = time.split(':');
  return `${formatDate(date)} ${Number(hours)}:${minutes}`;
};

/** «10.12–23.12.2026»; год у начала — только если он другой. */
export const formatPeriod = (from: string | null, to: string | null): string => {
  if (!from || !to) return '—';
  const start = formatDate(from);
  return from.slice(0, 4) === to.slice(0, 4) ? `${start.slice(0, 5)}–${formatDate(to)}` : `${start}–${formatDate(to)}`;
};

/** Уволен (по статусу или дате увольнения не позже сегодня) — строка подсвечивается. */
export const dismissedTone = (stay: IDormitoryStay, today: string): { tone: 'dismissed'; hint: string } | null => {
  const dismissed = stay.employment_status === 'fired' || stay.employment_status === 'dismissed'
    || (stay.dismissal_date ? stay.dismissal_date <= today : false);
  if (!dismissed) return null;
  return { tone: 'dismissed', hint: stay.dismissal_date ? `Уволен ${formatDate(stay.dismissal_date)}` : 'Уволен' };
};

/** Первый месяц данных «Проживания» (общежития и компенсации — с 01.09.2026): начало выбора месяца. */
export const HOUSING_FIRST_MONTH = '2026-09';

/** Месяцы выбора: с HOUSING_FIRST_MONTH по следующий за текущим (заселение со следующего месяца видно заранее). */
export const housingMonthOptions = (currentMonth: string): string[] => {
  const result: string[] = [];
  const last = shiftMonth(currentMonth, 1);
  for (let month = HOUSING_FIRST_MONTH; month <= last; month = shiftMonth(month, 1)) result.push(month);
  return result;
};

/** Жил хоть день в месяце YYYY-MM: въезд до начала следующего месяца, выезд позже 1-го числа. */
export const touchesMonth = (stay: Pick<IDormitoryStay, 'check_in' | 'check_out'>, month: string): boolean => (
  stay.check_in < `${shiftMonth(month, 1)}-01` && (stay.check_out === null || stay.check_out > `${month}-01`)
);

/**
 * «Архив» месяца YYYY-MM (24.11.2026): выехавшие в нём — дата выезда (окончания компенсации) с 1-го числа по конец
 * месяца и не позже сегодня. Как на экране: выезд 01.11 — в ноябре, хотя последний день проживания 31.10.
 */
export const closedInMonth = (stay: Pick<IDormitoryStay, 'check_out'>, month: string, today: string): boolean => (
  stay.check_out !== null
    && stay.check_out >= `${month}-01`
    && stay.check_out < `${shiftMonth(month, 1)}-01`
    && stay.check_out <= today
);

/** Вкладки «Проживания». */
export type HousingTab = 'apartment' | 'dormitory' | 'compensation';

/** Параметры адреса возврата из карточки сотрудника: читаются один раз и убираются. */
const HOUSING_RETURN_PARAMS = ['tab', 'housing', 'month', 'apartment'] as const;

export interface IHousingReturn {
  housing: string | null;
  month: string | null;
  /** Окно жильцов этой квартиры; нет или не число — null. */
  apartment: number | null;
}

/** Адрес возврата в «Проживание»: вкладка, месяц и — из окна квартиры — сама квартира. */
export const housingBackPath = (housing: HousingTab, month: string, apartmentId: number | null = null): string => (
  `/staff-control?tab=dormitory&housing=${housing}&month=${month}${apartmentId !== null ? `&apartment=${apartmentId}` : ''}`
);

/** Выбранный месяц «Проживания» в sessionStorage — вместе с текущим месяцем на момент выбора. */
export interface ISavedHousingMonth {
  month: string;
  savedIn: string;
}

/**
 * Сохранённый месяц действует только в том календарном месяце, когда его выбрали: после смены месяца (вкладка браузера
 * или PWA открыты с прошлого месяца) раздел открывается на текущем, как раньше. Чужая форма или месяца нет в выборе —
 * null.
 */
export const parseSavedHousingMonth = (
  raw: unknown,
  currentMonth: string,
  options: ReadonlyArray<string>,
): ISavedHousingMonth | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { month, savedIn } = raw as Record<string, unknown>;
  if (typeof month !== 'string' || savedIn !== currentMonth || !options.includes(month)) return null;
  return { month, savedIn };
};

/** Что пришло в адресе возврата (только вкладка «Проживание», ?tab=dormitory). */
export const readHousingReturn = (params: URLSearchParams): IHousingReturn => {
  if (params.get('tab') !== 'dormitory') return { housing: null, month: null, apartment: null };
  const apartment = Number(params.get('apartment'));
  return {
    housing: params.get('housing'),
    month: params.get('month'),
    apartment: Number.isInteger(apartment) && apartment > 0 ? apartment : null,
  };
};

/** Адрес без параметров возврата (остальные не трогаются); убирать нечего — null. */
export const stripHousingReturn = (params: URLSearchParams): URLSearchParams | null => {
  if (!HOUSING_RETURN_PARAMS.some(key => params.has(key))) return null;
  const next = new URLSearchParams(params);
  HOUSING_RETURN_PARAMS.forEach(key => next.delete(key));
  return next;
};

/** Уволен ли сотрудник записи на сегодня — галочка «Уволенные» в фильтре столбца «Сотрудник». */
export const isDismissedStay = (stay: IDormitoryStay): boolean => dismissedTone(stay, moscowTodayIso()) !== null;

/** Живёт на дату: [въезд, выезд). */
export const livesOn = (stay: IDormitoryStay, date: string): boolean => (
  stay.check_in <= date && (stay.check_out === null || stay.check_out > date)
);

/** Уволенные в xlsx — бледной строкой, как подсветка на экране. */
const isDismissedRow = (row: unknown): boolean => (
  typeof row === 'object' && row !== null && 'employee_id' in row
    && dismissedTone(row as IDormitoryStay, moscowTodayIso()) !== null
);

const exportOf = <Row,>(title: string, columns: ReadonlyArray<IRegistryColumn<Row>>) =>
  (rows: ReadonlyArray<Row>): ITableExportSnapshot => {
    const isoDate = moscowTodayIso();
    return buildExportTable({
      title,
      subtitle: `Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
      fileName: `${title}_${isoDate}.xlsx`,
      columns,
      rows,
      isMuted: isDismissedRow,
    });
  };

const employeeColumn = <Row extends IDormitoryStay>(label = 'Сотрудник'): IRegistryColumn<Row> => ({
  key: 'full_name',
  label,
  type: 'text',
  text: row => row.full_name,
  sortValue: row => row.full_name,
});

const dateColumn = <Row,>(
  key: string,
  label: string,
  value: (row: Row) => string | null | undefined,
  width = 112,
): IRegistryColumn<Row> => ({
  key,
  label,
  type: 'text',
  width,
  nowrap: true,
  text: row => dateOrDash(value(row)),
  sortValue: row => value(row) ?? null,
});

// ── «Квартира» ────────────────────────────────────────────────────────────────

/** Адрес с пометкой 1С: «Ляпидевского 12-58 (семейная РФ)». */
export const apartmentTitle = (apartment: ICompanyApartment): string => (
  apartment.note ? `${apartment.address} (${apartment.note})` : apartment.address
);

export const APARTMENT_COLUMNS: ReadonlyArray<IRegistryColumn<ICompanyApartment>> = [
  {
    key: 'address',
    label: 'Квартиры',
    type: 'text',
    text: apartmentTitle,
    sortValue: apartment => apartment.address,
  },
  {
    key: 'rooms',
    label: 'Комнат',
    type: 'int',
    width: 104,
    nowrap: true,
    numeric: true,
    text: apartment => countText(apartment.rooms),
    sortValue: apartment => apartment.rooms,
    exportValue: apartment => apartment.rooms,
  },
  {
    key: 'places',
    label: 'Мест',
    type: 'int',
    width: 96,
    nowrap: true,
    numeric: true,
    text: apartment => countText(apartment.places),
    sortValue: apartment => apartment.places,
    exportValue: apartment => apartment.places,
  },
  {
    key: 'price',
    label: 'Цена',
    type: 'money',
    width: 120,
    nowrap: true,
    numeric: true,
    text: apartment => formatPayrollMoney(apartment.price) ?? '—',
    sortValue: apartment => (apartment.price === null ? null : Number(apartment.price)),
    exportValue: apartment => apartment.price,
  },
  dateColumn<ICompanyApartment>('paid_until', 'Оплачено по', apartment => apartment.paid_until, 128),
];

export const buildApartmentsExport = exportOf('Квартиры', APARTMENT_COLUMNS);

/** Жильцы квартиры — как вкладка «Проживающие» 1С; «Платно» на экране — галочкой (своя ячейка). */
export const APARTMENT_RESIDENT_COLUMNS: ReadonlyArray<IRegistryColumn<IApartmentResident>> = [
  employeeColumn<IApartmentResident>(),
  dateColumn<IApartmentResident>('check_in', 'Дата въезда', resident => resident.check_in),
  {
    key: 'phone',
    label: 'Телефоны',
    type: 'text',
    width: 140,
    text: resident => orDash(resident.phone),
    sortValue: resident => resident.phone,
  },
  {
    key: 'paid',
    label: 'Платно',
    type: 'text',
    width: 96,
    nowrap: true,
    text: resident => (resident.paid ? 'Да' : 'Нет'),
    sortValue: resident => (resident.paid ? 1 : 0),
  },
  {
    key: 'vacation',
    label: 'Отпуск период',
    type: 'text',
    width: 150,
    nowrap: true,
    text: resident => formatPeriod(resident.vacation_from, resident.vacation_to),
    sortValue: resident => resident.vacation_from,
  },
  {
    key: 'position',
    label: 'Должность',
    type: 'text',
    width: 160,
    text: resident => orDash(resident.position),
    sortValue: resident => resident.position,
  },
  {
    key: 'main_object',
    label: 'Объект',
    type: 'text',
    width: 160,
    text: resident => orDash(resident.main_object),
    sortValue: resident => resident.main_object,
  },
];

/** История квартиры и общежития: кто жил и когда; placeLabel — столбец места («Общежитие», «Квартира»). */
const historyColumns = <Row extends IDormitoryStay>(placeLabel: string | null): ReadonlyArray<IRegistryColumn<Row>> => [
  employeeColumn<Row>(),
  {
    key: 'department',
    label: 'Подразделение',
    type: 'text',
    width: 160,
    text: row => orDash(row.department),
    sortValue: row => row.department,
  },
  ...(placeLabel ? [{
    key: 'address',
    label: placeLabel,
    type: 'text' as const,
    width: 180,
    text: (row: Row) => orDash(row.address),
    sortValue: (row: Row) => row.address,
  }] : []),
  dateColumn<Row>('check_in', 'Дата въезда', row => row.check_in),
  dateColumn<Row>('check_out', 'Дата выезда', row => row.check_out),
];

/** Комментарий записи — в архивах: при переселении он остаётся у прежней. */
const commentColumn = <Row extends IDormitoryStay>(): IRegistryColumn<Row> => ({
  key: 'comment',
  label: 'Комментарий',
  type: 'text',
  width: 160,
  text: row => row.comment ?? '',
  sortValue: row => row.comment ?? null,
});

export const APARTMENT_HISTORY_COLUMNS = historyColumns<IApartmentResident>(null);

export const buildApartmentResidentsExport = (title: string) => exportOf(title, APARTMENT_RESIDENT_COLUMNS);
export const buildApartmentHistoryExport = (title: string) => exportOf(`${title} — история`, APARTMENT_HISTORY_COLUMNS);

/** «Архив» вкладки «Квартира»: выехавшие в месяце из всех служебных квартир. */
export const APARTMENT_ARCHIVE_COLUMNS: ReadonlyArray<IRegistryColumn<IApartmentResident>> = [
  ...historyColumns<IApartmentResident>('Квартира'),
  commentColumn<IApartmentResident>(),
];

export const buildApartmentArchiveExport = (monthLabel: string) => exportOf(`Квартиры — архив ${monthLabel}`, APARTMENT_ARCHIVE_COLUMNS);

// ── «Общежитие» ───────────────────────────────────────────────────────────────

const DORMITORY_PLACE_COLUMN: IRegistryColumn<IDormitoryResident> = {
  key: 'address',
  label: 'Общежитие',
  type: 'text',
  width: 180,
  text: resident => orDash(resident.address),
  sortValue: resident => resident.address,
};

/**
 * Как отчёт 1С «Проживающие в общежитии последний вход (СКД)»; «Все общежития» — плюс столбец «Общежитие». Месяц
 * (20.11.2026) — плюс «Дата въезда», «Дата выезда» и «Комментарий»; паспорт — полный с правкой «Реквизитов» или «Проживания».
 */
export const dormitoryResidentColumns = (withPlace: boolean): ReadonlyArray<IRegistryColumn<IDormitoryResident>> => [
  {
    key: 'department',
    label: 'Подразделение организации',
    type: 'text',
    width: 180,
    text: resident => orDash(resident.department),
    sortValue: resident => resident.department,
  },
  employeeColumn<IDormitoryResident>(),
  ...(withPlace ? [DORMITORY_PLACE_COLUMN] : []),
  dateColumn<IDormitoryResident>('check_in', 'Дата въезда', resident => resident.check_in),
  dateColumn<IDormitoryResident>('check_out', 'Дата выезда', resident => resident.check_out),
  {
    key: 'passport',
    label: 'Паспорт',
    type: 'text',
    width: 136,
    nowrap: true,
    text: resident => orDash(resident.passport),
    sortValue: resident => resident.passport,
  },
  {
    key: 'last_pass_at',
    label: 'Крайний проход',
    type: 'text',
    width: 150,
    nowrap: true,
    text: resident => formatPassTime(resident.last_pass_at),
    sortValue: resident => resident.last_pass_at,
  },
  {
    key: 'last_access_point',
    label: 'Крайний проход на объекте',
    type: 'text',
    width: 190,
    text: resident => orDash(resident.last_access_point),
    sortValue: resident => resident.last_access_point,
  },
  {
    key: 'supervisor',
    label: 'Начальник участка',
    type: 'text',
    width: 170,
    text: resident => orDash(resident.supervisor),
    sortValue: resident => resident.supervisor,
  },
  {
    key: 'comment',
    label: 'Комментарий',
    type: 'text',
    width: 160,
    text: resident => resident.comment ?? '',
    sortValue: resident => resident.comment ?? null,
  },
];

/** «Архив» общежития (выехавшие в месяце) — и комментарий записи: при переселении он остаётся у прежней. */
export const DORMITORY_ARCHIVE_COLUMNS: ReadonlyArray<IRegistryColumn<IDormitoryResident>> = [
  ...historyColumns<IDormitoryResident>('Общежитие'),
  commentColumn<IDormitoryResident>(),
];

/** Справочник общежитий (миграция 377) — как «Общежития» 1С: Дата, Номер, Общежитие, Стоимость места (справочно). */
export const DORMITORY_DIRECTORY_COLUMNS: ReadonlyArray<IRegistryColumn<IDormitory>> = [
  dateColumn<IDormitory>('doc_date', 'Дата', dormitory => dormitory.doc_date),
  {
    key: 'doc_number',
    label: 'Номер',
    type: 'text',
    width: 128,
    nowrap: true,
    text: dormitory => orDash(dormitory.doc_number),
    sortValue: dormitory => dormitory.doc_number,
  },
  {
    key: 'address',
    label: 'Общежитие',
    type: 'text',
    text: dormitory => dormitory.address,
    sortValue: dormitory => dormitory.address,
  },
  {
    key: 'place_price',
    label: 'Стоимость места',
    type: 'money',
    width: 168,
    nowrap: true,
    numeric: true,
    text: dormitory => formatPayrollMoney(dormitory.place_price) ?? '—',
    sortValue: dormitory => (dormitory.place_price === null ? null : Number(dormitory.place_price)),
    exportValue: dormitory => dormitory.place_price,
  },
];

export const buildDormitoryDirectoryExport = exportOf('Общежития', DORMITORY_DIRECTORY_COLUMNS);

export const buildDormitoryResidentsExport = (title: string, withPlace: boolean) => exportOf(title, dormitoryResidentColumns(withPlace));
export const buildDormitoryArchiveExport = (title: string, monthLabel: string) => (
  exportOf(`${title} — архив ${monthLabel}`, DORMITORY_ARCHIVE_COLUMNS)
);

// ── «Компенсация аренды» ──────────────────────────────────────────────────────

const dayCount = (value: number | null): string => (value === null ? '—' : String(value));

/** Как документ 1С «Список сотрудников для получения возмещения за проживание». */
export const COMPENSATION_COLUMNS: ReadonlyArray<IRegistryColumn<ICompensationMonthRow>> = [
  employeeColumn<ICompensationMonthRow>(),
  {
    key: 'position',
    label: 'Должность',
    type: 'text',
    width: 160,
    text: row => orDash(row.position),
    sortValue: row => row.position,
  },
  {
    key: 'department',
    label: 'Подразделение',
    type: 'text',
    width: 160,
    text: row => orDash(row.department),
    sortValue: row => row.department,
  },
  // Ширина — под самое длинное слово подписи («КОМПЕНСАЦИИ», «ОБНОВЛЕНО») со стрелкой и воронкой.
  // Начало — первой записи цепочки «пауза → возобновление» (миграция 374).
  dateColumn<ICompensationMonthRow>('check_in', 'Начало компенсации', row => row.compensation_start ?? row.check_in, 160),
  // Подпись в одно слово не переносится: ширина — под неё со стрелкой и воронкой. «Возобновлена» убрана 24.11.2026.
  dateColumn<ICompensationMonthRow>('paused_from', 'Приостановлена', row => row.paused_from, 188),
  dateColumn<ICompensationMonthRow>('updated_at', 'Обновлено', row => row.updated_at?.slice(0, 10) ?? null, 144),
  {
    key: 'weekend_days',
    label: 'Кол-во выходных',
    type: 'int',
    width: 112,
    nowrap: true,
    numeric: true,
    text: row => dayCount(row.weekend_days),
    sortValue: row => row.weekend_days,
    exportValue: row => row.weekend_days,
  },
  {
    key: 'worked_days',
    label: 'Кол-во дней (табель)',
    type: 'int',
    width: 120,
    nowrap: true,
    numeric: true,
    text: row => dayCount(row.worked_days),
    sortValue: row => row.worked_days,
    exportValue: row => row.worked_days,
  },
  {
    key: 'month_amount',
    label: 'Сумма к оплате',
    type: 'money',
    width: 132,
    nowrap: true,
    numeric: true,
    text: row => formatPayrollMoney(row.month_amount) ?? '—',
    sortValue: row => (row.month_amount === null ? null : Number(row.month_amount)),
    exportValue: row => row.month_amount,
  },
  {
    key: 'comment',
    label: 'Комментарий',
    type: 'text',
    width: 160,
    text: row => row.comment ?? '',
    sortValue: row => row.comment ?? null,
  },
  {
    key: 'country',
    label: 'Гражданство',
    type: 'text',
    width: 128,
    text: row => orDash(row.country),
    sortValue: row => row.country ?? null,
  },
];

/** Период в бригаде строки: «с 16.11.2026» или «01.10–11.11.2026»; нет — null. */
const brigadeHint = (row: ICompensationMonthRow): string | null => {
  if (!row.brigade_from) return null;
  return row.brigade_to
    ? `В бригаде ${formatPeriod(row.brigade_from, row.brigade_to)} — в эти дни компенсация аренды не начисляется`
    : `В бригаде с ${formatDate(row.brigade_from)} — компенсация аренды не начисляется`;
};

/**
 * Подсветка строки компенсации: уволенный — цвет «уволен» (важнее), подсказки объединяются; только бригада — мягкий
 * жёлтый с датой перевода.
 */
export const compensationTone = (row: ICompensationMonthRow, today: string): IRegistryRowTone | null => {
  const dismissed = dismissedTone(row, today);
  const brigade = brigadeHint(row);
  if (dismissed) return brigade ? { tone: 'dismissed', hint: `${dismissed.hint} · ${brigade}` } : dismissed;
  return brigade ? { tone: 'brigade', hint: brigade } : null;
};

/** Итого «Сумма к оплате» видимых строк — в целых копейках. */
export const compensationTotals = (rows: ReadonlyArray<ICompensationMonthRow>) => {
  const cents = rows.reduce((sum, row) => sum + (row.month_amount === null ? 0 : Math.round(Number(row.month_amount) * 100)), 0);
  if (rows.length === 0) return null;
  const amount = (cents / 100).toFixed(2);
  return {
    display: { full_name: 'Итого', month_amount: formatPayrollMoney(amount) ?? '—' },
    export: { full_name: 'Итого', month_amount: amount },
  };
};

export const buildCompensationExport = (monthLabel: string) => (
  rows: ReadonlyArray<ICompensationMonthRow>,
  totals?: Readonly<Record<string, string | number | null>>,
): ITableExportSnapshot => {
  const isoDate = moscowTodayIso();
  return buildExportTable({
    title: 'Компенсация аренды',
    subtitle: `${monthLabel}. Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
    fileName: `Компенсация аренды_${monthLabel}_${isoDate}.xlsx`,
    columns: COMPENSATION_COLUMNS,
    rows,
    isMuted: isDismissedRow,
    ...(totals ? { totals } : {}),
  });
};

/** Строка «Архива» компенсации: закончившаяся в месяце запись и начало её цепочки «пауза → возобновление». */
export interface ICompensationArchiveRow extends IDormitoryStay {
  /** Въезд первой записи цепочки (миграция 374). */
  compensation_start: string;
}

/**
 * «Архив» «Компенсации аренды» за месяц: компенсации (вид apartment), закончившиеся в месяце (closedInMonth), без
 * приостановленных — они остаются в списке месяца. Начало — первой записи цепочки по resumed_from_id.
 */
export const compensationArchiveRows = (
  stays: ReadonlyArray<IDormitoryStay>,
  month: string,
  today: string,
): ICompensationArchiveRow[] => {
  const byId = new Map(stays.map(stay => [stay.id, stay]));
  const chainStart = (stay: IDormitoryStay): string => {
    let current = stay;
    const seen = new Set<number>([stay.id]);
    while (current.resumed_from_id) {
      const previous = byId.get(current.resumed_from_id);
      if (!previous || seen.has(previous.id)) break;
      seen.add(previous.id);
      current = previous;
    }
    return current.check_in;
  };
  return stays
    .filter(stay => stay.kind === 'apartment' && !stay.suspended && closedInMonth(stay, month, today))
    .map(stay => ({ ...stay, compensation_start: chainStart(stay) }));
};

export const COMPENSATION_ARCHIVE_COLUMNS: ReadonlyArray<IRegistryColumn<ICompensationArchiveRow>> = [
  employeeColumn<ICompensationArchiveRow>(),
  {
    key: 'position',
    label: 'Должность',
    type: 'text',
    width: 160,
    text: row => orDash(row.position),
    sortValue: row => row.position,
  },
  {
    key: 'department',
    label: 'Подразделение',
    type: 'text',
    width: 160,
    text: row => orDash(row.department),
    sortValue: row => row.department,
  },
  dateColumn<ICompensationArchiveRow>('check_in', 'Начало компенсации', row => row.compensation_start, 160),
  dateColumn<ICompensationArchiveRow>('check_out', 'Окончание', row => row.check_out, 128),
  commentColumn<ICompensationArchiveRow>(),
];

export const buildCompensationArchiveExport = (monthLabel: string) => (
  exportOf(`Компенсация аренды — архив ${monthLabel}`, COMPENSATION_ARCHIVE_COLUMNS)
);
