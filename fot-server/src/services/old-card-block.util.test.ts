import { describe, expect, it } from 'vitest';
import {
  buildExpirationTarget,
  buildLiveCardIdentity,
  buildPlanHash,
  canonicalJson,
  classifyCardGeneration,
  classifyWriteOutcome,
  compareControlNode,
  datesEqual,
  evaluateRollback,
  hasFotPoolNote,
  hashDescendantSet,
  normalizeDepartmentId,
  parseConfirmationFile,
  parseFacilityRanges,
  resolveScopeBucket,
  selectBlockCandidates,
  verifyConfirmedIdentity,
  CONFIRMATION_HEADER,
  type ICardFacts,
  type IConfirmationEntry,
  type IInventoryCard,
} from './old-card-block.util.js';

const card = (over: Partial<ICardFacts> = {}): ICardFacts => ({
  cardId: 1,
  value: '9E053A',
  w26: '158,01338',
  facility: 158,
  moduleLink: {
    poolProfile: false,
    poolPlaceholderName: false,
    inPassModule: false,
    employeeHasPassRow: false,
    readerIssued: false,
    deletedPassTrace: false,
    moduleFacilityBatch: false,
  },
  ...over,
});

const row = (over: Partial<IInventoryCard> = {}): IInventoryCard => ({
  cardId: 100,
  sigurEmployeeId: 500,
  employeeName: 'Иванов Иван',
  orgName: 'АЛЬЯНС ООО',
  departmentId: 62585,
  scopeBucket: 'contractors',
  generation: 'confirmed_white',
  value: '9E053A',
  w26: '158,01338',
  facility: 158,
  format: 'W26',
  startDate: '2026-01-10T00:00:00.000Z',
  expirationDate: '2027-01-10T00:00:00.000Z',
  ...over,
});

const NOW = Date.parse('2026-08-07T09:00:00.000Z');

const select = (
  cards: IInventoryCard[],
  allowlist: number[],
  over: {
    denylist?: number[];
    employeesWithNewCard?: number[];
    excludedBranchCardIds?: number[];
    scope?: Array<'contractors' | 'rootless'>;
    org?: string | null;
    limit?: number | null;
  } = {},
) => selectBlockCandidates({
  cards,
  allowlist: new Set(allowlist),
  denylist: new Set(over.denylist ?? []),
  employeesWithNewCard: new Set(over.employeesWithNewCard ?? []),
  excludedBranchCardIds: new Set(over.excludedBranchCardIds ?? []),
  options: {
    scope: over.scope ?? ['contractors', 'rootless'],
    org: over.org ?? null,
    limit: over.limit ?? null,
    now: NOW,
  },
});

