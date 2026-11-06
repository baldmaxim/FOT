import { describe, expect, it } from 'vitest';

import { parsePayout1cMonthXml } from './payroll-1c-payouts.month-xml.js';
import { parsePayout1cXml, Payout1cParseError } from './payroll-1c-payouts.parser.js';

// Синтетическая выгрузка «выплаченная ЗП за месяц» по образцу 1С: вымышленные ФИО, коды и ГУИДы, без паспортных данных.
const ID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ID_B = 'aaaaaaaa-0000-0000-0000-000000000002';
const ID_BOSS = 'aaaaaaaa-0000-0000-0000-000000000009';

const row = (name: string | null, amount: string, idAll: string | null = null, code = '00-0001') => (
  name === null
    ? `<расшифровка><ФизЛицо><код>${code}</код></ФизЛицо><КВыплате>${amount}</КВыплате></расшифровка>`
    : `<расшифровка><ФизЛицо><код>${code}</код><наименование>${name}</наименование>${idAll ? `<id_all>${idAll}</id_all>` : ''}`
      + '<ИНН>000000000000</ИНН><ПаспортныеДанные><Паспорт><ДокументНомер>SECRET-777</ДокументНомер></Паспорт></ПаспортныеДанные>'
      + `</ФизЛицо><КВыплате>${amount}</КВыплате></расшифровка>`
);

interface IDocOpts {
  guid?: string; number?: string; kind?: string; method?: string; month?: string; total?: string; project?: boolean;
  salary?: string; leadership?: string; sostav?: string; extra?: string;
}
const doc = (o: IDocOpts = {}): string => `<документ><имя_док>${o.kind ?? 'ВедомостьНаВыплатуЗарплатыВБанк'}</имя_док>`
  + '<организация_инн>7736255508</организация_инн><организация_имя>ООО "Тест"</организация_имя>'
  + `<Док_Гуид>${o.guid ?? '11111111-2222-3333-4444-555555555555'}</Док_Гуид><Док_Номер>${o.number ?? '0000-000077'}</Док_Номер>`
  + '<Док_Дата><Год>2026</Год><Мес>11</Мес><День>3</День></Док_Дата>'
  + `<ПериодРегистрации><Год>2026</Год><Мес>${o.month ?? '10'}</Мес><День>1</День></ПериодРегистрации>`
  + `${o.project === false ? '' : '<ЗарплатныйПроект>Банк №1</ЗарплатныйПроект>'}<СпособВыплаты>${o.method ?? 'Аванс'}</СпособВыплаты>`
  + `<СуммаПоДокументу>${o.total ?? '15 000,75'}</СуммаПоДокументу>${o.extra ?? ''}${o.sostav ?? '<Состав/>'}`
  + `<Зарплата>${o.salary ?? `${row('Иванов Иван Иванович', '3 000', ID_A)}${row('Сидоров Ёжик', '2 000,25', ID_B)}${row(null, '5000,25', null, '00000')}`}</Зарплата>`
  + `<Зарплата_руководство>${o.leadership ?? row('Начальников Главный', '5 000,25', ID_BOSS)}</Зарплата_руководство>`
  + '<отпуска><отпуск><Сотрудник><код>1</код><наименование>Иванов Иван Иванович</наименование></Сотрудник>'
  + '<КВыплате>3000</КВыплате></отпуск></отпуска><Основания><расшифровка><Документ>Отпуск 1</Документ></расшифровка></Основания>'
  + '<ФизическиеЛица><ФизЛицо><ПаспортныеДанные>SECRET-777</ПаспортныеДанные></ФизЛицо></ФизическиеЛица></документ>';

/** Документ без руководства и справочных разделов — его же берёт кнопка «Загрузить из 1С». */
const PLAIN = {
  guid: '22222222-2222-3333-4444-555555555555', number: '0000-000078', total: '1 500', leadership: '',
  salary: `${row('Петров Пётр', '1 000', ID_A)}${row('Петров Пётр', '500')}${row(null, '0', null, '00000')}`,
};
const plainForButton = (): string => file(doc(PLAIN)
  .replace(/<отпуска>.*<\/отпуска>/, '<отпуска/>').replace(/<Основания>.*<\/Основания>/, '<Основания/>'));

