/**
 * Журналы общежитий 1С (выгрузки «<общежитие> заезд.xlsx» / «… выбытие.xlsx»: журнал заездов, список «Проживают на
 * данный момент», журнал выездов) → операции над записями «Общежития» портала (вид dormitory без служебной квартиры).
 * Чистая функция для генератора scripts/build-dormitory-journal-sync-sql.ts и его теста. Решения пользователя 24.11.2026:
 * - дата выезда — как в 1С: запись [въезд, выезд), день выезда уже не проживание;
 * - с `from` (01.11) записи совпадают с 1С по дням, дни до `from` не меняются (сентябрь–октябрь оплачены);
 * - исключение — въезд `realCheckInBefore` (01.09, дата загрузки 30.10): его заменяет настоящий заезд 1С, если он
 *   раньше и человек жил без перерыва с него до `from` и в 1С, и в портале (дни до 01.09 расчёт не читает);
 * - общежитие без файла заезда (Мытищи) — только выезды внутри записи; общежития без файлов не трогаются.
 * Карточка дня — та, на которой уже лежит запись портала, иначе действующая на дату с самым поздним приёмом
 * (переоформленные: у одного ФИО несколько карточек). Повтор на обновлённых записях — пустой план.
 */

export interface IJournalEntry {
  /** YYYY-MM-DD. */
  date: string;
  fullName: string;
}

export interface IDormitoryJournal {
  /** Название из справочника общежитий («Общ. Нагатинская 34»). */
  dormitory: string;
  /** null — файла заезда нет: общежитие сверяется только по выездам. */
  checkIns: IJournalEntry[] | null;
  checkOuts: IJournalEntry[];
  /** «Проживают на данный момент» из файла заезда; null — файла заезда нет. */
  residents: string[] | null;
}

export interface IJournalCard {
  id: number;
  fullName: string;
  employmentStatus: string | null;
  hireDate: string | null;
  dismissalDate: string | null;
}

/** Любая запись проживания сотрудника (квартиры и компенсация — для проверки пересечений). */
export interface IJournalStay {
  id: number;
  employeeId: number;
  kind: string;
  apartmentId: number | null;
  address: string | null;
  checkIn: string;
  checkOut: string | null;
}

export interface IJournalSyncOptions {
  /** День выгрузки: список «Проживают» — на этот день. */
  fileDate: string;
  /** С этого дня записи равны 1С; раньше — не меняются. */
  from: string;
  /** Въезд-заглушка загрузки (01.09), который заменяется настоящим заездом. */
  realCheckInBefore: string;
}

export interface IStayRange {
  checkIn: string;
  checkOut: string | null;
}

export type JournalSyncOperation =
  | { kind: 'update'; stayId: number; employeeId: number; address: string; before: IStayRange; after: IStayRange; why: string[] }
  | { kind: 'add'; employeeId: number; address: string; checkIn: string; checkOut: string | null; why: string }
  | { kind: 'delete'; stayId: number; employeeId: number; address: string; checkIn: string; checkOut: string | null; why: string };

export type JournalNoteKind =
  | 'journal'
  | 'no_card'
  | 'partial_out_skipped'
  | 'sep_oct_mismatch'
  | 'check_in_unknown'
  | 'check_in_kept'
  | 'untouched';

export interface IJournalNote {
  kind: JournalNoteKind;
  fullName: string;
  employeeId: number | null;
  dormitory: string | null;
  text: string;
}

export interface IJournalSyncPlan {
  operations: JournalSyncOperation[];
  notes: IJournalNote[];
  /** Общежитие с полным файлом → жителей в списке «Проживают». */
  residents: Map<string, number>;
}

interface IInterval {
  dormitory: string;
  /** null — жил раньше начала журнала. */
  start: string | null;
  end: string | null;
}

/** Ключ ФИО: регистр, ё = е, пробелы. */
export const journalNameKey = (value: string): string => (
  value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
);

const DAY_MS = 86_400_000;
const addDays = (iso: string, days: number): string => (
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
);
export const ruDate = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const ruOut = (iso: string | null): string => (iso === null ? 'живёт' : ruDate(iso));
const short = (dormitory: string): string => dormitory.replace(/^Общ\.\s*/, '');
const before = (a: string | null, b: string | null): boolean => a !== null && (b === null || a < b);
const covers = (range: IStayRange, day: string): boolean => range.checkIn <= day && (range.checkOut === null || day < range.checkOut);
const overlaps = (a: IStayRange, b: IStayRange): boolean => before(a.checkIn, b.checkOut) && before(b.checkIn, a.checkOut);

