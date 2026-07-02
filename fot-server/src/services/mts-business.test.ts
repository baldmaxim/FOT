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

describe('МТС Бизнес: парсинг XML детализации', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <Report>
      <Calls>
        <Call>
          <date>2026-06-01T09:15:00Z</date>
          <duration>125</duration>
          <msisdn>+7 (900) 123-45-67</msisdn>
          <peer>89001112233</peer>
          <direction>outbound</direction>
        </Call>
        <Call>
          <date>01.06.2026 10:00:00</date>
          <duration>00:02:00</duration>
          <number>79001234567</number>
          <direction>inbound</direction>
        </Call>
        <Call>
          <duration>50</duration>
          <msisdn>79001234567</msisdn>
        </Call>
      </Calls>
    </Report>`;

  it('достаёт звонки, пропускает строки без даты', () => {
    const calls = mtsBusinessCdrService.parseXml(xml);
    // Третий звонок без даты — отброшен.
    expect(calls).toHaveLength(2);
  });

  it('нормализует номера и длительность', () => {
    const calls = mtsBusinessCdrService.parseXml(xml);
    const first = calls[0];
    expect(first.msisdn).toBe('79001234567');
    expect(first.peer).toBe('79001112233');
    expect(first.durationSec).toBe(125);
    expect(first.direction).toBe('outbound');

    const second = calls[1];
    expect(second.msisdn).toBe('79001234567'); // из <number>
    expect(second.durationSec).toBe(120);      // 00:02:00
  });

  it('fallbackMsisdn присваивается строкам без собственного номера', () => {
    const noOwn = `<Report><Calls>
      <Call><date>2026-06-02T08:00:00Z</date><duration>30</duration><peer>79005556677</peer></Call>
    </Calls></Report>`;
    const calls = mtsBusinessCdrService.parseXml(noOwn, '+7 900 000 11 22');
    expect(calls).toHaveLength(1);
    expect(calls[0].msisdn).toBe('79000001122');
  });

  it('пустой/битый XML → пустой список без исключения', () => {
    expect(mtsBusinessCdrService.parseXml('<Report></Report>')).toEqual([]);
    expect(mtsBusinessCdrService.parseXml('')).toEqual([]);
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

  it('parseFile с .xml идёт в XML-ветку', () => {
    const xml = '<Report><Calls><Call><date>2026-06-01T09:00:00Z</date><duration>60</duration><msisdn>79001234567</msisdn></Call></Calls></Report>';
    const calls = mtsBusinessCdrService.parseFile(Buffer.from(xml, 'utf8'), 'detaliz.xml');
    expect(calls).toHaveLength(1);
    expect(calls[0].durationSec).toBe(60);
  });
});
