import { describe, it, expect } from 'vitest';

import { parseFssRegistryXml } from './payroll-fss.parser.js';

// Реестр «Прямые выплаты ФСС» ЗУП (payroll-fss.parser.ts): строки, суммы с неразрывными пробелами и запятой, даты,
// id_all; персональные данные в разборе не участвуют; fail-closed на чужом формате.

const date = (tag: string, iso: string): string => {
  const [year, month, day] = iso.split('-').map(Number);
  return `<${tag}><Год>${year}</Год><Мес>${month}</Мес><День>${day}</День></${tag}>`;
};

const entry = (options: {
  name: string; idAll?: string; gross: string; ndfl: string; net: string; from?: string; to?: string; days?: string;
  extra?: string;
}): string => `<РеестрФСС>
  <Комментарий>ок</Комментарий>
  <ФизЛицо><код>1</код><наименование>${options.name}</наименование><ГУИД>x</ГУИД>${options.idAll ? `<id_all>${options.idAll}</id_all>` : ''}
    <ИНН>000000000000</ИНН><СтраховойНомерПФР>000-000-000 00</СтраховойНомерПФР><ПаспортныеДанные><Паспорт><ДокументНомер>1</ДокументНомер></Паспорт></ПаспортныеДанные></ФизЛицо>
  <Сотрудник><код>1</код><наименование>${options.name}</наименование></Сотрудник>
  <БольничныйЛист>Больничный лист 0000-000314 от 15.09.2026</БольничныйЛист>
  <НомерЛисткаНетрудоспособности>910365045582</НомерЛисткаНетрудоспособности>
  <Дней_ФСС>${options.days ?? '4'}</Дней_ФСС>
  <Сумма_Всего_ФСС>${options.gross}</Сумма_Всего_ФСС>
  <СтавкаНДФЛ>13</СтавкаНДФЛ>
  <Сумма_НДФЛ_ФСС>${options.ndfl}</Сумма_НДФЛ_ФСС>
  <Сумма_Всего_БезНДФЛ_ФСС>${options.net}</Сумма_Всего_БезНДФЛ_ФСС>
  <ПричинаНетрудоспособности>ОбщееЗаболевание</ПричинаНетрудоспособности>
  ${options.from ? date('ДатаНачалаОплаты', options.from) : ''}${options.to ? date('ДатаОкончанияОплаты', options.to) : ''}
  <НомерПервичногоЛисткаНетрудоспособности/><СтажЛет>6</СтажЛет><СтажМесяцев>6</СтажМесяцев><ЭтоЭЛН>Да</ЭтоЭЛН>
  <ПервичныйДокумент/><Расшифровки/>${options.extra ?? ''}
</РеестрФСС>`;

const registry = (entries: string[], options: { inn?: string; period?: string; name?: string; extraRoot?: string } = {}): string => `<?xml version="1.0" encoding="UTF-8"?>
<зп_документы_31>
  <имя>${options.name ?? 'РеестрПрямыхВыплатФСС_из_ЗУП_Предст_31_В_ЗУП_УПР'}</имя><версия>1.0</версия>
  <имя_док>Выгрузить_в_уб_ПрямыхВыплатФСС</имя_док>
  <организация_инн>${options.inn ?? '7736255508'}</организация_инн><организация_имя>ООО "СУ-10"</организация_имя>
  <Док_Гуид>41B95081-C17B-11F1-8596-00505686EAEE</Док_Гуид><Док_Номер>000000070</Док_Номер>
  ${date('Док_Дата', '2026-09-30')}${date('ПериодРегистрации', options.period ?? '2026-09-01')}
  <Автор>Бухгалтер</Автор><Комментарий>Из ЗУП</Комментарий>${options.extraRoot ?? ''}
  <РеестрыФСС>${entries.join('\n')}</РеестрыФСС>
</зп_документы_31>`;

const IVANOV = entry({
  name: 'Иванов Иван Иванович', idAll: 'D3C9A512-9DC3-11E1-8A6B-000C291D0F69', gross: '9 829,2', ndfl: '1 278',
  net: '8 551,2', from: '2026-09-12', to: '2026-09-14', days: '3',
});
const PETROV = entry({ name: 'Петров Пётр', gross: '16034,13', ndfl: '2084', net: '13950,13' });

