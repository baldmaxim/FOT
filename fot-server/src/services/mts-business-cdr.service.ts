import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import * as XLSX from 'xlsx';
import { execute, query } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';

// Разбор XML-детализации МТС «Бизнес» → строки CDR (звонки) → персист с дедупом
// → агрегация «время разговоров» по сотрудникам.
//
// ВАЖНО: точная схема XML детализации МТС Бизнес не зафиксирована публично —
// нужен реальный образец файла. Парсер намеренно ТЕРПИМ: ищет повторяющиеся
// «строки-звонки» в любом месте дерева и достаёт поля по списку кандидатов имён
// (см. FIELD_CANDIDATES). При появлении реального образца — правится ТОЛЬКО этот
// список и parseDurationSec/parseCallDate. Формат iv:authTag:encrypted для ПДн.

export interface IParsedCall {
  msisdn: string | null;
  peer: string | null;
  startedAt: string; // ISO
  durationSec: number;
  direction: string | null;
  callType: string | null;
}

export interface ITalkTimeRow {
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  calls: number;
  totalSeconds: number;
}

const FIELD_CANDIDATES = {
  duration: ['duration', 'callduration', 'durationsec', 'durationseconds', 'length', 'talktime', 'продолжительность', 'длительность', 'длительностьразговора'],
  date: ['date', 'calldate', 'startdate', 'starttime', 'datetime', 'dateandtime', 'begin', 'begintime', 'start', 'дата', 'датавремя', 'датазвонка', 'датаивремя', 'времяначала'],
  msisdn: ['msisdn', 'abonent', 'ownnumber', 'мойномер', 'номерабонента', 'номертелефона'],
  msisdnFallback: ['number', 'phone', 'номер'],
  peer: ['peer', 'othernumber', 'callednumber', 'callingnumber', 'contact', 'contactnumber', 'destination', 'interlocutor', 'номерсобеседника', 'номервызываемого', 'вызываемыйномер', 'абонентб'],
  direction: ['direction', 'type', 'calltype', 'category', 'направление', 'типзвонка', 'вид', 'видсвязи'],
} as const;

/** Ключ объекта → нормализованный вид (нижний регистр, только буквы/цифры, без @_ ). */
const normKey = (k: string): string => k.replace(/^@_/, '').toLowerCase().replace(/[^a-zа-я0-9]/gi, '');

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

// В XLS-детализации МТС строка = ЗВОНОК, если Volume («Кол-во/объём») — длительность
// H:MM:SS. GPRS даёт «… Mb», SMS — штуки/0. Так отличаем голос от трафика/SMS.
const DURATION_RE = /^\d{1,3}:\d{2}:\d{2}$/;

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
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  // DD.MM.YYYY [HH:MM[:SS]]
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
};

const readField = (normalizedByKey: Map<string, unknown>, candidates: readonly string[]): unknown => {
  for (const c of candidates) {
    if (normalizedByKey.has(c)) return normalizedByKey.get(c);
  }
  return undefined;
};

const looksLikeCall = (normalizedByKey: Map<string, unknown>): boolean => {
  return FIELD_CANDIDATES.duration.some(c => normalizedByKey.has(c));
};

const mapToNormalized = (obj: Record<string, unknown>): Map<string, unknown> => {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    // Берём скалярные значения (и атрибуты). Вложенные объекты пропускаем как поля.
    if (v == null || typeof v !== 'object') map.set(normKey(k), v);
  }
  return map;
};

const collectRecords = (node: unknown, out: Record<string, unknown>[]): void => {
  if (Array.isArray(node)) {
    for (const el of node) collectRecords(el, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const normalized = mapToNormalized(obj);
    if (looksLikeCall(normalized)) out.push(obj);
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') collectRecords(v, out);
    }
  }
};

