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
//  - JSON (синхронный GET /Bills/BillingStatementExtdByMSISDN, проверено живым
//    вызовом 02.07.2026): { Usages: [{ date, Characteristics: { networkEvent,
//    direction, factUnits, factUnitCode, calledMsisdn } }] }. Голос —
//    networkEvent==='call' (НЕ categoryId — у «Удержание вызова» тот же
//    categoryId=local_call, но networkEvent='other'). Длительность — factUnits
//    при factUnitCode==='SECOND'. Собеседник (calledMsisdn) НЕ замаскирован.
//    См. parseBillingStatementResponse.

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

// Категории для сводки расходов (карточка номера, §4). topups — пополнения:
// в сводку берутся из PaymentHistory; в выписке ими помечаются строки-платежи
// (видны в детальных строках, из расходов исключаются).
export type MtsExpenseCategory = 'calls' | 'sms' | 'internet' | 'periodic' | 'oneTime' | 'topups' | 'other';

export interface IStatementUsageEvent {
  category: MtsExpenseCategory;
  amount: number; // рубли, ≥0 (расход)
  date: string | null; // YYYY-MM-DD дня расхода (из Usages[].date)
}

/** Строка детальной выписки по использованию SIM (для вкладки «Использование»). */
export interface IStatementUsageRow {
  date: string | null;
  category: MtsExpenseCategory;
  label: string | null;        // человекочитаемое описание от МТС
  networkEvent: string | null; // call | sms | traffic | …
  direction: 'in' | 'out' | null;
  peer: string | null;         // собеседник / APN
  units: number | null;        // factUnits (секунды/байты/шт)
  unitCode: string | null;     // SECOND | BYTE | FACT | …
  amount: number;              // рубли, ≥0
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

// Сумма списания в строке выписки — имена полей НЕ проверены живым вызовом
// (обычная BillingStatement может отличаться от Extd), поэтому обход по ряду
// вероятных ключей.
const pickAmount = (o: Record<string, unknown>): number | null => {
  for (const k of ['cost', 'amount', 'sum', 'charge', 'chargeAmount', 'taxIncludedAmount', 'factCost', 'value']) {
    if (o[k] != null) {
      const n = Number(o[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
};

// Категория строки расхода по типу события/единице/категории.
const classifyUsage = (c: Record<string, unknown>): MtsExpenseCategory => {
  const ne = String(c.networkEvent ?? '').toLowerCase();
  const unit = String(c.factUnitCode ?? '').toUpperCase();
  const cat = String(c.categoryId ?? c.category ?? '').toLowerCase();
  // Пополнение ЛС (categoryId='payment', «Регистрация платежа: Безналичный
  // платёж…») попадает в выписку КАЖДОГО номера контракта — это приход на
  // счёт, не расход номера.
  if (cat === 'payment' || /пополнени|регистрация платеж/i.test(String(c.label ?? ''))) return 'topups';
  if (ne === 'call' || unit === 'SECOND' || /call|voice|голос/.test(cat)) return 'calls';
  if (unit === 'ITEM' || ne === 'sms' || /sms|смс/.test(cat)) return 'sms';
  if (unit === 'BYTE' || ne === 'gprs' || ne === 'data' || /gprs|internet|интернет|data/.test(cat)) return 'internet';
  if (/period|subscription|abon|абон/.test(cat)) return 'periodic';
  if (/one.?time|разов/.test(cat)) return 'oneTime';
  return 'other';
};

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
    // Regex-проход вместо полного парсинга: файл по ЛС реально весит >100 МБ,
    // а второе дерево fast-xml-parser на таком объёме — лишние секунды и память.
    const byMsisdn = new Map<string, string>();
    for (const m of xml.matchAll(/<tp\s[^>]*>/g)) {
      const tag = m[0];
      const sim = tag.match(/\ssim="([^"]*)"/)?.[1];
      const u = tag.match(/\su="([^"]*)"/)?.[1];
      const msisdn = normalizeMsisdn(sim);
      const fio = (u ?? '').trim();
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

  /**
   * Разбирает синхронный JSON-ответ GET /Bills/BillingStatementExtdByMSISDN
   * (см. формат в шапке файла). ownMsisdn — номер, по которому сделан запрос
   * (в самом ответе своего номера нет — API уже скопирован на один msisdn).
   */
  parseBillingStatementResponse(data: unknown, ownMsisdn: string): IParsedCall[] {
    const own = normalizeMsisdn(ownMsisdn);
    if (!own) return [];
    const usages = data && typeof data === 'object' ? (data as Record<string, unknown>).Usages : null;
    const calls: IParsedCall[] = [];
    for (const raw of asArray(usages as Record<string, unknown>[] | undefined)) {
      const u = raw as { date?: string; Characteristics?: Record<string, unknown> };
      const c = u.Characteristics;
      if (!c || c.networkEvent !== 'call') continue; // трафик/SMS/сервисные события (в т.ч. «Удержание вызова») — не звонок
      if (c.factUnitCode !== 'SECOND') continue;
      const startedAt = parseCallDate(u.date);
      if (!startedAt) continue;
      const peerRaw = c.calledMsisdn != null ? String(c.calledMsisdn) : null;
      const direction = c.direction === 'I' ? 'in' : c.direction === 'O' ? 'out' : null;
      calls.push({
        msisdn: own,
        peer: normalizeMsisdn(peerRaw) ?? peerRaw,
        startedAt,
        durationSec: Math.max(0, Math.round(Number(c.factUnits) || 0)),
        direction,
        callType: 'call',
      });
    }
    return calls;
  }

  /**
   * Категоризированные строки РАСХОДА из выписки (Bills/BillingStatement*) —
   * для сводки расходов карточки номера. В отличие от parseBillingStatementResponse
   * (только голос для CDR), берёт все строки Usages с суммой списания, КРОМЕ
   * пополнений (type='income' / categoryId='payment'): платёж на ЛС дублируется
   * в выписке каждого номера контракта (434 700 ₽ у 1460 номеров, 07.07.2026)
   * и расходом не является. Опциональный fromDate (YYYY-MM-DD, включительно)
   * отсекает строки раньше даты — для месячного окна начислений.
   */
  parseStatementUsages(data: unknown, fromDate?: string): IStatementUsageEvent[] {
    const usages = data && typeof data === 'object' ? (data as Record<string, unknown>).Usages : null;
    const out: IStatementUsageEvent[] = [];
    for (const raw of asArray(usages as Record<string, unknown>[] | undefined)) {
      const u = raw as { Characteristics?: Record<string, unknown> } & Record<string, unknown>;
      const c = u.Characteristics ?? {};
      if (u.type === 'income') continue;
      if (fromDate && typeof u.date === 'string' && u.date.slice(0, 10) < fromDate) continue;
      const category = classifyUsage(c);
      if (category === 'topups') continue;
      const amount = pickAmount(c) ?? pickAmount(u) ?? 0;
      const date = typeof u.date === 'string' && u.date.length >= 10 ? u.date.slice(0, 10) : null;
      out.push({ category, amount: Math.abs(amount), date });
    }
    return out;
  }

  /** Сумма расходов по выписке (без пополнений) — первичный источник
   *  charges_amount на номер (CheckCharges.remainedAmount = остаток по ЛС,
   *  для начислений не годится). fromDate — нижняя граница окна (YYYY-MM-DD). */
  sumStatementCharges(data: unknown, fromDate?: string): number {
    return this.parseStatementUsages(data, fromDate).reduce((sum, row) => sum + row.amount, 0);
  }

  /** Суммы расходов по выписке, сгруппированные по дню (YYYY-MM-DD → ₽) — для
   *  по-дневного хранения charges_amount. Строки без даты падают в fallbackDate
   *  (конец окна), чтобы не терять начисления. */
  sumStatementChargesByDay(data: unknown, fromDate: string, fallbackDate: string): Map<string, number> {
    const perDay = new Map<string, number>();
    for (const row of this.parseStatementUsages(data, fromDate)) {
      if (row.amount <= 0) continue;
      const day = row.date ?? fallbackDate;
      perDay.set(day, (perDay.get(day) ?? 0) + row.amount);
    }
    return perDay;
  }

  /**
   * Детальная выписка по использованию SIM (вкладка «Использование» карточки):
   * каждое событие Usages[] с датой, типом, описанием, объёмом и деньгами.
   * Схема подтверждена дампом probe 06.07.2026: date, amount, Characteristics
   * { networkEvent, factUnits, factUnitCode, direction, calledMsisdn, label }.
   */
  parseStatementUsageRows(data: unknown): IStatementUsageRow[] {
    const usages = data && typeof data === 'object' ? (data as Record<string, unknown>).Usages : null;
    const out: IStatementUsageRow[] = [];
    for (const raw of asArray(usages as Record<string, unknown>[] | undefined)) {
      const u = raw as { Characteristics?: Record<string, unknown> } & Record<string, unknown>;
      const c = u.Characteristics ?? {};
      // Платёж на ЛС («Регистрация платежа: Безналичный платёж…») дублируется в
      // выписке каждого номера контракта — расходом номера не является, отсекаем
      // (как в parseStatementUsages), иначе раздувает «Прочее»/«Итого» абонента.
      if (u.type === 'income') continue;
      const category = classifyUsage(c);
      if (category === 'topups') continue;
      const amount = pickAmount(c) ?? pickAmount(u) ?? 0;
      const factUnits = Number(c.factUnits);
      out.push({
        date: typeof u.date === 'string' ? u.date : null,
        category,
        label: typeof c.label === 'string' && c.label ? c.label : null,
        networkEvent: typeof c.networkEvent === 'string' ? c.networkEvent : null,
        direction: c.direction === 'I' ? 'in' : c.direction === 'O' ? 'out' : null,
        peer: typeof c.calledMsisdn === 'string' && c.calledMsisdn ? c.calledMsisdn : null,
        units: Number.isFinite(factUnits) ? factUnits : null,
        unitCode: typeof c.factUnitCode === 'string' ? c.factUnitCode : null,
        amount: Math.abs(amount),
      });
    }
    // Свежие сверху — как в выписке ЛК.
    out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return out;
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

  // Записи ручных загрузок файлов помечаются source_message_id с префиксом
  // 'upload:' (см. uploadDetalization) — только их и трогает отладочная очистка.
  // Записи API-синков (source_message_id IS NULL) и автозабора заявок не задеваются.

  /** Число CDR-записей, загруженных из файлов вручную. */
  async countUploadedCalls(): Promise<number> {
    const rows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mts_business_cdr WHERE source_message_id LIKE 'upload:%'`,
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }

  /** Удалить CDR-записи ручных загрузок (отладка). Возвращает число удалённых. */
  async deleteUploadedCalls(): Promise<number> {
    return execute(`DELETE FROM mts_business_cdr WHERE source_message_id LIKE 'upload:%'`);
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

  /**
   * Уже известные (встречавшиеся в CDR) свои номера конкретного аккаунта —
   * источник списка для ежедневного автообновления (mts-business-cdr-daily-
   * scheduler.service.ts). Новый номер сначала должен один раз попасть в CDR
   * (ручной бэкафилл/загрузка), дальше подхватывается автоматически.
   */
  async getKnownMsisdnsByAccount(accountId: string): Promise<string[]> {
    const rows = await query<{ msisdn_enc: string | null }>(
      `SELECT DISTINCT ON (msisdn_hash) msisdn_enc
         FROM mts_business_cdr
        WHERE account_id = $1 AND msisdn_hash IS NOT NULL`,
      [accountId],
    );
    const out: string[] = [];
    for (const r of rows) {
      const msisdn = encryptionService.decryptField(r.msisdn_enc);
      if (msisdn) out.push(msisdn);
    }
    return out;
  }

  /** Сводка по лицевым счетам за период: звонки/время/кол-во номеров на аккаунт.
   *  accountId — фильтр по конкретному ЛС (null/undefined = все ЛС). */
  async getAccountsSummary(from: string, to: string, accountId?: string | null): Promise<IAccountSummaryRow[]> {
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
          AND ($3::uuid IS NULL OR c.account_id = $3::uuid)
        GROUP BY c.account_id, a.label, a.account_number
        ORDER BY SUM(c.duration_sec) DESC NULLS LAST`,
      [from, to, accountId ?? null],
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