describe('classifyCardGeneration', () => {
  it('без подтверждения карта остаётся not_proven_new — гасить нельзя', () => {
    const result = classifyCardGeneration(card());
    expect(result.generation).toBe('not_proven_new');
  });

  it('подтверждение внешним источником даёт confirmed_white', () => {
    expect(classifyCardGeneration(card({ cardId: 7 }), new Set([7])).generation).toBe('confirmed_white');
  });

  it('связь с модулем перебивает подтверждение', () => {
    const pool = classifyCardGeneration(
      card({ cardId: 7, moduleLink: { ...card().moduleLink, poolProfile: true } }),
      new Set([7]),
    );
    expect(pool.generation).toBe('module_linked');

    const inModule = classifyCardGeneration(
      card({ cardId: 7, moduleLink: { ...card().moduleLink, inPassModule: true } }),
      new Set([7]),
    );
    expect(inModule.generation).toBe('module_linked');

    const reader = classifyCardGeneration(
      card({ cardId: 7, moduleLink: { ...card().moduleLink, readerIssued: true } }),
      new Set([7]),
    );
    expect(reader.generation).toBe('module_linked');
  });

  it('facility на классификацию больше не влияет', () => {
    // Прежде 72 считалась «новой партией» — теперь это только справочное поле.
    expect(classifyCardGeneration(card({ facility: 72 })).generation).toBe('not_proven_new');
    expect(classifyCardGeneration(card({ facility: 63 })).generation).toBe('not_proven_new');
    expect(classifyCardGeneration(card({ cardId: 7, facility: 72 }), new Set([7])).generation)
      .toBe('confirmed_white');
  });

  it('карта не в каталоге или битый W26 → unknown', () => {
    expect(classifyCardGeneration(card({ value: null })).generation).toBe('unknown');
    expect(classifyCardGeneration(card({ w26: null })).generation).toBe('unknown');
  });

  it('employee-level запрет: строка модуля у владельца защищает карту без сопоставления по card_uid', () => {
    // Именно этот случай раньше проходил в гашение при пустом или битом card_uid.
    const result = classifyCardGeneration(
      card({ cardId: 7, moduleLink: { ...card().moduleLink, employeeHasPassRow: true } }),
      new Set([7]),
    );
    expect(result.generation).toBe('module_linked');
    expect(result.reason).toContain('у владельца есть строка в модуле');
  });

  it('имя профиля «Пропуск N» блокирует — переживает удаление строки из БД', () => {
    const result = classifyCardGeneration(
      card({ cardId: 7, moduleLink: { ...card().moduleLink, poolPlaceholderName: true } }),
      new Set([7]),
    );
    expect(result.generation).toBe('module_linked');
  });

  it('след удалённого пропуска блокирует карту', () => {
    const result = classifyCardGeneration(
      card({ cardId: 7, moduleLink: { ...card().moduleLink, deletedPassTrace: true } }),
      new Set([7]),
    );
    expect(result.generation).toBe('module_linked');
    expect(result.reason).toContain('след удалённого пропуска');
  });

  it('партия, засветившаяся в модуле, не подтверждается даже из confirmation-файла', () => {
    // Физическая партия однородна: одна закупка — один тип пластика. Ловит удалённые
    // пуловые пропуска с переименованными в ФИО профилями.
    const result = classifyCardGeneration(
      card({ cardId: 7, facility: 38, moduleLink: { ...card().moduleLink, moduleFacilityBatch: true } }),
      new Set([7]),
    );
    expect(result.generation).toBe('module_linked');
    expect(result.reason).toContain('партия facility 38 засвечена в модуле');
  });

  it('причина перечисляет все сработавшие признаки', () => {
    const result = classifyCardGeneration(card({
      cardId: 7,
      moduleLink: {
        poolProfile: true,
        poolPlaceholderName: true,
        inPassModule: true,
        employeeHasPassRow: true,
        readerIssued: true,
        deletedPassTrace: true,
        moduleFacilityBatch: true,
      },
    }), new Set([7]));
    expect(result.generation).toBe('module_linked');
    for (const fragment of ['FOT-POOL', 'Пропуск N', 'сопоставлена', 'владельца', 'ридер', 'удалённого', 'партия']) {
      expect(result.reason).toContain(fragment);
    }
  });
});

describe('hasFotPoolNote', () => {
  it('узнаёт примечание пула ФОТ', () => {
    expect(hasFotPoolNote('FOT-POOL:69')).toBe(true);
    expect(hasFotPoolNote('fot-pool: 1651')).toBe(true);
    expect(hasFotPoolNote('Пропуск 69')).toBe(false);
    expect(hasFotPoolNote(null)).toBe(false);
  });
});