const file = (...docs: string[]): string => '<?xml version="1.0" encoding="UTF-8"?><зп_документы_31>'
  + '<имя>ЗарплатаКВыплате_из_ЗУП_Предст_31_В_ЗУП_УПР</имя><версия>1.0</версия>'
  + `<ЗарплатаКВыплатеОрганизаций>${docs.join('')}</ЗарплатаКВыплатеОрганизаций></зп_документы_31>`;

const expectError = (xml: string, message: RegExp) => {
  expect(() => parsePayout1cMonthXml(xml, '2026-10')).toThrow(Payout1cParseError);
  expect(() => parsePayout1cMonthXml(xml, '2026-10')).toThrow(message);
};

describe('выгрузка ведомостей выплаты за месяц: разбор', () => {
  it('руководство один раз: «00000» = Σ руководства не строка, итог — строки; ПДн нет в результате', () => {
    const [first, second] = parsePayout1cMonthXml(file(
      doc(),
      doc({ ...PLAIN, guid: '33333333-2222-3333-4444-555555555555', kind: 'ВедомостьНаВыплатуЗарплатыПеречислением', project: false }),
    ), '2026-10');
    expect(first).toMatchObject({
      guid: '11111111-2222-3333-4444-555555555555', docNumber: '0000-000077', docDate: '2026-11-03', periodMonth: '2026-10-01',
      paymentMethod: 'Аванс', salaryProject: 'Банк №1', totalCents: 1_000_050, fileTotalCents: 1_500_075,
      duplicateCents: 500_025, leadershipLines: 1, docKind: 'ВедомостьНаВыплатуЗарплатыВБанк',
    });
    expect(first.lines.map(line => [line.lineNo, line.fullName, line.personIdAll, line.amountCents])).toEqual([
      [1, 'Иванов Иван Иванович', ID_A, 300_000],
      [2, 'Сидоров Ёжик', ID_B, 200_025],
      [3, 'Начальников Главный', ID_BOSS, 500_025],
    ]);
    expect(second).toMatchObject({ salaryProject: null, totalCents: 150_000, duplicateCents: 0, leadershipLines: 0 });
    expect(second.lines.map(line => line.lineKey)).toEqual(['петров петр|100000|1', 'петров петр|50000|1']);
    expect(JSON.stringify([first, second])).not.toMatch(/SECRET|ИНН|000000000000/);
  });

  it('тот же документ — тот же content_hash, что у кнопки «Загрузить из 1С»', () => {
    const [own] = parsePayout1cMonthXml(plainForButton(), '2026-10');
    const button = parsePayout1cXml(plainForButton());
    expect(own.contentHash).toBe(button.contentHash);
    expect(own.lines.map(line => line.lineKey)).toEqual(button.lines.map(line => line.lineKey));
  });

  it('стоп: «00000» ≠ руководству, итог не сходится, строка без ФИО не «00000»', () => {
    expectError(file(doc({ leadership: row('Начальников Главный', '5 000', ID_BOSS) })), /«00000» .* ≠ сумме руководства/);
    expectError(file(doc({ total: '10 000,50' })), /СуммаПоДокументу/);
    expectError(file(doc({ salary: `${row('Иванов Иван', '3 000')}${row(null, '5000,25', null, '00001')}` })), /не «00000»/);
    expectError(file(doc({ leadership: `${row('Начальников Главный', '5 000,25')}${row(null, '0', null, '00000')}` })), /не «00000»/);
    expectError(file(doc({ salary: `${row('Иванов Иван', '0')}${row(null, '5000,25', null, '00000')}`, total: '5 000,25' })),
      /больше нуля/);
  });

  it('стоп: другой месяц, вид, неизвестный раздел, непустой «Состав», повтор ГУИДа или номера с датой', () => {
    expectError(file(doc({ month: '9' })), /месяц начисления 2026-09-01, ожидался 2026-10/);
    expectError(file(doc({ kind: 'ВедомостьНаВыплатуЗарплатыЧерезКассу' })), /вид .* не поддержан/);
    expectError(file(doc({ extra: '<Удержания>1</Удержания>' })), /неизвестный раздел «Удержания»/);
    expectError(file(doc({ sostav: '<Состав><x>1</x></Состав>' })), /«Состав» не пустой/);
    expectError(file(doc(), doc()), /ГУИД .* повторяется/);
    expectError(file(doc(), doc({ guid: '44444444-2222-3333-4444-555555555555' })), /0000-000077 от 2026-11-03 повторяется/);
    expectError('<зп_документы_31><имя>Другое</имя></зп_документы_31>', /не выгрузка ведомостей выплаты/);
  });
});