class MtsBusinessCdrService {
  /**
   * Разбирает XML-детализацию в строки звонков. fallbackMsisdn — номер, который
   * присвоить строкам без собственного номера (когда детализация по одному номеру).
   */
  parseXml(xml: string, fallbackMsisdn?: string | null): IParsedCall[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: false,
      // Значения тегов оставляем строками: длинные номера/лицевые счета не теряют
      // точность (число > 2^53), а длительность/дату мы парсим сами.
      parseTagValue: false,
      trimValues: true,
    });
    const parsed = parser.parse(xml);
    const records: Record<string, unknown>[] = [];
    collectRecords(parsed, records);

    const calls: IParsedCall[] = [];
    for (const rec of records) {
      const nk = mapToNormalized(rec);
      const startedAt = parseCallDate(readField(nk, FIELD_CANDIDATES.date));
      if (!startedAt) continue; // строки без даты не агрегируем (started_at NOT NULL)
      const durationSec = parseDurationSec(readField(nk, FIELD_CANDIDATES.duration));
      const ownRaw = readField(nk, FIELD_CANDIDATES.msisdn) ?? readField(nk, FIELD_CANDIDATES.msisdnFallback);
      const msisdn = normalizeMsisdn(ownRaw as string | null | undefined) ?? normalizeMsisdn(fallbackMsisdn);
      const peer = normalizeMsisdn(readField(nk, FIELD_CANDIDATES.peer) as string | null | undefined);
      const directionRaw = readField(nk, FIELD_CANDIDATES.direction);
      const direction = directionRaw != null ? String(directionRaw).slice(0, 40) : null;
      calls.push({ msisdn, peer, startedAt, durationSec, direction, callType: null });
    }
    return calls;
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

  /** Разобрать файл и сохранить (диспетчер по расширению). */
  async parseFileAndStore(
    buffer: Buffer,
    filename: string,
    sourceMessageId: string | null,
    fallbackMsisdn?: string | null,
  ): Promise<{ parsed: number; inserted: number; skipped: number }> {
    const calls = this.parseFile(buffer, filename, fallbackMsisdn);
    const { inserted, skipped } = await this.storeCalls(calls, sourceMessageId);
    console.log(`[mts-biz-cdr] file="${filename}" parsed=${calls.length} inserted=${inserted} skipped=${skipped}`);
    return { parsed: calls.length, inserted, skipped };
  }

  /** Персист строк CDR с дедупом по dedup_hash. Возвращает счётчики. */
  async storeCalls(calls: IParsedCall[], sourceMessageId: string | null): Promise<{ inserted: number; skipped: number }> {
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
        rows.push(`($${b - 8}, $${b - 7}, $${b - 6}, $${b - 5}, $${b - 4}, $${b - 3}, $${b - 2}, $${b - 1}, $${b})`);
      }
      if (rows.length === 0) continue;
      const affected = await execute(
        `INSERT INTO mts_business_cdr
           (dedup_hash, msisdn_hash, msisdn_enc, peer_number_enc, direction, started_at, duration_sec, call_type, source_message_id)
         VALUES ${rows.join(', ')}
         ON CONFLICT (dedup_hash) DO NOTHING`,
        params,
      );
      inserted += affected;
    }
    return { inserted, skipped: calls.length - inserted };
  }

  /** Разобрать XML и сохранить. */
  async parseAndStore(
    xml: string,
    sourceMessageId: string | null,
    fallbackMsisdn?: string | null,
  ): Promise<{ parsed: number; inserted: number; skipped: number }> {
    const calls = this.parseXml(xml, fallbackMsisdn);
    const { inserted, skipped } = await this.storeCalls(calls, sourceMessageId);
    console.log(`[mts-biz-cdr] parsed=${calls.length} inserted=${inserted} skipped=${skipped}`);
    return { parsed: calls.length, inserted, skipped };
  }

  /** Агрегация «время разговоров» по сотрудникам за период [from, to] (YYYY-MM-DD, включительно). */
  async getTalkTimeReport(from: string, to: string): Promise<ITalkTimeRow[]> {
    const rows = await query<{
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
      calls: string;
      total_sec: string;
    }>(
      `SELECT m.employee_id,
              e.full_name,
              e.tab_number,
              COUNT(*)::text AS calls,
              COALESCE(SUM(c.duration_sec), 0)::text AS total_sec
         FROM mts_business_cdr c
         LEFT JOIN mts_business_number_map m ON m.msisdn_hash = c.msisdn_hash
         LEFT JOIN employees e ON e.id = m.employee_id
        WHERE c.started_at >= $1::date
          AND c.started_at < ($2::date + INTERVAL '1 day')
        GROUP BY m.employee_id, e.full_name, e.tab_number
        ORDER BY SUM(c.duration_sec) DESC NULLS LAST`,
      [from, to],
    );
    return rows.map(r => ({
      employeeId: r.employee_id,
      employeeFullName: r.full_name,
      employeeTabNumber: r.tab_number,
      calls: Number(r.calls),
      totalSeconds: Number(r.total_sec),
    }));
  }
}

export const mtsBusinessCdrService = new MtsBusinessCdrService();
