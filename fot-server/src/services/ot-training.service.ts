/**
 * Каталог видов обучения по охране труда и расчёт сроков действия.
 *
 * Единственный источник истины по периодичности: клиент каталог и статусы только получает
 * по API и рисует — общего пакета между fot-app и fot-server нет, дублировать регламент
 * в двух репозиториях нельзя.
 *
 * Коды обязаны совпадать со справочником public.ot_training_kinds (миграция 232) —
 * на это есть тест, иначе FK начнёт отбивать запись новым видом.
 */

export type OtTrainingKind =
  | 'introductory'
  | 'workplace'
  | 'protocol'
  | 'program_a'
  | 'program_b'
  | 'program_v'
  | 'siz'
  | 'first_aid'
  | 'internship'
  | 'work_admission';

/** 'itr' — вид только для инженерно-технических работников, подрядчикам-рабочим не показываем. */
export type OtAudience = 'all' | 'itr';

export type OtStatus = 'missing' | 'valid' | 'expiring' | 'expired';

/** Агрегат по человеку: alert — есть непройденное или просроченное, warning — что-то истекает. */
export type OtRowStatus = 'ok' | 'warning' | 'alert';

export interface IOtTrainingDef {
  kind: OtTrainingKind;
  label: string;
  /** Подсказка периодичности из регламента — показывается в модалке под подписью. */
  hint: string;
  /** null — бессрочно (разовое обучение при приёме). */
  validMonths: number | null;
  audience: OtAudience;
  order: number;
}

/** За сколько дней до истечения показываем «истекает» (как PATENT_WARN_DAYS в ЛК рабочего). */
export const OT_WARN_DAYS = 30;

/**
 * Периодичность — из регламента заказчика:
 *   вводный — при приёме, без срока действия;
 *   на рабочем месте — при приёме, далее для рабочих не реже 1 раза в 3 месяца;
 *   протокол ОТ с внесением в реестр Минтруда — не реже 1 раза в 3 года, каждая программа
 *   (поэтому у программ А/Б/В, СИЗ и первой помощи те же 36 месяцев);
 *   стажировка и допуск к самостоятельной работе — разовые при приёме.
 */
export const OT_TRAININGS: readonly IOtTrainingDef[] = [
  {
    kind: 'introductory',
    label: 'Вводный инструктаж',
    hint: 'при приёме, без срока действия',
    validMonths: null,
    audience: 'all',
    order: 1,
  },
  {
    kind: 'workplace',
    label: 'Инструктаж на рабочем месте',
    hint: 'при приёме, далее не реже 1 раза в 3 месяца',
    validMonths: 3,
    audience: 'all',
    order: 2,
  },
  {
    kind: 'protocol',
    label: 'Протокол ОТ (реестр Минтруда)',
    hint: 'на следующий день после приёма, не реже 1 раза в 3 года',
    validMonths: 36,
    audience: 'all',
    order: 3,
  },
  {
    kind: 'program_a',
    label: 'Программа А — общие вопросы охраны труда',
    hint: 'только для ИТР, не реже 1 раза в 3 года',
    validMonths: 36,
    audience: 'itr',
    order: 4,
  },
  {
    kind: 'program_b',
    label: 'Программа Б — вредные и опасные производственные факторы',
    hint: 'на следующий день после приёма, 2 дня',
    validMonths: 36,
    audience: 'all',
    order: 5,
  },
  {
    kind: 'program_v',
    label: 'Программа В — работы повышенной опасности',
    hint: 'после программы Б, 2 дня',
    validMonths: 36,
    audience: 'all',
    order: 6,
  },
  {
    kind: 'siz',
    label: 'СИЗ — применение средств индивидуальной защиты',
    hint: 'после программы В, 1 день',
    validMonths: 36,
    audience: 'all',
    order: 7,
  },
  {
    kind: 'first_aid',
    label: 'Первая помощь пострадавшим',
    hint: 'после СИЗ, 1 день',
    validMonths: 36,
    audience: 'all',
    order: 8,
  },
  {
    kind: 'internship',
    label: 'Стажировка',
    hint: 'на следующий день после обучения, 3 дня',
    validMonths: null,
    audience: 'all',
    order: 9,
  },
  {
    kind: 'work_admission',
    label: 'Допуск к самостоятельной работе',
    hint: 'на следующий день после стажировки',
    validMonths: null,
    audience: 'all',
    order: 10,
  },
];

