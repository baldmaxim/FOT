import { describe, expect, it } from 'vitest';

import { parsePayout1cApiXml } from './payroll-1c-payouts.month-xml.js';

// Разбор XML ведомостей для API: месяц — свой у каждой ведомости, «Док_Версия», «Комментарий», ID_FOT и «Основание».

const doc = (input: { guid: string; number: string; month: number; version?: string; extra?: string; line?: string }) => `<документ>
  <имя_док>ВедомостьНаВыплатуЗарплатыВБанк</имя_док><организация_инн>7736255508</организация_инн>
  <Док_Гуид>${input.guid}</Док_Гуид>${input.version === undefined ? '' : `<Док_Версия>${input.version}</Док_Версия>`}
  <Док_Номер>${input.number}</Док_Номер><Док_Дата><Год>2026</Год><Мес>11</Мес><День>20</День></Док_Дата>
  <ПериодРегистрации><Год>2026</Год><Мес>${input.month}</Мес><День>1</День></ПериодРегистрации>
  <СпособВыплаты>Отпуска</СпособВыплаты><СуммаПоДокументу>100.00</СуммаПоДокументу>${input.extra ?? ''}
  <Зарплата><расшифровка>${input.line ?? `<ФизЛицо><наименование>Иванов Иван</наименование><ID_FOT>1544</ID_FOT></ФизЛицо>
    <КВыплате>100.00</КВыплате><Основание>Отпуск 16.11–29.11.2026, 14 дн.</Основание>`}</расшифровка></Зарплата></документ>`;
const file = (...docs: string[]) => `<зп_документы_31><имя>ЗарплатаКВыплате_из_ЗУП_Предст_31_В_ЗУП_УПР</имя><версия>1.0</версия>
  <ЗарплатаКВыплатеОрганизаций>${docs.join('')}</ЗарплатаКВыплатеОрганизаций></зп_документы_31>`;
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';

describe('parsePayout1cApiXml', () => {
  it('месяц у каждой ведомости свой, версия, комментарий, ID_FOT и основание строки', () => {
    const [first, second] = parsePayout1cApiXml(file(
      doc({ guid: G1, number: '1', month: 11, version: '17', extra: '<Комментарий>Отпуск Гобовой</Комментарий>' }),
      doc({ guid: G2, number: '2', month: 10, line: '<ФизЛицо><наименование>Петров Пётр</наименование></ФизЛицо><КВыплате>100.00</КВыплате>' }),
    ));
    expect(first).toMatchObject({ index: 0, periodMonth: '2026-11-01', version: 17, comment: 'Отпуск Гобовой', totalCents: 10000 });
    expect(first.lines[0]).toMatchObject({ fullName: 'Иванов Иван', idFot: 1544, basis: 'Отпуск 16.11–29.11.2026, 14 дн.', amountCents: 10000 });
    expect(second).toMatchObject({ periodMonth: '2026-10-01', version: null, comment: null });
    expect(second.lines[0]).toMatchObject({ idFot: null, basis: null });
  });

  it('ошибки: версия, ID_FOT, повтор ГУИДа, длинное основание', () => {
    expect(() => parsePayout1cApiXml(file(doc({ guid: G1, number: '1', month: 11, version: '0' })))).toThrow('Док_Версия');
    expect(() => parsePayout1cApiXml(file(doc({ guid: G1, number: '1', month: 11, version: '1.5' })))).toThrow('Док_Версия');
    expect(() => parsePayout1cApiXml(file(doc({
      guid: G1, number: '1', month: 11, line: '<ФизЛицо><наименование>И</наименование><ID_FOT>12a</ID_FOT></ФизЛицо><КВыплате>100.00</КВыплате>',
    })))).toThrow('ID_FOT');
    expect(() => parsePayout1cApiXml(file(doc({ guid: G1, number: '1', month: 11 }), doc({ guid: G1, number: '2', month: 11 })))).toThrow('повторяется');
    expect(() => parsePayout1cApiXml(file(doc({
      guid: G1, number: '1', month: 11,
      line: `<ФизЛицо><наименование>И</наименование></ФизЛицо><КВыплате>100.00</КВыплате><Основание>${'я'.repeat(501)}</Основание>`,
    })))).toThrow('длиннее 500');
  });
});