describe('resolveScopeBucket / normalizeDepartmentId', () => {
  const contractorDescendants = new Set([62585, 70001]);
  const excludedDescendants = new Set([142365, 142053, 142094]);

  const bucket = (departmentId: number | null | 'invalid', isKnownDepartment = true) => resolveScopeBucket({
    departmentId,
    isKnownDepartment,
    contractorDescendants,
    excludedDescendants,
  });

  it('подтверждённо пустой отдел → rootless', () => {
    expect(bucket(null)).toBe('rootless');
  });

  it('битое значение departmentId → anomaly, а НЕ rootless', () => {
    expect(bucket('invalid')).toBe('anomaly');
    expect(normalizeDepartmentId('abc')).toBe('invalid');
    expect(normalizeDepartmentId('12.5')).toBe('invalid');
    expect(normalizeDepartmentId({})).toBe('invalid');
    expect(normalizeDepartmentId('-5')).toBe('invalid');
  });

  it('пустое значение и ноль дают null', () => {
    expect(normalizeDepartmentId(0)).toBeNull();
    expect(normalizeDepartmentId('')).toBeNull();
    expect(normalizeDepartmentId('0')).toBeNull();
    expect(normalizeDepartmentId(null)).toBeNull();
    expect(normalizeDepartmentId('62585')).toBe(62585);
  });

  it('неизвестный ненулевой отдел → anomaly', () => {
    expect(bucket(999999, false)).toBe('anomaly');
  });

  it('исключаемые ветки проверяются явно и раньше подрядных', () => {
    expect(bucket(142365)).toBe('excluded');
    expect(bucket(142053)).toBe('excluded');
    expect(bucket(142094)).toBe('excluded');
  });

  it('подрядное поддерево → contractors, прочее → excluded', () => {
    expect(bucket(62585)).toBe('contractors');
    expect(bucket(141110)).toBe('excluded');
  });
});

describe('selectBlockCandidates', () => {
  it('гасит только confirmed_white', () => {
    const result = select([
      row({ cardId: 100, generation: 'confirmed_white' }),
      row({ cardId: 101, generation: 'not_proven_new' }),
      row({ cardId: 102, generation: 'module_linked' }),
      row({ cardId: 103, generation: 'unknown' }),
    ], [100, 101, 102, 103]);
    expect(result.candidates.map(item => item.cardId)).toEqual([100]);
    expect(result.skipCounts.generation_not_confirmed).toBe(1);
    expect(result.skipCounts.generation_module_linked).toBe(1);
    expect(result.skipCounts.generation_unknown).toBe(1);
  });

  it('not_proven_new не проходит даже будучи в allowlist', () => {
    const result = select([row({ cardId: 100, generation: 'not_proven_new' })], [100]);
    expect(result.candidates).toHaveLength(0);
  });

  it('карта исключённой ветки отклоняется при любом составе allowlist', () => {
    const result = select(
      [row({ cardId: 100, generation: 'confirmed_white' })],
      [100],
      { excludedBranchCardIds: [100] },
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.skipCounts.excluded_branch_card).toBe(1);
  });

  it('исключённая ветка сильнее подтверждения и скоупа', () => {
    const result = select(
      [row({ cardId: 100, generation: 'confirmed_white', scopeBucket: 'contractors' })],
      [100],
      { excludedBranchCardIds: [100], denylist: [] },
    );
    expect(result.skipCounts.excluded_branch_card).toBe(1);
  });

  it('denylist побеждает allowlist', () => {
    const result = select([row({ cardId: 100 })], [100], { denylist: [100] });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipCounts.in_denylist).toBe(1);
  });

  it('сотрудник с модульной картой пропускается целиком', () => {
    const result = select([row({ cardId: 100, sigurEmployeeId: 777 })], [100], { employeesWithNewCard: [777] });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipCounts.employee_has_new_card).toBe(1);
  });

  it('бессрочная привязка и уже просроченная не трогаются', () => {
    expect(select([row({ cardId: 100, expirationDate: null })], [100]).skipCounts.no_expiration_unrevertable).toBe(1);
    expect(select([row({ cardId: 100, expirationDate: '2026-01-01T00:00:00.000Z' })], [100])
      .skipCounts.already_expired).toBe(1);
  });

  it('--scope отключает корневых сотрудников', () => {
    const result = select([row({ cardId: 100, scopeBucket: 'rootless' })], [100], { scope: ['contractors'] });
    expect(result.skipCounts.scope_disabled).toBe(1);
  });

  it('детерминированная сортировка и --limit', () => {
    const cards = [
      row({ cardId: 300, sigurEmployeeId: 9 }),
      row({ cardId: 100, sigurEmployeeId: 2 }),
      row({ cardId: 200, sigurEmployeeId: 2 }),
    ];
    expect(select(cards, [100, 200, 300]).candidates.map(item => item.cardId)).toEqual([100, 200, 300]);
    const limited = select(cards, [100, 200, 300], { limit: 2 });
    expect(limited.candidates.map(item => item.cardId)).toEqual([100, 200]);
    expect(limited.droppedByLimit).toBe(1);
  });

  it('пустой allowlist даёт ноль кандидатов', () => {
    expect(select([row({ cardId: 100 })], []).candidates).toHaveLength(0);
  });
});