const BY_KIND = new Map<string, IOtTrainingDef>(OT_TRAININGS.map(t => [t.kind, t]));

export const otTrainingDef = (kind: string): IOtTrainingDef | undefined => BY_KIND.get(kind);

/** Виды для аудитории: подрядчикам-рабочим программа А не требуется. */
export const otTrainingsFor = (audience: 'contractor' | 'itr'): IOtTrainingDef[] =>
  OT_TRAININGS.filter(t => (audience === 'itr' ? true : t.audience === 'all'))
    .slice()
    .sort((a, b) => a.order - b.order);

export const OT_CONTRACTOR_KINDS: OtTrainingKind[] = otTrainingsFor('contractor').map(t => t.kind);

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * YYYY-MM-DD + n месяцев. Через Date.UTC (не локальное время — иначе TZ сдвигает день)
 * и с клампом конца месяца, как это делает PG: 31.01 + 1 месяц = 28.02 (29.02 в високосный).
 */
export const addMonthsIso = (iso: string, months: number): string => {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`Некорректная дата: ${iso}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  // Последний день целевого месяца: день 0 следующего месяца.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
  return d.toISOString().slice(0, 10);
};

/** Целых дней от a до b (обе — YYYY-MM-DD). Отрицательное — b раньше a. */
const daysBetweenIso = (a: string, b: string): number => {
  const pa = ISO_RE.exec(a);
  const pb = ISO_RE.exec(b);
  if (!pa || !pb) throw new Error('Некорректная дата');
  const ta = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const tb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((tb - ta) / 86_400_000);
};

export interface IOtTrainingState {
  kind: OtTrainingKind;
  passed_on: string | null;
  /** null — бессрочно либо даты нет. */
  valid_until: string | null;
  status: OtStatus;
}

/**
 * Статус одного вида обучения. Дата окончания считается здесь и вручную не правится —
 * вся периодичность зашита в каталог.
 */
export const computeOtStatus = (
  def: IOtTrainingDef,
  passedOn: string | null,
  todayIso: string,
): IOtTrainingState => {
  if (!passedOn) {
    return { kind: def.kind, passed_on: null, valid_until: null, status: 'missing' };
  }
  if (def.validMonths === null) {
    return { kind: def.kind, passed_on: passedOn, valid_until: null, status: 'valid' };
  }

  const validUntil = addMonthsIso(passedOn, def.validMonths);
  const daysLeft = daysBetweenIso(todayIso, validUntil);
  const status: OtStatus = daysLeft < 0 ? 'expired' : daysLeft <= OT_WARN_DAYS ? 'expiring' : 'valid';
  return { kind: def.kind, passed_on: passedOn, valid_until: validUntil, status };
};

export interface IOtPersonSummary {
  trainings: IOtTrainingState[];
  missing: OtTrainingKind[];
  row_status: OtRowStatus;
}

/**
 * Сводка по человеку: только заполненные виды в trainings (payload не раздуваем),
 * остальные — в missing. Отсутствие любого обучения = alert, это и подсвечивает UI.
 */
export const summarizeOtPerson = (
  audience: 'contractor' | 'itr',
  passedByKind: ReadonlyMap<string, string>,
  todayIso: string,
): IOtPersonSummary => {
  const trainings: IOtTrainingState[] = [];
  const missing: OtTrainingKind[] = [];
  let hasExpiring = false;

  for (const def of otTrainingsFor(audience)) {
    const state = computeOtStatus(def, passedByKind.get(def.kind) ?? null, todayIso);
    if (state.status === 'missing') {
      missing.push(def.kind);
      continue;
    }
    trainings.push(state);
    if (state.status === 'expiring') hasExpiring = true;
  }

  const hasExpired = trainings.some(t => t.status === 'expired');
  const row_status: OtRowStatus =
    missing.length > 0 || hasExpired ? 'alert' : hasExpiring ? 'warning' : 'ok';

  return { trainings, missing, row_status };
};
