import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import * as XLSX from 'xlsx';
import { execute, query } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';

// Разбор детализации МТС «Бизнес» → строки CDR (звонки) → персист с дедупом
// → агрегация «время разговоров» по сотрудникам. ПДн шифруются (iv:authTag:enc).
//
// Форматы (подтверждены реальными образцами):
//  - XML (реально приходит из API/на почту): <Report>…<ds n="СВОЙ_НОМЕР" type=…
//    sim=…>…<i d="ДД.ММ.ГГГГ Ч:ММ:СС" n="собеседник" s="Телеф." du="М:СС" …/>…
//    </ds>… Данные в АТРИБУТАХ. Детальный раздел — <ds> с n = номер (сводки
//    услуг под <tp> имеют n = название услуги и отсекаются). Голос = запись
//    s="Телеф." с du в формате длительности (проверено 1:1). Направление — по
//    маркеру «&lt;--» в n (входящий). Трафик (Kb)/SMS/ожидание — отсекаются.
//  - XLS (отчёт из ЛК/Тарифер): лист на номер (имя листа = номер), звонок = строка
//    с Volume в формате длительности. См. parseXls.

export interface IParsedCall {
  msisdn: string | null;
  peer: string | null;
  startedAt: string; // ISO
  durationSec: number;
  direction: string | null;
  callType: string | null;
}

export interface ISimName {
  msisdn: string; // канонический 7XXXXXXXXXX
  fio: string;
}

export interface ITalkTimeRow {
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  calls: number;
  totalSeconds: number;
  inSeconds: number;
  outSeconds: number;
}

export interface IAccountSummaryRow {
  accountId: string | null;
  label: string | null;
  accountNumber: string | null;
  calls: number;
  totalSeconds: number;
  numbers: number;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

// Длительность звонка: М:СС (XML из API) либо Ч:ММ:СС (XLS-отчёт). Так отличаем
// голос от трафика («…Kb»/«…Mb») и SMS (штуки) и от du="1" (ожидание/сервис).
const DURATION_RE = /^\d{1,3}:\d{2}(:\d{2})?$/;
// Голосовая запись детализации: атрибут s="Телеф." (проверено: s="Телеф." ⟺
// запись с du в формате длительности, т.е. реальный разговор).
const VOICE_S_RE = /^Телеф/i;

const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

/** Рекурсивно собрать все узлы под ключом tag (учитывая массивы/вложенность). */
const collectByTag = (node: unknown, tag: string, out: Record<string, unknown>[]): void => {
  if (Array.isArray(node)) {
    for (const el of node) collectByTag(el, tag, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === tag) for (const el of asArray(v)) if (el && typeof el === 'object') out.push(el as Record<string, unknown>);
      if (v && typeof v === 'object') collectByTag(v, tag, out);
    }
  }
};

/** Собеседник из атрибута n: убрать маркер входящего «<--»/«&lt;--» и сервис-префиксы. */
const cleanPeer = (raw: string): string | null => {
  const s = (raw || '').replace(/^(&lt;|<)--/, '').replace(/^[a-z0-9]+_/i, '').trim();
  return s || null;
};

const cell = (row: unknown[], idx: number): string => {
  if (idx < 0 || idx >= row.length) return '';
  const v = row[idx];
  return v == null ? '' : String(v).trim();
};

const findHeaderIndexes = (rows: unknown[][]): {
  headerRow: number;
  date: number; time: number; volume: number; peer: number; service: number;
} | null => {
  const test = (s: string, re: RegExp): boolean => re.test(s);
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i].map(c => (c == null ? '' : String(c)));
    const date = r.findIndex(c => test(c, /дата|date/i));
    const volume = r.findIndex(c => test(c, /кол-?во|volume|об[ъь]?[еёе]м/i));
    if (date >= 0 && volume >= 0) {
      return {
        headerRow: i,
        date,
        volume,
        time: r.findIndex(c => test(c, /время|time/i)),
        peer: r.findIndex(c => test(c, /собеседник|interlocutor/i)),
        service: r.findIndex(c => test(c, /тип\s*сервиса|service\s*type/i)),
      };
    }
  }
  return null;
};