describe('parseConfirmationFile', () => {
  const header = CONFIRMATION_HEADER.join('\t');
  const line = (over: Partial<Record<string, string>> = {}): string => [
    over.cardId ?? '100',
    over.value ?? '9E053A',
    over.w26 ?? '158,01338',
    over.format ?? 'W26',
    over.employeeId ?? '500',
    over.confirmationType ?? 'owner_rule',
    over.source ?? 'Владелец процесса',
    over.confirmedAt ?? '2026-08-07T12:00:00.000Z',
  ].join('\t');

  it('принимает корректный файл', () => {
    const result = parseConfirmationFile(`${header}\n${line()}\n`);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].cardId).toBe(100);
  });

  it('пустой или повреждённый файл — ошибка', () => {
    expect(parseConfirmationFile('').errors[0]).toContain('пуст');
    expect(parseConfirmationFile('cardId\tvalue\n').errors[0]).toContain('заголовок');
    expect(parseConfirmationFile(`${header}\n`).errors[0]).toContain('не содержит ни одной записи');
  });

  it('отклоняет неполные строки, дубликаты и мусор', () => {
    const text = [
      header,
      line(),
      line(),                                    // дубликат
      line({ cardId: '101', source: '' }),        // нет источника
      line({ cardId: '102', confirmationType: 'guess' }), // недопустимый тип
      line({ cardId: '103', confirmedAt: 'вчера' }),      // битая дата
      line({ cardId: 'abc' }),                    // не число
      '100\t9E053A',                              // мало колонок
    ].join('\n');
    const result = parseConfirmationFile(text);
    expect(result.entries).toHaveLength(1);
    expect(result.errors).toHaveLength(6);
  });
});

describe('verifyConfirmedIdentity', () => {
  const entry: IConfirmationEntry = {
    cardId: 100,
    value: '9E053A',
    w26: '158,01338',
    format: 'W26',
    employeeId: 500,
    confirmationType: 'owner_rule',
    source: 'Владелец процесса',
    confirmedAt: '2026-08-07T12:00:00.000Z',
  };
  const live = { cardId: 100, value: '9E053A', w26: '158,01338', format: 'W26', employeeId: 500 };

  it('полное совпадение → ok', () => {
    expect(verifyConfirmedIdentity(entry, live)).toBe('ok');
    // Ведущие нули и регистр не считаются расхождением.
    expect(verifyConfirmedIdentity(entry, { ...live, value: '09e053a', w26: '158,1338' })).toBe('ok');
  });

  it('подтверждён cardId, но изменились UID / W26 / format / владелец → отказ', () => {
    expect(verifyConfirmedIdentity(entry, { ...live, value: 'AABBCC' })).toBe('value_changed');
    expect(verifyConfirmedIdentity(entry, { ...live, w26: '159,00001' })).toBe('w26_changed');
    expect(verifyConfirmedIdentity(entry, { ...live, format: 'EM-MARINE' })).toBe('format_changed');
    expect(verifyConfirmedIdentity(entry, { ...live, format: null })).toBe('format_changed');
    expect(verifyConfirmedIdentity(entry, { ...live, employeeId: 777 })).toBe('owner_changed');
    expect(verifyConfirmedIdentity(entry, null)).toBe('card_not_found');
    expect(verifyConfirmedIdentity(entry, { ...live, cardId: 999 })).toBe('card_not_found');
  });

  it('регистр format не считается расхождением', () => {
    expect(verifyConfirmedIdentity(entry, { ...live, format: 'w26' })).toBe('ok');
  });
});

