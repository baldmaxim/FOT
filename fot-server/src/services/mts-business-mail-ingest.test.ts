import { describe, it, expect } from 'vitest';
import {
  extractUuids,
  isIngestableFilename,
  parseHostSuffixes,
  isAllowedLinkUrl,
  extractFileLinks,
  senderMatchesFilter,
  filenameFromContentDisposition,
  filenameFromUrl,
} from './mts-business-mail-ingest.service.js';

describe('mts-business-mail-ingest helpers', () => {
  it('extractUuids: находит UUID в любом регистре, без дублей', () => {
    const text = 'Заявка 6F9619FF-8B86-D011-B42D-00C04FC964FF готова. '
      + 'Повтор: 6f9619ff-8b86-d011-b42d-00c04fc964ff, ещё 123e4567-e89b-12d3-a456-426614174000.';
    expect(extractUuids(text)).toEqual([
      '6f9619ff-8b86-d011-b42d-00c04fc964ff',
      '123e4567-e89b-12d3-a456-426614174000',
    ]);
    expect(extractUuids('без идентификаторов')).toEqual([]);
  });

  it('extractUuids: находит реальный messageId МТС формата hex16_счётчик', () => {
    const text = 'Ваш запрос C1BA2D26D5999FB4_1 обработан. Повтор: c1ba2d26d5999fb4_1, ещё abcdef0123456789_42.';
    expect(extractUuids(text)).toEqual(['c1ba2d26d5999fb4_1', 'abcdef0123456789_42']);
  });

  it('extractUuids: комбинирует UUID и messageId МТС в одном тексте', () => {
    const text = 'UUID 123e4567-e89b-12d3-a456-426614174000 и messageId c1ba2d26d5999fb4_1 в одном письме.';
    expect(extractUuids(text)).toEqual(['123e4567-e89b-12d3-a456-426614174000', 'c1ba2d26d5999fb4_1']);
  });

  it('isIngestableFilename: xml/xls/xlsx, регистронезависимо', () => {
    expect(isIngestableFilename('detal.XML')).toBe(true);
    expect(isIngestableFilename('report.xlsx')).toBe(true);
    expect(isIngestableFilename(' report.xls ')).toBe(true);
    expect(isIngestableFilename('detal.pdf')).toBe(false);
    expect(isIngestableFilename('archive.zip')).toBe(false);
    expect(isIngestableFilename(null)).toBe(false);
    expect(isIngestableFilename(undefined)).toBe(false);
  });

  it('parseHostSuffixes: разбирает список, чистит пробелы и регистр', () => {
    expect(parseHostSuffixes('mts.ru, Dokumenty.MTS.ru ,')).toEqual(['mts.ru', 'dokumenty.mts.ru']);
    expect(parseHostSuffixes('')).toEqual([]);
  });

  it('isAllowedLinkUrl: только https и хост из allow-list (включая поддомены)', () => {
    const hosts = ['mts.ru'];
    expect(isAllowedLinkUrl('https://mts.ru/f.xml', hosts)).toBe(true);
    expect(isAllowedLinkUrl('https://docs.mts.ru/report.xlsx', hosts)).toBe(true);
    expect(isAllowedLinkUrl('http://mts.ru/f.xml', hosts)).toBe(false); // не https
    expect(isAllowedLinkUrl('https://evil-mts.ru/f.xml', hosts)).toBe(false); // суффикс-подделка
    expect(isAllowedLinkUrl('https://mts.ru.evil.com/f.xml', hosts)).toBe(false);
    expect(isAllowedLinkUrl('не ссылка', hosts)).toBe(false);
  });

  it('extractFileLinks: ссылки на файлы с разрешённых хостов, без дублей', () => {
    const hosts = ['mts.ru'];
    const text = 'Скачать: https://docs.mts.ru/download/abc.xml?sig=1 . '
      + 'Дубль https://docs.mts.ru/download/abc.xml?sig=1, чужое https://evil.com/x.xml, '
      + 'просто сайт https://mts.ru/about';
    expect(extractFileLinks(text, hosts)).toEqual(['https://docs.mts.ru/download/abc.xml?sig=1']);
  });

  it('extractFileLinks: ловит download-ссылки без расширения и срезает пунктуацию', () => {
    const hosts = ['mts.ru'];
    const html = '<a href="https://lk.mts.ru/document/42">файл</a>, текст: https://lk.mts.ru/download/77.';
    expect(extractFileLinks(html, hosts)).toEqual([
      'https://lk.mts.ru/document/42',
      'https://lk.mts.ru/download/77',
    ]);
  });

  it('senderMatchesFilter: подстрока адреса, пустой фильтр пропускает всё', () => {
    expect(senderMatchesFilter('noreply@mts.ru', 'mts.ru')).toBe(true);
    expect(senderMatchesFilter('Noreply@MTS.RU', 'mts.ru')).toBe(true);
    expect(senderMatchesFilter('spam@evil.com', 'mts.ru')).toBe(false);
    expect(senderMatchesFilter(null, 'mts.ru')).toBe(false);
    expect(senderMatchesFilter('anyone@anywhere', '')).toBe(true);
  });

  it('filenameFromContentDisposition: filename и filename*=UTF-8', () => {
    expect(filenameFromContentDisposition('attachment; filename="detal.xml"')).toBe('detal.xml');
    expect(filenameFromContentDisposition('attachment; filename=detal.xls')).toBe('detal.xls');
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''%D0%B4%D0%B5%D1%82%D0%B0%D0%BB%D1%8C.xml"))
      .toBe('деталь.xml');
    expect(filenameFromContentDisposition(null)).toBe(null);
    expect(filenameFromContentDisposition('inline')).toBe(null);
  });

  it('filenameFromUrl: последний сегмент пути, декодированный', () => {
    expect(filenameFromUrl('https://docs.mts.ru/download/detal.xml?sig=1')).toBe('detal.xml');
    expect(filenameFromUrl('https://docs.mts.ru/download/%D0%B4%D0%B5%D1%82%D0%B0%D0%BB%D1%8C.xls')).toBe('деталь.xls');
    expect(filenameFromUrl('https://docs.mts.ru/')).toBe(null);
    expect(filenameFromUrl('мусор')).toBe(null);
  });
});
