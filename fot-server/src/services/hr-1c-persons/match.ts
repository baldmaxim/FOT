/**
 * Решение «физлицо 1С → карточка FOT» по собранным фактам. Чистая функция: одни и те же
 * правила в предпросмотре и в записи (там — заново, под блокировкой карточки).
 *
 * Сильные признаки проверяются все сразу: связь id_all (подтверждённые выплаты 1С, больничные,
 * профиль), СНИЛС, хэши ИНН / паспорта / КИГ, ФИО + дата рождения. Учитываются только
 * работающие карточки; если признаки указывают на разные карточки — ручная проверка.
 * Без сильных признаков — «ФИО уникально + отдел совпал + оба работают».
 * Вето (на любом уровне и для ручного выбора): в карточке другие ДР / СНИЛС / ИНН / id_all,
 * карточка связана с другим физлицом 1С, идентификатор закреплён за другим сотрудником.
 * Расхождение паспорта / КИГ при сильном признаке — смена документа, не вето (блок не пишется);
 * при одном ФИО — вето.
 */

export type Signal = 'id_all' | 'snils' | 'inn' | 'passport' | 'kig' | 'name_birth';
export type Tier = 'id_all' | 'strong' | 'name_dept' | 'manual';

export interface IFotCard {
  id: number;
  fullName: string;
  department: string | null;
  working: boolean;
  birthDate: string | null;
  snilsDigits: string | null;
  hasProfile: boolean;
  passdeskIdAll: string | null;
  snilsHash: string | null;
  innHash: string | null;
  passportHash: string | null;
  kigHash: string | null;
  /** id_all, с которыми карточка связана выплатами/больничными/профилем. */
  linkedIdAlls: string[];
}

export interface IPersonHashes {
  snils: string | null;
  inn: string | null;
  passport: string | null;
  kig: string | null;
}

export interface IClaimOwner {
  claimType: 'snils' | 'inn' | 'passport';
  employeeId: number | null;
  draftId: string | null;
}

export interface IPersonFacts {
  cards: Map<number, IFotCard>;
  /** Карточки, найденные каждым сильным признаком (любой статус). */
  bySignal: Record<Signal, number[]>;
  /** Карточки с тем же ФИО (любой статус). */
  byName: number[];
  claims: IClaimOwner[];
}

export interface IPersonKeys {
  idAll: string;
  /** ФИО в виде normalizeNameForHash. */
  nameKey: string;
  birthDate: string | null;
  snils: string | null;
  departments: string[];
  keyConflict: boolean;
  hashes: IPersonHashes;
}

export interface IDecision {
  kind: 'apply' | 'manual';
  employeeId: number | null;
  tier: Tier | null;
  signals: Signal[];
  candidates: number[];
  reasons: string[];
}

const SIGNAL_LABEL: Record<Signal, string> = {
  id_all: 'код 1С', snils: 'СНИЛС', inn: 'ИНН', passport: 'паспорт', kig: 'КИГ', name_birth: 'ФИО + дата рождения',
};

export const signalLabel = (s: Signal): string => SIGNAL_LABEL[s];

/** «бр.Шерматов А.М./закр» ~ «бр. Шерматов А.М.» */
export const normalizeDepartmentName = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\/закр\s*$/, '').replace(/[\s./]+/g, '');

/** Как normalizeNameForHash: NFKC, ё→е, пробелы, регистр. */
export const nameKeyOf = (s: string): string => s.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/ё/gi, 'е').toLowerCase();

const manual = (reasons: string[], candidates: number[] = [], signals: Signal[] = []): IDecision =>
  ({ kind: 'manual', employeeId: null, tier: null, signals, candidates, reasons });