describe('buildLiveCardIdentity', () => {
  const entry: IConfirmationEntry = {
    cardId: 38046,
    value: '26CFFD',
    w26: '038,53245',
    format: 'W26',
    employeeId: 500,
    confirmationType: 'owner_rule',
    source: 'Владелец процесса',
    confirmedAt: '2026-08-07T12:00:00.000Z',
  };
  const raw = { id: 38046, value: '26CFFD', formattedValue: '038,53245', format: 'W26' };

  // Регрессия боевого прогона 09.08.2026: на этой самой записи каталога скрипт
  // бросал «Слишком короткий UID» и пропускал все 1620 карт.
  it('запись каталога Sigur → идентичность сходится с подтверждением', () => {
    const live = buildLiveCardIdentity(raw, entry.cardId, entry.employeeId, 'W26');
    expect(live).toEqual({
      cardId: 38046,
      value: '26CFFD',
      w26: '038,53245',
      format: 'W26',
      employeeId: 500,
    });
    expect(verifyConfirmedIdentity(entry, live)).toBe('ok');
  });

  it('W26 не выводится → null (карта не гасится)', () => {
    expect(buildLiveCardIdentity({ id: 1, value: 'garbage', formattedValue: '???' }, 1, 500, 'W26')).toBeNull();
  });

  it('поля format нет → берётся format привязки', () => {
    const live = buildLiveCardIdentity({ id: 1, value: '26CFFD', formattedValue: '038,53245' }, 1, 500, 'W26');
    expect(live?.format).toBe('W26');
  });

  it('format в каталоге пустой → null, а не подмена форматом привязки', () => {
    const live = buildLiveCardIdentity({ ...raw, format: '   ' }, entry.cardId, entry.employeeId, 'W26');
    expect(live?.format).toBeNull();
    expect(verifyConfirmedIdentity(entry, live)).toBe('format_changed');
  });

  it('алиасы полей Sigur читаются наравне с основными', () => {
    const live = buildLiveCardIdentity(
      { cardValue: '26CFFD', formatted_value: '038,53245', cardFormat: 'W26' },
      38046, 500, null,
    );
    expect(verifyConfirmedIdentity(entry, live)).toBe('ok');
  });
});

describe('parseFacilityRanges', () => {
  it('разбирает диапазоны и одиночные значения', () => {
    expect([...parseFacilityRanges('157-160,63')]).toEqual([157, 158, 159, 160, 63]);
  });

  it('бросает на мусоре и перевёрнутом диапазоне', () => {
    expect(() => parseFacilityRanges('abc')).toThrow();
    expect(() => parseFacilityRanges('168-157')).toThrow();
    expect(() => parseFacilityRanges('')).toThrow();
  });
});

describe('planHash и контрольные узлы', () => {
  it('канонизация не зависит от порядка ключей', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }))
      .toBe(canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
  });

  it('planHash стабилен и не зависит от собственного поля planHash', () => {
    const payload = { createdAt: '2026-08-07T09:00:00.000Z', operations: [{ cardId: 1, employeeId: 2 }] };
    const hash = buildPlanHash(payload);
    expect(buildPlanHash({ ...payload, planHash: 'что угодно' })).toBe(hash);
    expect(buildPlanHash({ ...payload, operations: [{ cardId: 1, employeeId: 3 }] })).not.toBe(hash);
  });

  it('хеш поддерева не зависит от порядка, но реагирует на состав', () => {
    expect(hashDescendantSet([3, 1, 2])).toBe(hashDescendantSet([1, 2, 3]));
    expect(hashDescendantSet([1, 2])).not.toBe(hashDescendantSet([1, 2, 3]));
  });

  it('ловит пропажу узла, перемещение и изменение состава поддерева', () => {
    const planned = { id: 62585, parentId: 100, descendantsHash: hashDescendantSet([1, 2]) };
    expect(compareControlNode(planned, planned)).toBe('ok');
    expect(compareControlNode(planned, null)).toBe('missing');
    expect(compareControlNode(planned, { ...planned, parentId: 200 })).toBe('moved');
    expect(compareControlNode(planned, { ...planned, descendantsHash: hashDescendantSet([1, 2, 3]) }))
      .toBe('subtree_changed');
  });
});

