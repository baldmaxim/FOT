import { describe, expect, it } from 'vitest';

import { parseAmountCents, parsePayout1cXml, Payout1cParseError } from './payroll-1c-payouts.parser.js';

// Синтетические выгрузки по образцам 1С (temp/pz): вымышленные ФИО, коды и ГУИДы, без паспортных данных.
const GUID = '11111111-2222-3333-4444-555555555555';
const ID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ID_B = 'aaaaaaaa-0000-0000-0000-000000000002';

interface IPerson { name: string; idAll: string | null; amount: string; brigade?: string }
const PEOPLE: IPerson[] = [
  { name: 'Иванов Иван Иванович', idAll: ID_A, amount: '43 500', brigade: 'бр.Петрова П.П.' },
  { name: 'Сидоров Ёжик Петрович', idAll: ID_B, amount: '31818,18', brigade: 'бр.Петров П.П.' },
];

const zup2 = (opts: {
  people?: IPerson[]; total?: string; inn?: string; day?: string; docs?: number; sections?: string; extraDocTag?: string;
  personExtra?: string; duplicate?: string;
} = {}): string => {
  const people = opts.people ?? PEOPLE;
  const line = (p: IPerson) => `<расшифровка><ФизЛицо><код>00-0001</код><наименование>${p.name}</наименование>`
    + `<ГУИД>99999999-0000-0000-0000-000000000000</ГУИД>${p.idAll ? `<id_all>${p.idAll}</id_all>` : ''}`
    + `<ИНН>000000000000</ИНН><ПаспортныеДанные><Паспорт><ДокументНомер>0</ДокументНомер></Паспорт></ПаспортныеДанные>`
    + `${opts.personExtra ?? ''}</ФизЛицо><КВыплате>${p.amount}</КВыплате></расшифровка>`;
  const doc = `<документ><имя_док>ВедомостьНаВыплатуЗарплатыВБанк</имя_док><организация_инн>${opts.inn ?? '7736255508'}</организация_инн>`
    + `<организация_имя>ООО "Тест"</организация_имя><Док_Гуид>${GUID}</Док_Гуид><Док_Номер>0000-000077</Док_Номер>`
    + `<Док_Дата><Год>2026</Год><Мес>10</Мес><День>${opts.day ?? '9'}</День></Док_Дата>`
    + '<ПериодРегистрации><Год>2026</Год><Мес>9</Мес><День>1</День></ПериодРегистрации>'
    + `<ЗарплатныйПроект>Банк №1</ЗарплатныйПроект><СпособВыплаты>Увольнения</СпособВыплаты>${opts.duplicate ?? ''}`
    + `<СуммаПоДокументу>${opts.total ?? '75 318,18'}</СуммаПоДокументу>${opts.extraDocTag ?? ''}<Состав/>`
    + `<Зарплата>${people.map(line).join('')}<расшифровка><ФизЛицо><код>00000</код></ФизЛицо><КВыплате>0</КВыплате></расшифровка></Зарплата>`
    + `${opts.sections ?? '<Зарплата_руководство/><отпуска/><Основания/>'}<ФизическиеЛица/></документ>`;
  return '<?xml version="1.0" encoding="UTF-8"?><зп_документы_31><имя>ЗарплатаКВыплате_из_ЗУП_Предст_31_В_ЗУП_УПР</имя>'
    + `<версия>1.0</версия><ЗарплатаКВыплатеОрганизаций>${doc.repeat(opts.docs ?? 1)}</ЗарплатаКВыплатеОрганизаций></зп_документы_31>`;
};

const external = (opts: { people?: IPerson[]; zup2Day?: string; accrualMonth?: string; total?: string } = {}): string => {
  const people = opts.people ?? [...PEOPLE].reverse();
  const line = (p: IPerson) => `<сотрудник><Сумма>${p.amount}</Сумма>${p.idAll ? `<физ_лицо_id_all>${p.idAll}</физ_лицо_id_all>` : ''}`
    + `<физ_лицо_имя>${p.name}</физ_лицо_имя><счет_учета>70.3</счет_учета>`
    + `<МесяцНачисленияЗП>${opts.accrualMonth ?? '01.01.0001 0:00:00'}</МесяцНачисленияЗП>`
    + `<бригада_имя>${p.brigade ?? ''}</бригада_имя><бригада_код>000001</бригада_код></сотрудник>`;
  return '<?xml version="1.0" encoding="UTF-8"?><!-- edited --><ЗУП_ВЫПЛАТЫ><имя>ВыплатаЗПнаЛС</имя><версия>1.0</версия>'
    + `<Документы><Документ><док_гуид>${GUID.toUpperCase()}</док_гуид><номер>00003123</номер>`
    + `<дата><Год>2026</Год><Мес>10</Мес><День>${opts.zup2Day ?? '09'}</День></дата><сумма>${opts.total ?? '75318.18'}</сумма>`
    + '<периодо_регистрации><Год>2026</Год><Мес>09</Мес><День>01</День></периодо_регистрации>'
    + '<НомерБазаИсточник>0000-000077</НомерБазаИсточник><ДатаБазаИсточник><Год>2026</Год><Мес>10</Мес><День>09</День></ДатаБазаИсточник>'
    + '<СпособВыплаты>Увольнения</СпособВыплаты><фирма_представительская_инн>7736255508</фирма_представительская_инн>'
    + `<ЗарплатныйПроект></ЗарплатныйПроект><ЗарплатныйПроект_Кли_Имя/><Сотрудники>${people.map(line).join('')}</Сотрудники>`
    + '</Документ></Документы></ЗУП_ВЫПЛАТЫ>';
};