/** Причины, по которым запись в карточку недопустима. */
export const vetoReasons = (card: IFotCard, person: IPersonKeys, facts: IPersonFacts, opts: { weak: boolean }): string[] => {
  const out: string[] = [];
  if (!card.working) out.push(`карточка #${card.id} не работающая`);
  if (card.birthDate && person.birthDate && card.birthDate !== person.birthDate) out.push('в FOT другая дата рождения');
  if (card.snilsDigits && person.snils && card.snilsDigits !== person.snils) out.push('в FOT другой СНИЛС');
  else if (card.snilsHash && person.hashes.snils && card.snilsHash !== person.hashes.snils) out.push('в FOT другой СНИЛС');
  if (card.innHash && person.hashes.inn && card.innHash !== person.hashes.inn) out.push('в FOT другой ИНН');
  if (card.passdeskIdAll && card.passdeskIdAll !== person.idAll) out.push('в FOT у карточки другой код 1С');
  if (card.linkedIdAlls.some(id => id !== person.idAll)) out.push('карточка связана с другим физлицом 1С (выплаты/больничные)');
  for (const c of facts.claims) {
    if (c.employeeId !== card.id) out.push(`${c.claimType === 'snils' ? 'СНИЛС' : c.claimType === 'inn' ? 'ИНН' : 'паспорт'} закреплён за ${c.employeeId ? `#${c.employeeId}` : 'черновиком'}`);
  }
  if (opts.weak) {
    if (card.passportHash && person.hashes.passport && card.passportHash !== person.hashes.passport) out.push('в FOT другой паспорт');
    if (card.kigHash && person.hashes.kig && card.kigHash !== person.hashes.kig) out.push('в FOT другой КИГ');
  }
  return [...new Set(out)];
};

/** Решение по одному физлицу. `manualEmployeeId` — выбор человека в файле решений. */
export const decidePerson = (person: IPersonKeys, facts: IPersonFacts, manualEmployeeId: number | null = null): IDecision => {
  if (person.keyConflict) return manual(['в 1С у физлица несколько активных записей с разными ФИО/ДР/СНИЛС/ИНН']);

  const working = (ids: number[]): number[] => [...new Set(ids)].filter(id => facts.cards.get(id)?.working);
  const hits = new Map<number, Signal[]>();
  for (const signal of Object.keys(facts.bySignal) as Signal[]) {
    const ids = working(facts.bySignal[signal]);
    if (ids.length > 1) return manual([`по признаку «${signalLabel(signal)}» несколько работающих карточек`], ids, [signal]);
    for (const id of ids) hits.set(id, [...(hits.get(id) ?? []), signal]);
  }
  if (hits.size > 1) {
    const detail = [...hits].map(([id, s]) => `#${id} — ${s.map(signalLabel).join(', ')}`).join('; ');
    return manual([`признаки указывают на разные карточки: ${detail}`], [...hits.keys()]);
  }

  if (manualEmployeeId !== null) {
    const card = facts.cards.get(manualEmployeeId);
    if (!card) return manual([`карточка #${manualEmployeeId} не найдена`], [manualEmployeeId]);
    const strongElsewhere = [...hits.keys()].filter(id => id !== manualEmployeeId);
    if (strongElsewhere.length > 0) return manual([`выбрана #${manualEmployeeId}, а признаки указывают на #${strongElsewhere[0]}`], [manualEmployeeId, ...strongElsewhere]);
    const veto = vetoReasons(card, person, facts, { weak: false });
    if (veto.length > 0) return manual(veto, [manualEmployeeId]);
    return { kind: 'apply', employeeId: manualEmployeeId, tier: 'manual', signals: hits.get(manualEmployeeId) ?? [], candidates: [manualEmployeeId], reasons: [] };
  }

  if (hits.size === 1) {
    const [[id, signals]] = [...hits];
    const found = facts.cards.get(id)!;
    const veto = vetoReasons(found, person, facts, { weak: false });
    if (veto.length > 0) return manual(veto, [id], signals);
    // Связь из выплат — выбор оператора; другое ФИО подтверждает человек номером вручную.
    if (nameKeyOf(found.fullName) !== person.nameKey) return manual(['ФИО в FOT другое — впишите номер карточки вручную, если это тот же человек'], [id], signals);
    return { kind: 'apply', employeeId: id, tier: signals.includes('id_all') ? 'id_all' : 'strong', signals, candidates: [id], reasons: [] };
  }

  // Слабый уровень: ФИО уникально среди всех карточек FOT (и уволенных тоже).
  const byName = [...new Set(facts.byName)].filter(id => facts.cards.has(id));
  if (byName.length === 0) return manual(['в FOT не найден']);
  if (byName.length > 1) return manual(['в FOT несколько карточек с таким ФИО'], byName);
  const card = facts.cards.get(byName[0])!;
  const depts = new Set(person.departments.map(normalizeDepartmentName));
  const reasons: string[] = [];
  if (!card.working) reasons.push('найден только по ФИО, карточка в FOT уволена');
  else if (!depts.has(normalizeDepartmentName(card.department))) reasons.push('найден только по ФИО, отдел в FOT другой');
  if (reasons.length > 0) return manual(reasons, [card.id]);
  const veto = vetoReasons(card, person, facts, { weak: true });
  if (veto.length > 0) return manual(veto, [card.id]);
  return { kind: 'apply', employeeId: card.id, tier: 'name_dept', signals: [], candidates: [card.id], reasons: [] };
};

/** Одна карточка — одно физлицо: все претенденты на общую карточку уходят в ручную проверку. */
export const resolveSharedCards = <T extends { idAll: string; decision: IDecision }>(items: T[]): void => {
  const byCard = new Map<number, T[]>();
  for (const it of items) {
    if (it.decision.kind === 'apply' && it.decision.employeeId !== null) {
      byCard.set(it.decision.employeeId, [...(byCard.get(it.decision.employeeId) ?? []), it]);
    }
  }
  for (const [cardId, list] of byCard) {
    if (list.length < 2) continue;
    for (const it of list) {
      it.decision = manual([`на карточку #${cardId} претендуют ${list.length} физлица 1С`], [cardId], it.decision.signals);
    }
  }
};