describe('classifyWriteOutcome', () => {
  const target = '2026-08-06T20:59:59.000Z';
  const before = '2027-01-10T00:00:00.000Z';

  it('состояние равно target → committed, даже если запрос бросил исключение', () => {
    expect(classifyWriteOutcome({
      live: { employeeId: 1, cardId: 2, startDate: null, expirationDate: target },
      getFailed: false,
      targetExpiration: target,
      beforeExpiration: before,
    })).toBe('committed');
  });

  it('состояние равно before → not_applied', () => {
    expect(classifyWriteOutcome({
      live: { employeeId: 1, cardId: 2, startDate: null, expirationDate: before },
      getFailed: false,
      targetExpiration: target,
      beforeExpiration: before,
    })).toBe('not_applied');
  });

  it('GET упал или состояние третье → unknown', () => {
    expect(classifyWriteOutcome({
      live: null, getFailed: true, targetExpiration: target, beforeExpiration: before,
    })).toBe('unknown');
    expect(classifyWriteOutcome({
      live: { employeeId: 1, cardId: 2, startDate: null, expirationDate: '2030-01-01T00:00:00.000Z' },
      getFailed: false,
      targetExpiration: target,
      beforeExpiration: before,
    })).toBe('unknown');
  });
});

describe('evaluateRollback', () => {
  const entry = {
    employeeId: 500,
    cardId: 100,
    startDateBefore: '2026-01-10T00:00:00.000Z',
    expirationDateBefore: '2027-01-10T00:00:00.000Z',
    expirationDateAfter: '2026-08-06T20:59:59.000Z',
  };
  const live = {
    employeeId: 500,
    cardId: 100,
    startDate: '2026-01-10T00:00:00.000Z',
    expirationDate: '2026-08-06T20:59:59.000Z',
  };

  it('состояние ровно такое, каким его оставил скрипт → откатываем', () => {
    expect(evaluateRollback(entry, live)).toBe('ok');
  });

  it('повторный откат идемпотентен', () => {
    expect(evaluateRollback(entry, { ...live, expirationDate: entry.expirationDateBefore }))
      .toBe('already_restored');
  });

  it('карта уехала к другому — конфликт, не трогаем', () => {
    expect(evaluateRollback(entry, { ...live, employeeId: 777 })).toBe('conflict_owner');
    expect(evaluateRollback(entry, { ...live, cardId: 999 })).toBe('conflict_card');
    expect(evaluateRollback(entry, null)).toBe('missing_binding');
  });

  it('позднее ручное изменение дат не затирается', () => {
    expect(evaluateRollback(entry, { ...live, startDate: '2026-05-01T00:00:00.000Z' }))
      .toBe('conflict_start_date');
    expect(evaluateRollback(entry, { ...live, expirationDate: '2028-01-01T00:00:00.000Z' }))
      .toBe('conflict_expiration');
  });

  it('даты сравниваются как timestamps, а не как строки', () => {
    expect(datesEqual('2026-08-06T20:59:59.000Z', '2026-08-06T23:59:59+03:00')).toBe(true);
    expect(datesEqual(null, null)).toBe(true);
    expect(datesEqual(null, '2026-08-06T20:59:59.000Z')).toBe(false);
    expect(evaluateRollback(entry, { ...live, expirationDate: '2026-08-06T23:59:59+03:00' })).toBe('ok');
  });
});

describe('buildExpirationTarget', () => {
  it('даёт вчерашние 23:59:59 МСК', () => {
    const target = buildExpirationTarget(new Date('2026-08-07T09:00:00.000Z'));
    expect(target).toBe('2026-08-06T20:59:59.000Z');
    expect(new Date(target).getTime()).toBeLessThan(Date.parse('2026-08-07T09:00:00.000Z'));
  });

  it('сразу после полуночи МСК откатывается на предыдущие сутки', () => {
    expect(buildExpirationTarget(new Date('2026-08-06T21:30:00.000Z'))).toBe('2026-08-06T20:59:59.000Z');
    expect(buildExpirationTarget(new Date('2026-08-06T20:30:00.000Z'))).toBe('2026-08-05T20:59:59.000Z');
  });
});