/** Цифры номера в канонический вид (для дедупа/маппинга): 7XXXXXXXXXX. */
export const normalizeMsisdn = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return digits;
};

export const msisdnHash = (raw: string | null | undefined): string | null => {
  const norm = normalizeMsisdn(raw);
  return norm ? sha256(norm) : null;
};

/** Длительность → секунды. Понимает число (сек) и строки "HH:MM:SS"/"MM:SS". */
export const parseDurationSec = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10));
  const parts = s.split(':').map(p => parseInt(p, 10));
  if (parts.length && parts.every(n => Number.isFinite(n))) {
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

/** Дата звонка → ISO. Понимает ISO, "YYYY-MM-DD HH:MM:SS" и "DD.MM.YYYY HH:MM:SS". */
export const parseCallDate = (value: unknown): string | null => {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  // DD.MM.YYYY [H:MM[:SS]] — ПРИОРИТЕТНО (иначе new Date путает DD.MM как MM.DD).
  // Час может быть однозначным (напр. "9:36:11"). Время трактуется как локальное
  // (сервер в Europe/Moscow — как и весь проект).
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  return null;
};

class MtsBusinessCdrService {
  /**
   * Разбирает XML-детализацию МТС (реальный формат API). Детальные записи лежат
   * под разделами <ds n="СВОЙ_НОМЕР" type=… sim=…> (по одному на номер), внутри —
   * <i d="ДД.ММ.ГГГГ Ч:ММ:СС" n="собеседник" s="Телеф." du="М:СС" …/>. Голос —
   * записи s="Телеф." с du в формате длительности. Направление — по маркеру «<--»
   * в атрибуте n (входящий). Свой номер — атрибут n у раздела <ds>.
   * fallbackMsisdn — если у раздела нет числового номера.
   */
  parseXml(xml: string, fallbackMsisdn?: string | null): IParsedCall[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: false,
      // Значения оставляем строками: длинные номера не теряют точность (>2^53),
      // длительность/дату парсим сами.
      parseTagValue: false,
      trimValues: true,
      // Реальный файл содержит тысячи «&lt;--» (маркер входящего) → упирается в
      // лимит раскрытия сущностей fast-xml-parser (1000). Отключаем обработку
      // сущностей; «&lt;--» снимаем в cleanPeer вручную.
      processEntities: false,
    });
    const parsed = parser.parse(xml);

    // Все <ds>; детальный раздел — тот, у кого n = номер (сводки услуг имеют
    // n = название услуги → normalizeMsisdn вернёт null → пропуск).
    const dss: Record<string, unknown>[] = [];
    collectByTag(parsed, 'ds', dss);

    const calls: IParsedCall[] = [];
    for (const ds of dss) {
      const own = normalizeMsisdn(ds['@_n'] as string | undefined) ?? normalizeMsisdn(fallbackMsisdn);
      if (!own) continue;
      for (const it of asArray(ds.i as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
        const item = it as Record<string, unknown>;
        if (!VOICE_S_RE.test(String(item['@_s'] ?? ''))) continue; // только голос (Телеф.)
        const du = String(item['@_du'] ?? '');
        if (!DURATION_RE.test(du)) continue;
        const startedAt = parseCallDate(String(item['@_d'] ?? ''));
        if (!startedAt) continue;
        const peerRaw = String(item['@_n'] ?? '');
        calls.push({
          msisdn: own,
          peer: cleanPeer(peerRaw),
          startedAt,
          durationSec: parseDurationSec(du),
          direction: /^(&lt;|<)--/.test(peerRaw) ? 'in' : 'out',
          callType: 'Телеф.',
        });
      }
    }
    return calls;
  }

  /**
   * Пары «номер → ФИО» из XML МТС: узлы <tp sim="номер" u="ФИО …">. Источник
   * для автопривязки номеров к сотрудникам. Номер валидируется как 7XXXXXXXXXX,
   * дубли схлопываются (первое ФИО побеждает).
   */
  extractSimNames(xml: string): ISimName[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: true,
      processEntities: false,
    });
    let parsed: unknown;
    try { parsed = parser.parse(xml); } catch { return []; }

    const tps: Record<string, unknown>[] = [];
    collectByTag(parsed, 'tp', tps);

    const byMsisdn = new Map<string, string>();
    for (const tp of tps) {
      const msisdn = normalizeMsisdn(tp['@_sim'] as string | undefined);
      const fio = String(tp['@_u'] ?? '').trim();
      if (!msisdn || !/^7\d{10}$/.test(msisdn) || !fio) continue;
      if (!byMsisdn.has(msisdn)) byMsisdn.set(msisdn, fio);
    }
    return [...byMsisdn.entries()].map(([msisdn, fio]) => ({ msisdn, fio }));
  }

  /**
   * Разбирает XLS-детализацию МТС (SheetJS). Свой номер = имя листа. Звонки —
   * строки, где Volume («Кол-во/объём») в формате длительности H:MM:SS (GPRS/SMS
   * отсекаются). Собеседник маскирован (985**109 8580) — храним как есть.
   * fallbackMsisdn — если имя листа не номер, но файл по одному номеру.
   */
  parseXls(buffer: Buffer, fallbackMsisdn?: string | null): IParsedCall[] {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const calls: IParsedCall[] = [];

    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: null });
      const hdr = findHeaderIndexes(rows);
      if (!hdr) continue; // не детальный лист (напр. «Общая сводка») — пропускаем

      // Свой номер: имя листа (обычно = номер), иначе fallback.
      const own = normalizeMsisdn(sheetName) ?? normalizeMsisdn(fallbackMsisdn);

      for (let i = hdr.headerRow + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!Array.isArray(row)) continue;
        const volume = cell(row, hdr.volume);
        if (!DURATION_RE.test(volume)) continue; // не звонок (GPRS/SMS/пусто)
        const durationSec = parseDurationSec(volume);
        const dateStr = cell(row, hdr.date);
        const timeStr = hdr.time >= 0 ? cell(row, hdr.time) : '';
        const startedAt = parseCallDate(timeStr ? `${dateStr} ${timeStr}` : dateStr);
        if (!startedAt) continue;
        const peerRaw = hdr.peer >= 0 ? cell(row, hdr.peer) : '';
        const service = hdr.service >= 0 ? cell(row, hdr.service) : '';
        calls.push({
          msisdn: own,
          // Собеседник маскирован — не нормализуем, храним сырую строку (или null).
          peer: peerRaw || null,
          startedAt,
          durationSec,
          direction: null,
          callType: service ? service.slice(0, 40) : null,
        });
      }
    }
    return calls;
  }

  /** Разобрать файл детализации по расширению: .xls/.xlsx → XLS, .xml → XML. */
  parseFile(buffer: Buffer, filename: string, fallbackMsisdn?: string | null): IParsedCall[] {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext === 'xls' || ext === 'xlsx') {
      return this.parseXls(buffer, fallbackMsisdn);
    }
    return this.parseXml(buffer.toString('utf8'), fallbackMsisdn);
  }

  /** Разобрать файл и сохранить (диспетчер по расширению). accountId — привязка к ЛС. */
  async parseFileAndStore(
    buffer: Buffer,
    filename: string,
    sourceMessageId: string | null,
    fallbackMsisdn?: string | null,
    accountId?: string | null,
  ): Promise<{ parsed: number; inserted: number; skipped: number }> {
    const calls = this.parseFile(buffer, filename, fallbackMsisdn);
    const { inserted, skipped } = await this.storeCalls(calls, sourceMessageId, accountId ?? null);
    console.log(`[mts-biz-cdr] file="${filename}" parsed=${calls.length} inserted=${inserted} skipped=${skipped}`);
    return { parsed: calls.length, inserted, skipped };
  }

  /** Персист строк CDR с дедупом по dedup_hash. Возвращает счётчики. */
  async storeCalls(
    calls: IParsedCall[],
    sourceMessageId: string | null,
    accountId: string | null = null,
  ): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < calls.length; i += CHUNK) {
      const chunk = calls.slice(i, i + CHUNK);
      const rows: string[] = [];
      const params: unknown[] = [];
      for (const c of chunk) {
        const mHash = msisdnHash(c.msisdn);
        const dedup = sha256(
          [mHash ?? '', c.peer ?? '', c.startedAt, c.durationSec, c.direction ?? ''].join('|'),
        );
        params.push(
          dedup,
          accountId,
          mHash,
          encryptionService.encryptField(c.msisdn),
          encryptionService.encryptField(c.peer),
          c.direction,
          c.startedAt,
          c.durationSec,
          c.callType,
          sourceMessageId,
        );
        const b = params.length;
        rows.push(`($${b - 9}, $${b - 8}, $${b - 7}, $${b - 6}, $${b - 5}, $${b - 4}, $${b - 3}, $${b - 2}, $${b - 1}, $${b})`);
      }
      if (rows.length === 0) continue;
      const affected = await execute(
        `INSERT INTO mts_business_cdr
           (dedup_hash, account_id, msisdn_hash, msisdn_enc, peer_number_enc, direction, started_at, duration_sec, call_type, source_message_id)
         VALUES ${rows.join(', ')}
         ON CONFLICT (dedup_hash) DO NOTHING`,
        params,
      );
      inserted += affected;
    }
    return { inserted, skipped: calls.length - inserted };
  }

  /**
   * Агрегация «время разговоров» по сотрудникам за период [from, to] (YYYY-MM-DD,
   * включительно). accountId — опциональный фильтр по лицевому счёту.
   */
  async getTalkTimeReport(from: string, to: string, accountId?: string | null): Promise<ITalkTimeRow[]> {
    const rows = await query<{
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
      calls: string;
      total_sec: string;
      in_sec: string;
      out_sec: string;
    }>(
      `SELECT m.employee_id,
              e.full_name,
              e.tab_number,
              COUNT(*)::text AS calls,
              COALESCE(SUM(c.duration_sec), 0)::text AS total_sec,
              COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'in'), 0)::text AS in_sec,
              COALESCE(SUM(c.duration_sec) FILTER (WHERE c.direction = 'out'), 0)::text AS out_sec
         FROM mts_business_cdr c
         LEFT JOIN mts_business_number_map m ON m.msisdn_hash = c.msisdn_hash
         LEFT JOIN employees e ON e.id = m.employee_id
        WHERE c.started_at >= $1::date
          AND c.started_at < ($2::date + INTERVAL '1 day')
          AND ($3::uuid IS NULL OR c.account_id = $3::uuid)
        GROUP BY m.employee_id, e.full_name, e.tab_number
        ORDER BY SUM(c.duration_sec) DESC NULLS LAST`,
      [from, to, accountId ?? null],
    );
    return rows.map(r => ({
      employeeId: r.employee_id,
      employeeFullName: r.full_name,
      employeeTabNumber: r.tab_number,
      calls: Number(r.calls),
      totalSeconds: Number(r.total_sec),
      inSeconds: Number(r.in_sec),
      outSeconds: Number(r.out_sec),
    }));
  }

  /** Сводка по лицевым счетам за период: звонки/время/кол-во номеров на аккаунт. */
  async getAccountsSummary(from: string, to: string): Promise<IAccountSummaryRow[]> {
    const rows = await query<{
      account_id: string | null;
      label: string | null;
      account_number: string | null;
      calls: string;
      total_sec: string;
      numbers: string;
    }>(
      `SELECT c.account_id,
              a.label,
              a.account_number,
              COUNT(*)::text AS calls,
              COALESCE(SUM(c.duration_sec), 0)::text AS total_sec,
              COUNT(DISTINCT c.msisdn_hash)::text AS numbers
         FROM mts_business_cdr c
         LEFT JOIN mts_business_accounts a ON a.id = c.account_id
        WHERE c.started_at >= $1::date
          AND c.started_at < ($2::date + INTERVAL '1 day')
        GROUP BY c.account_id, a.label, a.account_number
        ORDER BY SUM(c.duration_sec) DESC NULLS LAST`,
      [from, to],
    );
    return rows.map(r => ({
      accountId: r.account_id,
      label: r.label,
      accountNumber: r.account_number,
      calls: Number(r.calls),
      totalSeconds: Number(r.total_sec),
      numbers: Number(r.numbers),
    }));
  }
}

export const mtsBusinessCdrService = new MtsBusinessCdrService();