/** Дни [from, to] включительно. */
const eachDay = function* (from: string, to: string): Generator<string> {
  for (let day = from; day <= to; day = addDays(day, 1)) yield day;
};

/** Дни списком диапазонов «01.09–28.09 Нагатинская 34». */
const describeDays = (days: ReadonlyMap<string, string>): string => {
  const parts: string[] = [];
  let run: { from: string; to: string; dormitory: string } | null = null;
  const flush = () => {
    if (!run) return;
    const dates = run.from === run.to ? ruDate(run.from).slice(0, 5) : `${ruDate(run.from).slice(0, 5)}–${ruDate(run.to).slice(0, 5)}`;
    parts.push(`${dates} ${short(run.dormitory)}`);
  };
  for (const day of [...days.keys()].sort()) {
    const dormitory = days.get(day) as string;
    if (run && run.dormitory === dormitory && addDays(run.to, 1) === day) run.to = day;
    else { flush(); run = { from: day, to: day, dormitory }; }
  }
  flush();
  return parts.length > 0 ? parts.join(', ') : 'не жил';
};

/** Карточка действует в день: принята, не уволена раньше; «уволен» без даты увольнения не подходит. */
const cardValidOn = (card: IJournalCard, day: string): boolean => (
  !(card.employmentStatus === 'fired' && !card.dismissalDate)
  && (card.hireDate === null || card.hireDate <= day)
  && (card.dismissalDate === null || day <= card.dismissalDate)
);

interface IPersonTimeline {
  fullName: string;
  intervals: IInterval[];
  /** Противоречия журнала затрагивают дни до from — реальный въезд по такому человеку не ставится. */
  conflicted: boolean;
}