const expectError = (xml: string, message: RegExp) => {
  expect(() => parsePayout1cXml(xml)).toThrow(Payout1cParseError);
  expect(() => parsePayout1cXml(xml)).toThrow(message);
};

describe('ведомость выплаты 1С: разбор', () => {
  it('ЗУП2: реквизиты, строки, пустышка 00000 пропущена; ПДн не попадают в результат', () => {
    const doc = parsePayout1cXml(zup2());
    expect(doc).toMatchObject({
      format: 'zup2', guid: GUID, docNumber: '0000-000077', zup2Number: null, docDate: '2026-10-09', periodMonth: '2026-09-01',
      paymentMethod: 'Увольнения', salaryProject: 'Банк №1', organizationInn: '7736255508', totalCents: 7531818,
    });
    expect(doc.lines.map(line => [line.lineNo, line.fullName, line.personIdAll, line.brigade, line.amountCents])).toEqual([
      [1, 'Иванов Иван Иванович', ID_A, null, 4350000],
      [2, 'Сидоров Ёжик Петрович', ID_B, null, 3181818],
    ]);
    expect(JSON.stringify(doc)).not.toMatch(/ИНН|Паспорт|000000000000/);
  });

  it('внешняя база: номер ЗУП2, бригада; ГУИД — нижним регистром, ведущие нули номеров сохраняются', () => {
    const doc = parsePayout1cXml(external());
    expect(doc).toMatchObject({ format: 'external', guid: GUID, docNumber: '0000-000077', zup2Number: '00003123', salaryProject: null });
    expect(doc.lines.map(line => line.brigade)).toEqual(['бр.Петров П.П.', 'бр.Петрова П.П.']);
  });

  it('один документ в двух форматах (другой порядок строк) — один content_hash и одни ключи строк', () => {
    const a = parsePayout1cXml(zup2());
    const b = parsePayout1cXml(external());
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.contentHash).toBe(a.contentHash);
    expect([...b.lines.map(line => line.lineKey)].sort()).toEqual([...a.lines.map(line => line.lineKey)].sort());
  });

  it('хеш не зависит от наличия id_all; меняется при другой сумме у тех же людей', () => {
    const withoutIds = PEOPLE.map(p => ({ ...p, idAll: null }));
    expect(parsePayout1cXml(zup2({ people: withoutIds })).contentHash).toBe(parsePayout1cXml(zup2()).contentHash);
    const changed = [{ ...PEOPLE[0], amount: '43 400' }, PEOPLE[1]];
    expect(parsePayout1cXml(zup2({ people: changed, total: '75 218,18' })).contentHash).not.toBe(parsePayout1cXml(zup2()).contentHash);
  });

  it('полные дубли (ФИО и сумма) различаются номером в группе', () => {
    const twins = [PEOPLE[0], { ...PEOPLE[0] }];
    const doc = parsePayout1cXml(zup2({ people: twins, total: '87 000' }));
    expect(doc.lines.map(line => line.lineKey)).toEqual(['иванов иван иванович|4350000|1', 'иванов иван иванович|4350000|2']);
  });

  it('суммы: пробелы и запятая, больше двух знаков — ошибка', () => {
    expect(parseAmountCents('241 754,82', 'x')).toBe(24175482);
    expect(parseAmountCents('241 754,8', 'x')).toBe(24175480);
    expect(parseAmountCents('31818.18', 'x')).toBe(3181818);
    expect(() => parseAmountCents('1,234', 'x')).toThrow(/не распознана/);
    expect(() => parseAmountCents('-5', 'x')).toThrow(/не распознана/);
  });

  it('ошибки формата', () => {
    expectError('<a><b></a>', /не XML/);
    expectError(`<!DOCTYPE x [<!ENTITY e "y">]>${zup2()}`, /DOCTYPE|ENTITY/);
    expectError('<?xml version="1.0" encoding="windows-1251"?><a/>', /Кодировка/);
    expectError('<другое><имя>x</имя></другое>', /Неизвестный формат/);
    expectError(zup2({ docs: 2 }), /2 документов/);
    expectError(zup2({ inn: '7700000000' }), /другой организации/);
    expectError(zup2({ sections: '<Зарплата_руководство/><отпуска><x>1</x></отпуска><Основания/>' }), /«отпуска» не пустой/);
    expectError(zup2({ extraDocTag: '<НовыйРаздел>1</НовыйРаздел>' }), /неизвестный раздел «НовыйРаздел»/);
    expectError(zup2({ total: '75 000' }), /не равна итогу/);
    expectError(zup2({ people: [{ ...PEOPLE[0], amount: '0' }, PEOPLE[1]], total: '31818,18' }), /больше нуля/);
    expectError(zup2({ day: '31', total: '75 318,18' }).replace('<Мес>10</Мес><День>31', '<Мес>11</Мес><День>31'), /несуществующая дата/);
    expectError(zup2({ duplicate: '<СпособВыплаты>Зарплата</СпособВыплаты>' }), /повторяется/);
    expectError(external({ zup2Day: '10' }), /не совпадает с датой ведомости/);
    expectError(external({ accrualMonth: '01.08.2026 0:00:00' }), /не совпадает с месяцем документа/);
  });

  it('неизвестные теги в данных физлица (ПДн) не мешают', () => {
    expect(parsePayout1cXml(zup2({ personExtra: '<НовоеПолеКадров>x</НовоеПолеКадров>' })).lines).toHaveLength(2);
  });
});