describe('parseFssRegistryXml', () => {
  it('строки реестра: ФИО, id_all, даты, дни, суммы всего / НДФЛ / на руки в копейках; месяц — ПериодРегистрации', () => {
    const parsed = parseFssRegistryXml(registry([IVANOV, PETROV]), '2026-09');
    expect(parsed).toMatchObject({
      guid: '41b95081-c17b-11f1-8596-00505686eaee', docNumber: '000000070', docDate: '2026-09-30', periodMonth: '2026-09-01',
    });
    expect(parsed.lines).toEqual([
      {
        lineNo: 1, fullName: 'Иванов Иван Иванович', personIdAll: 'd3c9a512-9dc3-11e1-8a6b-000c291d0f69',
        sickLeaveNumber: '910365045582', reason: 'ОбщееЗаболевание', dateFrom: '2026-09-12', dateTo: '2026-09-14', days: 3,
        grossCents: 982920, ndflCents: 127800, amountCents: 855120,
      },
      {
        lineNo: 2, fullName: 'Петров Пётр', personIdAll: null, sickLeaveNumber: '910365045582', reason: 'ОбщееЗаболевание',
        dateFrom: null, dateTo: null, days: 4, grossCents: 1603413, ndflCents: 208400, amountCents: 1395013,
      },
    ]);
    // Паспорт, ИНН, СНИЛС в результат не попадают.
    expect(JSON.stringify(parsed)).not.toMatch(/000-000-000|000000000000|Паспорт/);
  });

  it('хеш содержимого: тот же реестр — тот же, другая сумма или порядок строк — другой', () => {
    const base = parseFssRegistryXml(registry([IVANOV, PETROV]), '2026-09').contentHash;
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(parseFssRegistryXml(registry([IVANOV, PETROV]), '2026-09').contentHash).toBe(base);
    expect(parseFssRegistryXml(registry([PETROV, IVANOV]), '2026-09').contentHash).not.toBe(base);
    const changed = entry({ name: 'Петров Пётр', gross: '16034,14', ndfl: '2084', net: '13950,14' });
    expect(parseFssRegistryXml(registry([IVANOV, changed]), '2026-09').contentHash).not.toBe(base);
  });

  it('суммы — как в 1С: «на руки» на рубль больше «всего − НДФЛ» не пересчитывается', () => {
    const rounded = entry({ name: 'Селиванов О.', gross: '19\u00a0471,26', ndfl: '2\u00a0531', net: '16\u00a0941,26' });
    expect(parseFssRegistryXml(registry([rounded]), '2026-09').lines[0])
      .toMatchObject({ grossCents: 1947126, ndflCents: 253100, amountCents: 1694126 });
  });

  it('отказ: другой месяц, чужой ИНН, не тот реестр, неизвестный раздел, нет строк, даты наоборот', () => {
    expect(() => parseFssRegistryXml(registry([IVANOV], { period: '2026-08-01' }), '2026-09')).toThrow(/месяц реестра 2026-08-01/);
    expect(() => parseFssRegistryXml(registry([IVANOV], { inn: '1111111111' }), '2026-09')).toThrow(/другой организации/);
    expect(() => parseFssRegistryXml(registry([IVANOV], { name: 'ЗарплатаКВыплате' }), '2026-09')).toThrow(/не реестр прямых выплат/);
    expect(() => parseFssRegistryXml(registry([IVANOV], { extraRoot: '<Начисления>1</Начисления>' }), '2026-09'))
      .toThrow(/неизвестный раздел «Начисления»/);
    expect(() => parseFssRegistryXml(registry([entry({ name: 'А', gross: '1', ndfl: '0', net: '1', extra: '<Доплата>1</Доплата>' })]), '2026-09'))
      .toThrow(/неизвестный раздел «Доплата»/);
    expect(() => parseFssRegistryXml(registry([]), '2026-09')).toThrow(/нет строк|нет раздела/);
    const backwards = entry({ name: 'А', gross: '1', ndfl: '0', net: '1', from: '2026-09-14', to: '2026-09-12' });
    expect(() => parseFssRegistryXml(registry([backwards]), '2026-09')).toThrow(/начало оплаты позже окончания/);
  });
});