const buildTimelines = (
  journals: readonly IDormitoryJournal[],
  full: ReadonlySet<string>,
  notes: IJournalNote[],
  options: IJournalSyncOptions,
): Map<string, IPersonTimeline> => {
  type Event = { date: string; order: number; dormitory: string; kind: 'in' | 'out'; fullName: string };
  const events = new Map<string, Event[]>();
  const push = (event: Event) => {
    const key = journalNameKey(event.fullName);
    events.set(key, [...(events.get(key) ?? []), event]);
  };
  for (const journal of journals) {
    for (const entry of journal.checkIns ?? []) push({ ...entry, order: 1, dormitory: journal.dormitory, kind: 'in' });
    for (const entry of journal.checkOuts) push({ ...entry, order: 0, dormitory: journal.dormitory, kind: 'out' });
  }

  const timelines = new Map<string, IPersonTimeline>();
  for (const [key, list] of events) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
    const timeline: IPersonTimeline = { fullName: list[0].fullName, intervals: [], conflicted: false };
    const open = new Map<string, string | null>();
    const note = (dormitory: string, text: string) => {
      notes.push({ kind: 'journal', fullName: timeline.fullName, employeeId: null, dormitory, text });
    };
    for (const event of list) {
      if (event.kind === 'in') {
        if (open.has(event.dormitory)) {
          note(event.dormitory, `повторный заезд ${ruDate(event.date)} без выезда после заезда ${ruDate(open.get(event.dormitory) as string)}`);
          timeline.conflicted = true;
          if (event.date >= options.from) throw new Error(`${timeline.fullName}: повторный заезд ${event.date} — разберите журнал`);
          continue;
        }
        open.set(event.dormitory, event.date);
        continue;
      }
      if (full.has(event.dormitory) && !open.has(event.dormitory)
        && timeline.intervals.some(interval => interval.dormitory === event.dormitory)) {
        note(event.dormitory, `выезд ${ruDate(event.date)} без заезда после прежнего выезда`);
        timeline.conflicted = true;
        if (event.date >= options.from) throw new Error(`${timeline.fullName}: выезд ${event.date} без заезда — разберите журнал`);
        continue;
      }
      const start = open.has(event.dormitory) ? open.get(event.dormitory) as string : null;
      open.delete(event.dormitory);
      timeline.intervals.push({ dormitory: event.dormitory, start, end: event.date });
    }
    for (const [dormitory, start] of open) timeline.intervals.push({ dormitory, start, end: null });
    timelines.set(key, timeline);
  }

  // Список «Проживают» — состояние на день выгрузки: он важнее журнала.
  for (const journal of journals) {
    if (journal.residents === null) continue;
    const listed = new Set<string>();
    for (const fullName of journal.residents) {
      const key = journalNameKey(fullName);
      if (listed.has(key)) throw new Error(`${journal.dormitory}: ${fullName} дважды в «Проживают»`);
      listed.add(key);
      const timeline = timelines.get(key) ?? { fullName, intervals: [], conflicted: false };
      timelines.set(key, timeline);
      const here = timeline.intervals.filter(interval => interval.dormitory === journal.dormitory);
      if (here.some(interval => interval.end === null)) continue;
      const lastOut = here.map(interval => interval.end as string).sort().at(-1) ?? null;
      if (lastOut !== null) {
        notes.push({
          kind: 'journal', fullName: timeline.fullName, employeeId: null, dormitory: journal.dormitory,
          text: `в «Проживают», но после выезда ${ruDate(lastOut)} заезда нет — считаем, что живёт без перерыва`,
        });
      }
      timeline.intervals.push({ dormitory: journal.dormitory, start: lastOut, end: null });
    }
    for (const [key, timeline] of timelines) {
      if (!listed.has(key) && timeline.intervals.some(interval => interval.dormitory === journal.dormitory && interval.end === null)) {
        throw new Error(`${journal.dormitory}: ${timeline.fullName} заехал без выезда, но нет в «Проживают» — разберите файл`);
      }
    }
  }

  // Пересечения внутри человека (общежития с файлом заезда): в один день — одно общежитие.
  for (const timeline of timelines.values()) {
    const sorted = timeline.intervals.filter(interval => full.has(interval.dormitory))
      .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      if (!(prev.end === null || next.start === null || prev.end > next.start)) continue;
      const until = prev.end === null ? next.end : next.end === null || prev.end < next.end ? prev.end : next.end;
      if (until === null || until > options.from) {
        throw new Error(`${timeline.fullName}: ${short(prev.dormitory)} и ${short(next.dormitory)} пересекаются после ${options.from} — разберите журнал`);
      }
      timeline.conflicted = true;
      const span = (interval: IInterval) => `${interval.start ? ruDate(interval.start) : 'до 2026'} – ${ruOut(interval.end)}`;
      notes.push({
        kind: 'journal', fullName: timeline.fullName, employeeId: null, dormitory: next.dormitory,
        text: `в журнале пересекаются ${short(prev.dormitory)} (${span(prev)}) и ${short(next.dormitory)} (${span(next)})`,
      });
    }
  }
  return timelines;
};

/** Общежитие записи по справочному написанию (регистр и пробелы по краям не важны). */
const dormitoryOf = (stay: IJournalStay, names: ReadonlyMap<string, string>): string | null => (
  stay.kind === 'dormitory' && stay.apartmentId === null && stay.address !== null
    ? names.get(stay.address.trim().toLowerCase()) ?? null
    : null
);

interface IPiece {
  dormitory: string;
  start: string;
  end: string | null;
}

