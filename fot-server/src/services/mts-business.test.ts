import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { assertMtsBusinessBaseUrlAllowed } from './settings.service.js';
import {
  mtsBusinessCdrService,
  normalizeMsisdn,
  msisdnHash,
  parseDurationSec,
  parseCallDate,
} from './mts-business-cdr.service.js';

describe('МТС Бизнес: allow-list base URL (SSRF)', () => {
  it('пропускает api.mts.ru с https', () => {
    expect(() => assertMtsBusinessBaseUrlAllowed('https://api.mts.ru/b2b/v1')).not.toThrow();
    expect(() => assertMtsBusinessBaseUrlAllowed('https://api.mts.ru')).not.toThrow();
  });

  it('отклоняет http (только https)', () => {
    expect(() => assertMtsBusinessBaseUrlAllowed('http://api.mts.ru/b2b/v1')).toThrow(/https/);
  });

  it('отклоняет посторонний хост', () => {
    expect(() => assertMtsBusinessBaseUrlAllowed('https://evil.example.com/b2b/v1')).toThrow(/allow-list/);
    expect(() => assertMtsBusinessBaseUrlAllowed('https://api.mpoisk.ru/v6/api')).toThrow(/allow-list/);
  });

  it('отклоняет мусор', () => {
    expect(() => assertMtsBusinessBaseUrlAllowed('not a url')).toThrow(/невалидный/);
  });
});

describe('МТС Бизнес: нормализация номера', () => {
  it('приводит разные формы к 7XXXXXXXXXX', () => {
    expect(normalizeMsisdn('+7 (900) 123-45-67')).toBe('79001234567');
    expect(normalizeMsisdn('8 900 123 45 67')).toBe('79001234567');
    expect(normalizeMsisdn('9001234567')).toBe('79001234567');
    expect(normalizeMsisdn('79001234567')).toBe('79001234567');
  });

  it('null/пусто → null', () => {
    expect(normalizeMsisdn(null)).toBeNull();
    expect(normalizeMsisdn('')).toBeNull();
    expect(normalizeMsisdn('abc')).toBeNull();
  });

  it('хэш одинаков для эквивалентных форм и не равен для разных', () => {
    expect(msisdnHash('+7 900 123 45 67')).toBe(msisdnHash('89001234567'));
    expect(msisdnHash('79001234567')).not.toBe(msisdnHash('79007654321'));
  });
});

describe('МТС Бизнес: разбор длительности', () => {
  it('число секунд', () => {
    expect(parseDurationSec(125)).toBe(125);
    expect(parseDurationSec('90')).toBe(90);
  });
  it('строки HH:MM:SS и MM:SS', () => {
    expect(parseDurationSec('00:02:05')).toBe(125);
    expect(parseDurationSec('02:00')).toBe(120);
    expect(parseDurationSec('01:00:00')).toBe(3600);
  });
  it('пусто/мусор → 0', () => {
    expect(parseDurationSec(null)).toBe(0);
    expect(parseDurationSec('—')).toBe(0);
  });
});

describe('МТС Бизнес: разбор даты', () => {
  it('ISO round-trip', () => {
    expect(parseCallDate('2026-06-01T09:15:00Z')).toBe('2026-06-01T09:15:00.000Z');
  });
  it('DD.MM.YYYY HH:MM:SS → валидный ISO того же года', () => {
    const iso = parseCallDate('01.06.2026 10:00:00');
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getUTCFullYear()).toBe(2026);
  });
  it('пусто/мусор → null', () => {
    expect(parseCallDate('')).toBeNull();
    expect(parseCallDate('не дата')).toBeNull();
  });
});

describe('МТС Бизнес: парсинг XML детализации (реальный формат API)', () => {
  // Реальный формат: Report → <ds n="СВОЙ_НОМЕР" type= sim=> → <i d= n= s= du=>.
  // Голос = записи s="Телеф." с du-длительностью; направление — по маркеру «&lt;--».
  const xml = `<?xml version="1.0" encoding="utf-8"?><Report><ds sd="01.06.2026" ed="30.06.2026" n="79001234567" t="0" f="0" type="Сетевой ресурс" sim="8970101">`
    + `<i d="01.06.2026 12:40:48" n="&lt;--+79152763968" zp="VoLTE" s="Телеф." du="1:10" c="0" />`
    + `<i d="03.06.2026 9:36:11" n="+79857422174" zp="VoLTE" s="Телеф." du="0:27" c="0" />`
    + `<i d="02.06.2026 10:15:18" n="&lt;--+79525432792" zp="VoLTE" s="Телеф." du="2:29" c="0" />`
    + `<i d="01.06.2026 0:24:32" n="internet.mts.ru" s="4G" du="250Kb" c="0" />`
    + `<i d="04.06.2026 16:23:47" n="Call_waiting" s="cw" du="1" c="0" />`
    + `</ds></Report>`;

  it('берёт только голосовые звонки (Телеф.), пропускает трафик/ожидание', () => {
    const calls = mtsBusinessCdrService.parseXml(xml);
    expect(calls).toHaveLength(3);
    expect(calls.map(c => c.durationSec).sort((a, b) => a - b)).toEqual([27, 70, 149]);
  });

  it('свой номер из <ds n>, направление по маркеру «<--»', () => {
    const calls = mtsBusinessCdrService.parseXml(xml);
    expect(calls.every(c => c.msisdn === '79001234567')).toBe(true);
    const incoming = calls.find(c => c.direction === 'in' && c.durationSec === 149);
    expect(incoming).toBeDefined();
    expect(incoming?.peer).toBe('+79525432792'); // маркер «&lt;--» снят
    expect(calls.filter(c => c.direction === 'out')).toHaveLength(1); // только 0:27
    expect(calls.filter(c => c.direction === 'in')).toHaveLength(2);  // 1:10 и 2:29
  });

  it('fallbackMsisdn, если у раздела нет числового номера', () => {
    const noOwn = `<Report><ds type="Сетевой ресурс">`
      + `<i d="02.06.2026 8:00:00" n="+79005556677" s="Телеф." du="0:30" /></ds></Report>`;
    const calls = mtsBusinessCdrService.parseXml(noOwn, '+7 900 000 11 22');
    expect(calls).toHaveLength(1);
    expect(calls[0].msisdn).toBe('79000001122');
    expect(calls[0].durationSec).toBe(30);
  });

  it('пустой/битый XML → пустой список без исключения', () => {
    expect(mtsBusinessCdrService.parseXml('<Report></Report>')).toEqual([]);
    expect(mtsBusinessCdrService.parseXml('')).toEqual([]);
  });
});

describe('МТС Бизнес: пары номер→ФИО из XML (<tp sim= u=>)', () => {
  it('извлекает пары, чистит пробелы, схлопывает дубли, отсекает не-номера', () => {
    const xml = '<Report>'
      + '<tp sim="79001234567" t="Сетевой ресурс" u="Сычев Игорь Алексеевич" ed="30.06.2026"/>'
      + '<tp sim="79001234567" u="Дубль Дубль Дубль"/>'
      + '<tp sim="79007654321" u="Гундорова Ксения Валентиновна"/>'
      + '<tp sim="123" u="Не Номер"/>'
      + '<tp sim="79000000000" u=""/>'
      + '</Report>';
    const pairs = mtsBusinessCdrService.extractSimNames(xml);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ msisdn: '79001234567', fio: 'Сычев Игорь Алексеевич' });
    expect(pairs[1]).toEqual({ msisdn: '79007654321', fio: 'Гундорова Ксения Валентиновна' });
  });

  it('битый/пустой XML → пустой список', () => {
    expect(mtsBusinessCdrService.extractSimNames('')).toEqual([]);
    expect(mtsBusinessCdrService.extractSimNames('мусор')).toEqual([]);
  });
});

describe('МТС Бизнес: парсинг XLS-детализации', () => {
  // Строим книгу как реальный отчёт: лист-сводка (без детального заголовка,
  // пропускается) + лист-номер (имя листа = свой номер) с шапкой и строками.
  const buildBuffer = (): Buffer => {
    const wb = XLSX.utils.book_new();
    const summary = XLSX.utils.aoa_to_sheet([
      ['Общая сводка'],
      ['Период / Period:', '01.05.2026-31.05.2026'],
      ['Звонки / Calls', 'Итого', '48,6', 'мин.'],
    ]);
    XLSX.utils.book_append_sheet(wb, summary, 'Общая сводка');

    const detail = XLSX.utils.aoa_to_sheet([
      ['№ строки/Line number', 'Дата/ Date', 'Время/ Time', 'Номер собеседника/ Interlocutor number', 'Имя', 'Тип сервиса/ Service type', 'Область/ Area', 'Кол-во (объём)/ Volume'],
      ['1', '01.05.2026', '10:00:00', '985**109 8580', 'Иванов', 'Мест. связь', 'Звонок', '0:02:00'],
      ['2', '02.05.2026', '00:00:00', 'GPRS', null, 'GPRS', null, '463,812 Mb'],
      ['3', '03.05.2026', '17:00:00', 'MTC', null, 'Мест. SMS', null, '0'],
      ['4', '04.05.2026', '11:00:00', '910**454 2602', 'Петров', 'Мест. связь', 'Звонок', '0:00:30'],
    ]);
    XLSX.utils.book_append_sheet(wb, detail, '79001234567');

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };

  it('берёт только звонки (по длительности), пропускает GPRS/SMS и сводку', () => {
    const calls = mtsBusinessCdrService.parseXls(buildBuffer());
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.durationSec).sort((a, b) => a - b)).toEqual([30, 120]);
  });

  it('свой номер берётся из имени листа', () => {
    const calls = mtsBusinessCdrService.parseXls(buildBuffer());
    expect(calls.every(c => c.msisdn === '79001234567')).toBe(true);
  });

  it('parseFile диспетчеризует по расширению (.xls → XLS)', () => {
    const calls = mtsBusinessCdrService.parseFile(buildBuffer(), 'detaliz.xls');
    expect(calls).toHaveLength(2);
  });

  it('parseFile с .xml идёт в XML-ветку (реальный формат)', () => {
    const xml = '<Report><ds n="79001234567" type="Сетевой ресурс">'
      + '<i d="01.06.2026 9:00:00" n="+79150000000" s="Телеф." du="1:00" /></ds></Report>';
    const calls = mtsBusinessCdrService.parseFile(Buffer.from(xml, 'utf8'), 'detaliz.xml');
    expect(calls).toHaveLength(1);
    expect(calls[0].durationSec).toBe(60);
  });
});