export const planDormitoryJournalSync = (
  journals: readonly IDormitoryJournal[],
  cards: readonly IJournalCard[],
  stays: readonly IJournalStay[],
  options: IJournalSyncOptions,
): IJournalSyncPlan => {
  const { fileDate, from, realCheckInBefore } = options;
  if (!(realCheckInBefore <= from && from <= fileDate)) throw new Error('Нужно realCheckInBefore ≤ from ≤ fileDate');
  const notes: IJournalNote[] = [];
  const operations: JournalSyncOperation[] = [];

  const full = new Set(journals.filter(journal => journal.checkIns !== null).map(journal => journal.dormitory));
  const partial = new Set(journals.filter(journal => journal.checkIns === null).map(journal => journal.dormitory));
  for (const journal of journals) {
    if ((journal.checkIns === null) !== (journal.residents === null)) throw new Error(`${journal.dormitory}: заезд и «Проживают» — из одного файла`);
  }
  const names = new Map([...full, ...partial].map(name => [name.trim().toLowerCase(), name]));
  const timelines = buildTimelines(journals, full, notes, options);

  const cardById = new Map(cards.map(card => [card.id, card]));
  const cardsByKey = new Map<string, IJournalCard[]>();
  for (const card of cards) {
    const key = journalNameKey(card.fullName);
    cardsByKey.set(key, [...(cardsByKey.get(key) ?? []), card]);
  }
  const staysByEmployee = new Map<number, IJournalStay[]>();
  for (const stay of stays) staysByEmployee.set(stay.employeeId, [...(staysByEmployee.get(stay.employeeId) ?? []), stay]);
  const nameOf = (employeeId: number): string => cardById.get(employeeId)?.fullName ?? String(employeeId);

  // Посуточно 1С с realCheckInBefore по fileDate: день → (карточка, общежитие). Карточка — с записью портала в этот
  // день, иначе действующая с самым поздним приёмом.
  const target = new Map<number, Map<string, string>>();
  const intervalOfDay = new Map<string, IInterval>(); // `${cardId}|${day}` → интервал 1С
  const conflictedCards = new Set<number>();
  for (const [key, timeline] of timelines) {
    const personCards = cardsByKey.get(key) ?? [];
    const relevant = timeline.intervals.filter(interval => full.has(interval.dormitory) && (interval.end === null || interval.end > realCheckInBefore));
    if (personCards.length === 0) {
      const living = relevant.find(interval => interval.end === null || interval.end > from);
      if (living) throw new Error(`${timeline.fullName}: живёт в ${short(living.dormitory)} с ${from} по 1С, а карточки нет — проверьте ФИО`);
      if (relevant.length > 0) {
        notes.push({ kind: 'no_card', fullName: timeline.fullName, employeeId: null, dormitory: relevant[0].dormitory, text: 'в 1С живёт с сентября, а карточки сотрудника с таким ФИО нет' });
      }
      continue;
    }
    const missing: string[] = [];
    for (const interval of relevant) {
      const first = interval.start === null || interval.start < realCheckInBefore ? realCheckInBefore : interval.start;
      const last = interval.end === null ? fileDate : addDays(interval.end, -1);
      for (const day of eachDay(first, last)) {
        const valid = personCards.filter(card => cardValidOn(card, day));
        const own = valid.find(card => (staysByEmployee.get(card.id) ?? []).some(stay => (
          stay.kind === 'dormitory' && stay.apartmentId === null && covers(stay, day)
        )));
        const card = own ?? [...valid].sort((a, b) => (a.hireDate ?? '').localeCompare(b.hireDate ?? '') || a.id - b.id).at(-1);
        if (!card) { missing.push(day); continue; }
        const days = target.get(card.id) ?? new Map<string, string>();
        target.set(card.id, days);
        days.set(day, interval.dormitory);
        intervalOfDay.set(`${card.id}|${day}`, interval);
        if (timeline.conflicted) conflictedCards.add(card.id);
      }
    }
    if (missing.length > 0) {
      if (missing.some(day => day >= from)) throw new Error(`${timeline.fullName}: живёт по 1С ${missing.find(day => day >= from)}, а действующей карточки нет`);
      notes.push({
        kind: 'no_card', fullName: timeline.fullName, employeeId: personCards[0].id, dormitory: relevant[0]?.dormitory ?? null,
        text: `по 1С жил ${describeDays(new Map(missing.map(day => [day, relevant[0]?.dormitory ?? ''])))}, а карточка ещё не действовала`,
      });
    }
  }

  // Портал посуточно (только общежития с полным файлом) — для заметок о сентябре–октябре.
  const touchedEmployees = new Set<number>([...target.keys()]);
  for (const stay of stays) if (dormitoryOf(stay, names) !== null) touchedEmployees.add(stay.employeeId);

  for (const employeeId of [...touchedEmployees].sort((a, b) => a - b)) {
    const fullName = nameOf(employeeId);
    const days = target.get(employeeId) ?? new Map<string, string>();
    const own = (staysByEmployee.get(employeeId) ?? []).slice().sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.id - b.id);

    // Отрезки 1С с from по fileDate: подряд идущие дни одного общежития.
    const pieces: IPiece[] = [];
    for (const day of eachDay(from, fileDate)) {
      const dormitory = days.get(day);
      if (dormitory === undefined) continue;
      const last = pieces.at(-1);
      if (last && last.dormitory === dormitory && last.end === day) last.end = addDays(day, 1);
      else pieces.push({ dormitory, start: day, end: addDays(day, 1) });
    }
    for (const piece of pieces) {
      // Дошёл до дня выгрузки — живёт (выезд в 1С не позже fileDate и сам днём проживания не считается).
      if (piece.end === addDays(fileDate, 1)) piece.end = null;
    }
    const used = new Set<IPiece>();
    const updates = new Map<number, { stay: IJournalStay; after: IStayRange; why: string[] }>();
    const updateOf = (stay: IJournalStay) => {
      const existing = updates.get(stay.id) ?? { stay, after: { checkIn: stay.checkIn, checkOut: stay.checkOut }, why: [] };
      updates.set(stay.id, existing);
      return existing;
    };

    for (const stay of own) {
      const dormitory = dormitoryOf(stay, names);
      if (dormitory === null) continue;
      if (stay.checkOut !== null && stay.checkOut <= from) continue;
      if (stay.checkIn > fileDate) {
        notes.push({ kind: 'untouched', fullName, employeeId, dormitory, text: `въезд ${ruDate(stay.checkIn)} позже выгрузки — не трогаем` });
        continue;
      }

      if (partial.has(dormitory)) {
        // Только выезды из файла внутри записи; поздний из них.
        const key = journalNameKey(cardById.get(employeeId)?.fullName ?? '');
        const outs = (timelines.get(key)?.intervals ?? []).filter(interval => interval.dormitory === dormitory).map(interval => interval.end as string);
        const inside = outs.filter(out => out > stay.checkIn && (stay.checkOut === null || out < stay.checkOut)).sort();
        for (const out of outs.filter(day => !inside.includes(day))) {
          if (out <= stay.checkIn) {
            notes.push({ kind: 'partial_out_skipped', fullName, employeeId, dormitory, text: `выезд в 1С ${ruDate(out)} раньше въезда в портале ${ruDate(stay.checkIn)} — не правим, нужен файл заезда` });
          }
        }
        if (inside.length > 0) {
          const checkOut = inside.at(-1) as string < from ? from : inside.at(-1) as string;
          if (checkOut !== stay.checkOut) {
            const update = updateOf(stay);
            update.after.checkOut = checkOut;
            update.why.push(checkOut === from && (inside.at(-1) as string) < from
              ? `выезд по 1С ${ruDate(inside.at(-1) as string)} — раньше ${ruDate(from)} не ставим`
              : `выезд по 1С ${ruDate(checkOut)}`);
          }
        }
        continue;
      }

      if (!full.has(dormitory)) continue;
      if (stay.checkIn < from) {
        const piece = pieces.find(candidate => !used.has(candidate) && candidate.dormitory === dormitory && candidate.start === from);
        const checkOut = piece ? piece.end : from;
        if (piece) used.add(piece);
        if (checkOut !== stay.checkOut) {
          const update = updateOf(stay);
          update.after.checkOut = checkOut;
          if (piece) update.why.push(checkOut === null ? 'по 1С живёт' : `выезд по 1С ${ruDate(checkOut)}`);
          else {
            const timeline = timelines.get(journalNameKey(fullName));
            const interval = [...(timeline?.intervals ?? [])]
              .filter(candidate => candidate.dormitory === dormitory && candidate.end !== null && candidate.end <= from)
              .sort((a, b) => (a.end as string).localeCompare(b.end as string)).at(-1);
            update.why.push(!timeline
              ? `в файлах 1С его нет — закрыто ${ruDate(from)}`
              : interval
                ? `по 1С выехал ${ruDate(interval.end as string)} — раньше ${ruDate(from)} не ставим`
                : `по 1С на ${ruDate(from)} здесь не жил — закрыто ${ruDate(from)}`);
          }
        }
      } else {
        const piece = pieces.find(candidate => !used.has(candidate) && candidate.dormitory === dormitory
          && overlaps({ checkIn: candidate.start, checkOut: candidate.end }, stay));
        if (!piece) {
          operations.push({
            kind: 'delete', stayId: stay.id, employeeId, address: stay.address as string, checkIn: stay.checkIn, checkOut: stay.checkOut,
            why: `в 1С в эти дни здесь не жил`,
          });
          continue;
        }
        used.add(piece);
        if (piece.start !== stay.checkIn || piece.end !== stay.checkOut) {
          const update = updateOf(stay);
          update.after = { checkIn: piece.start, checkOut: piece.end };
          const realStart = intervalOfDay.get(`${employeeId}|${piece.start}`)?.start ?? null;
          update.why.push(`по 1С заезд ${ruDate(realStart !== null && realStart > piece.start ? realStart : piece.start)}${realStart !== null && realStart < piece.start ? ` (с ${ruDate(realStart)}, раньше ${ruDate(from)} не ставим)` : ''}, ${piece.end === null ? 'живёт' : `выезд ${ruDate(piece.end)}`}`);
        }
      }
    }

    for (const piece of pieces) {
      if (used.has(piece)) continue;
      const realStart = intervalOfDay.get(`${employeeId}|${piece.start}`)?.start ?? null;
      operations.push({
        kind: 'add', employeeId, address: piece.dormitory, checkIn: piece.start, checkOut: piece.end,
        why: realStart !== null && realStart < piece.start
          ? `по 1С заезд ${ruDate(realStart)} — в портале с ${ruDate(piece.start)} (раньше не ставим)`
          : `по 1С заезд ${ruDate(piece.start)}${piece.end === null ? '' : `, выезд ${ruDate(piece.end)}`}`,
      });
    }

    // Настоящий въезд вместо заглушки realCheckInBefore.
    for (const stay of own) {
      const dormitory = dormitoryOf(stay, names);
      if (dormitory === null || !full.has(dormitory) || stay.checkIn !== realCheckInBefore) continue;
      if (stay.checkOut !== null && stay.checkOut < from) continue;
      const interval = intervalOfDay.get(`${employeeId}|${realCheckInBefore}`);
      const continuous = interval !== undefined && interval.dormitory === dormitory
        && [...eachDay(realCheckInBefore, addDays(from, -1))].every(day => days.get(day) === dormitory
          && intervalOfDay.get(`${employeeId}|${day}`) === interval);
      if (!continuous || conflictedCards.has(employeeId)) continue; // заметка — в сверке сентября–октября ниже
      if (interval.start === null) {
        notes.push({ kind: 'check_in_unknown', fullName, employeeId, dormitory, text: `живёт с начала журнала (до 2026) — въезд оставлен ${ruDate(realCheckInBefore)}` });
        continue;
      }
      const hire = cardById.get(employeeId)?.hireDate ?? null;
      const checkIn = hire !== null && hire > interval.start ? hire : interval.start;
      if (checkIn >= realCheckInBefore) continue;
      const clash = (staysByEmployee.get(employeeId) ?? []).some(other => other.id !== stay.id
        && overlaps(other, { checkIn, checkOut: realCheckInBefore }));
      if (clash) {
        notes.push({ kind: 'check_in_kept', fullName, employeeId, dormitory, text: `заезд по 1С ${ruDate(checkIn)}, но до ${ruDate(realCheckInBefore)} есть другое проживание — въезд оставлен` });
        continue;
      }
      const update = updateOf(stay);
      update.after.checkIn = checkIn;
      update.why.unshift(checkIn === interval.start
        ? `заезд по 1С ${ruDate(checkIn)}`
        : `заезд по 1С ${ruDate(interval.start)}, карточка с ${ruDate(checkIn)}`);
    }

    for (const { stay, after, why } of updates.values()) {
      operations.push({
        kind: 'update', stayId: stay.id, employeeId, address: stay.address as string,
        before: { checkIn: stay.checkIn, checkOut: stay.checkOut }, after, why,
      });
    }

    // Сентябрь–октябрь: расхождения с 1С не правим — в заметки.
    const portalDays = new Map<string, string>();
    for (const stay of own) {
      const dormitory = dormitoryOf(stay, names);
      if (dormitory === null || !full.has(dormitory)) continue;
      for (const day of eachDay(realCheckInBefore, addDays(from, -1))) if (covers(stay, day)) portalDays.set(day, dormitory);
    }
    const oneCDays = new Map([...days].filter(([day]) => day < from));
    const differs = [...new Set([...portalDays.keys(), ...oneCDays.keys()])].some(day => portalDays.get(day) !== oneCDays.get(day));
    if (differs) {
      notes.push({
        kind: 'sep_oct_mismatch', fullName, employeeId, dormitory: [...portalDays.values(), ...oneCDays.values()][0] ?? null,
        text: `${ruDate(realCheckInBefore).slice(0, 5)}–${ruDate(addDays(from, -1)).slice(0, 5)}: в портале ${describeDays(portalDays)}; в 1С ${describeDays(oneCDays)} — не правим`,
      });
    }
  }

  for (const stay of stays) {
    const dormitory = dormitoryOf(stay, names);
    if (stay.kind === 'dormitory' && stay.apartmentId === null && dormitory === null && (stay.checkOut === null || stay.checkOut > from)) {
      notes.push({ kind: 'untouched', fullName: nameOf(stay.employeeId), employeeId: stay.employeeId, dormitory: stay.address, text: 'по этому общежитию файлов нет — не трогаем' });
    }
  }

  assertConsistent(operations, stays, options);
  const residents = new Map(journals.filter(journal => journal.residents !== null)
    .map(journal => [journal.dormitory, (journal.residents as string[]).length]));
  return { operations, notes, residents };
};

/** Итог без пересечений; до from меняется только въезд-заглушка (назад) — иначе стоп. */
const assertConsistent = (
  operations: readonly JournalSyncOperation[],
  stays: readonly IJournalStay[],
  { from, realCheckInBefore }: IJournalSyncOptions,
): void => {
  for (const operation of operations) {
    if (operation.kind === 'add' || operation.kind === 'delete') {
      if (operation.checkIn < from) throw new Error(`Запись ${operation.kind} раньше ${from}: сотрудник ${operation.employeeId}`);
      if (operation.checkOut !== null && operation.checkOut <= operation.checkIn) throw new Error(`Пустой период: сотрудник ${operation.employeeId}`);
      continue;
    }
    const { before: was, after } = operation;
    if (after.checkOut !== null && after.checkOut <= after.checkIn) throw new Error(`Пустой период: запись ${operation.stayId}`);
    const daysBeforeFromKept = was.checkIn >= from
      ? after.checkIn >= from
      : (after.checkIn === was.checkIn || (was.checkIn === realCheckInBefore && after.checkIn < was.checkIn))
        && (was.checkOut === null || was.checkOut >= from) && (after.checkOut === null || after.checkOut >= from);
    if (!daysBeforeFromKept) throw new Error(`Запись ${operation.stayId}: правка задевает дни до ${from}`);
  }
  const final = applyJournalOperations(stays, operations);
  const byEmployee = new Map<number, IJournalStay[]>();
  for (const stay of final) byEmployee.set(stay.employeeId, [...(byEmployee.get(stay.employeeId) ?? []), stay]);
  for (const [employeeId, list] of byEmployee) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (overlaps(list[i], list[j])) throw new Error(`Сотрудник ${employeeId}: после правки пересекаются проживания ${list[i].id} и ${list[j].id}`);
      }
    }
  }
};

/** Записи после операций (новые — с отрицательными id): для проверки и повторного плана. */
export const applyJournalOperations = (
  stays: readonly IJournalStay[],
  operations: readonly JournalSyncOperation[],
): IJournalStay[] => {
  const deleted = new Set(operations.flatMap(operation => (operation.kind === 'delete' ? [operation.stayId] : [])));
  const updated = new Map(operations.flatMap(operation => (operation.kind === 'update' ? [[operation.stayId, operation.after] as const] : [])));
  const result = stays.filter(stay => !deleted.has(stay.id)).map(stay => {
    const after = updated.get(stay.id);
    return after ? { ...stay, checkIn: after.checkIn, checkOut: after.checkOut } : stay;
  });
  let next = -1;
  for (const operation of operations) {
    if (operation.kind !== 'add') continue;
    result.push({
      id: next, employeeId: operation.employeeId, kind: 'dormitory', apartmentId: null, address: operation.address,
      checkIn: operation.checkIn, checkOut: operation.checkOut,
    });
    next -= 1;
  }
  return result;
};
