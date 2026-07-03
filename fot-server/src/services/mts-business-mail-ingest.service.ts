import * as Sentry from '@sentry/node';
import axios from 'axios';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { env } from '../config/env.js';
import { queryOne, execute } from '../config/postgres.js';
import { mtsBusinessCdrService } from './mts-business-cdr.service.js';
import { auditService, AUDIT_ACTIONS } from './audit.service.js';
import {
  tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease,
  getSigurRuntimeOwner,
} from './sigur-runtime-state.service.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

// IMAP-автозабор детализаций МТС «Бизнес». API отдаёт документ ТОЛЬКО на email
// (deliveryAddress), поэтому «онлайн»-конвейер достраивается почтовым плечом:
// заказ уходит на служебный ящик → поллер забирает непрочитанные письма →
// достаёт XML/XLS (вложение или ссылку на разрешённом хосте) → прогоняет через
// тот же parseFileAndStore, что и ручная загрузка. Письмо после обработки
// помечается прочитанным (в т.ч. при ошибке — защита от «ядовитых» писем;
// файл остаётся в ящике для ручной загрузки).
//
// Заявка матчится по UUID (messageId) в теме/теле/имени файла; при совпадении
// статус заявки → completed. Ящик предполагается выделенным под детализации.
//
// Lease через sigur_runtime_state (общая инфраструктура), ключ
// 'mts_business_mail_ingest'. При нескольких инстансах PM2 поллит только один.

const LEASE_KEY = 'mts_business_mail_ingest';
const LEASE_TTL_SECONDS = 300;
const STARTUP_DELAY_MS = 60_000;
const MAX_MESSAGES_PER_TICK = 10;
// Сырое MIME-письмо: base64-вложение крупнее исходного файла на ~37% + заголовки.
const MAX_SOURCE_BYTES = 420 * 1024 * 1024;
const MAX_FILE_BYTES = 300 * 1024 * 1024; // как у multer в роутах модуля (реальный XML по ЛС — до 115 МБ)
const MAX_LINKS_PER_MESSAGE = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Реальный messageId ответа МТС — не UUID, а hex16_счётчик (пример c1ba2d26d5999fb4_1).
const MTS_MESSAGE_ID_RE = /[0-9a-f]{16}_\d+/gi;

/** Все UUID/messageId МТС из текста (нижний регистр, без дублей) — кандидаты в messageId заявки. */
export const extractUuids = (text: string): string[] => {
  const out: string[] = [];
  for (const re of [UUID_RE, MTS_MESSAGE_ID_RE]) {
    for (const m of text.matchAll(re)) {
      const v = m[0].toLowerCase();
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
};

/** Файл детализации по расширению (как диспетчер parseFile: xml/xls/xlsx). */
export const isIngestableFilename = (name: string | null | undefined): boolean =>
  /\.(xml|xls|xlsx)$/i.test((name || '').trim());

/** 'mts.ru, dokumenty.mts.ru' → ['mts.ru', 'dokumenty.mts.ru'] */
export const parseHostSuffixes = (raw: string): string[] =>
  raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/** Только https и хост из allow-list (сам суффикс или его поддомен). */
export const isAllowedLinkUrl = (rawUrl: string, suffixes: string[]): boolean => {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return suffixes.some(s => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
};

/** Ссылки на файл детализации из текста/HTML письма (разрешённые хосты). */
export const extractFileLinks = (text: string, suffixes: string[]): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(/https:\/\/[^\s"'<>()[\]]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (!isAllowedLinkUrl(url, suffixes)) continue;
    const lower = url.toLowerCase();
    const looksLikeFile = /\.(xml|xls|xlsx)([?#]|$)/.test(lower)
      || /(download|document|file|report|detal)/.test(lower);
    if (looksLikeFile && !out.includes(url)) out.push(url);
  }
  return out;
};

/** From содержит фильтр-подстроку (пустой фильтр — пропускаем всё). */
export const senderMatchesFilter = (fromAddress: string | null | undefined, filter: string): boolean => {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return (fromAddress || '').toLowerCase().includes(f);
};

/** Имя файла из Content-Disposition (filename= / filename*=UTF-8''). */
export const filenameFromContentDisposition = (header: string | null | undefined): string | null => {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* сырое значение ниже */ }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
};

/** Последний сегмент пути URL как имя файла. */
export const filenameFromUrl = (rawUrl: string): string | null => {
  try {
    const u = new URL(rawUrl);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const decoded = decodeURIComponent(seg);
    return decoded || null;
  } catch {
    return null;
  }
};

interface IIngestFile {
  filename: string;
  content: Buffer;
  origin: 'attachment' | 'link';
}

interface ITickStats {
  unseen: number;
  ingested: number;
  foreign: number;
  empty: number;
  failed: number;
  parsed: number;
  inserted: number;
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;

const isConfigured = (): boolean =>
  Boolean(env.MTS_BUSINESS_IMAP_HOST && env.MTS_BUSINESS_IMAP_USER && env.MTS_BUSINESS_IMAP_PASSWORD);

/** Скачивает файл по ссылке из письма (без редиректов — хост уже провалидирован). */
async function downloadLinkedFile(url: string): Promise<IIngestFile | null> {
  try {
    const resp = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: MAX_FILE_BYTES,
      validateStatus: s => s === 200,
    });
    const content = Buffer.from(resp.data);
    if (content.length === 0 || content.length > MAX_FILE_BYTES) return null;
    const contentType = String(resp.headers['content-type'] || '').toLowerCase();
    let filename = filenameFromContentDisposition(resp.headers['content-disposition'] as string | undefined)
      || filenameFromUrl(url);
    if (!isIngestableFilename(filename)) {
      if (contentType.includes('spreadsheet') || contentType.includes('excel')) filename = 'detalization.xlsx';
      else filename = 'detalization.xml';
    }
    return { filename: filename as string, content, origin: 'link' };
  } catch (error) {
    console.error(`[mts-biz-mail] link download failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  }
}

/** Ищет среди UUID письма messageId существующей заявки. */
async function matchRequestMessageId(blob: string): Promise<string | null> {
  const uuids = extractUuids(blob);
  if (uuids.length === 0) return null;
  const row = await queryOne<{ message_id: string }>(
    `SELECT message_id
       FROM mts_business_detalization_requests
      WHERE LOWER(message_id) = ANY($1::text[])
      LIMIT 1`,
    [uuids],
  );
  return row?.message_id ?? null;
}

/** Файлы детализации из письма: вложения, иначе ссылки на разрешённых хостах. */
async function collectFiles(mail: ParsedMail): Promise<IIngestFile[]> {
  const files: IIngestFile[] = [];
  for (const att of mail.attachments || []) {
    if (!isIngestableFilename(att.filename)) continue;
    if (!att.content || att.content.length === 0 || att.content.length > MAX_FILE_BYTES) continue;
    files.push({ filename: att.filename as string, content: att.content, origin: 'attachment' });
  }
  if (files.length > 0) return files;

  const suffixes = parseHostSuffixes(env.MTS_BUSINESS_MAIL_LINK_HOSTS);
  const blob = [mail.text || '', typeof mail.html === 'string' ? mail.html : ''].join('\n');
  const links = extractFileLinks(blob, suffixes).slice(0, MAX_LINKS_PER_MESSAGE);
  for (const link of links) {
    const file = await downloadLinkedFile(link);
    if (file) files.push(file);
  }
  return files;
}

async function processMessage(client: ImapFlow, uid: number, stats: ITickStats): Promise<void> {
  try {
    const msg = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
    if (!msg || !msg.source) { stats.failed++; return; }
    if (typeof msg.size === 'number' && msg.size > MAX_SOURCE_BYTES) {
      console.error(`[mts-biz-mail] uid=${uid}: письмо больше ${MAX_SOURCE_BYTES} байт — пропущено`);
      stats.failed++;
      return;
    }
    const mail = await simpleParser(msg.source);
    const fromAddress = mail.from?.value?.map(v => v.address).filter(Boolean).join(',')
      || mail.from?.text
      || '';

    if (!senderMatchesFilter(fromAddress, env.MTS_BUSINESS_MAIL_FROM_FILTER)) {
      stats.foreign++;
      return;
    }

    const files = await collectFiles(mail);
    if (files.length === 0) {
      stats.empty++;
      return;
    }

    const matchBlob = [mail.subject || '', mail.text || '', files.map(f => f.filename).join(' ')].join('\n');
    const sourceMessageId = await matchRequestMessageId(matchBlob);

    for (const file of files) {
      const result = await mtsBusinessCdrService.parseFileAndStore(
        file.content,
        file.filename,
        sourceMessageId,
        null,
      );
      stats.parsed += result.parsed;
      stats.inserted += result.inserted;
      await auditService.log({
        user_id: null,
        action: AUDIT_ACTIONS.MTS_BUSINESS_DETALIZATION_INGESTED,
        details: {
          from: fromAddress || null,
          fileName: file.filename,
          origin: file.origin,
          sourceMessageId,
          parsed: result.parsed,
          inserted: result.inserted,
          skipped: result.skipped,
        },
      });
    }

    if (sourceMessageId) {
      await execute(
        `UPDATE mts_business_detalization_requests
            SET status = 'completed', checked_at = NOW()
          WHERE message_id = $1`,
        [sourceMessageId],
      );
    }
    stats.ingested++;
  } catch (error) {
    stats.failed++;
    console.error(`[mts-biz-mail] uid=${uid} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'mail-ingest' } });
  } finally {
    // Прочитано в любом исходе: «ядовитое» письмо не должно зацикливать тик,
    // файл остаётся в ящике для ручной загрузки.
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(err =>
      console.error(`[mts-biz-mail] uid=${uid}: mark seen failed: ${(err as Error).message}`),
    );
  }
}

async function processMailbox(): Promise<ITickStats> {
  const stats: ITickStats = { unseen: 0, ingested: 0, foreign: 0, empty: 0, failed: 0, parsed: 0, inserted: 0 };
  const client = new ImapFlow({
    host: env.MTS_BUSINESS_IMAP_HOST as string,
    port: Number.parseInt(env.MTS_BUSINESS_IMAP_PORT, 10) || 993,
    secure: env.MTS_BUSINESS_IMAP_SECURE !== 'false',
    auth: { user: env.MTS_BUSINESS_IMAP_USER as string, pass: env.MTS_BUSINESS_IMAP_PASSWORD as string },
    logger: false,
  });
  // Без подписки неотловленный 'error' валит процесс (EventEmitter).
  client.on('error', err => console.error('[mts-biz-mail] imap error:', (err as Error).message));

  await client.connect();
  try {
    const lock = await client.getMailboxLock(env.MTS_BUSINESS_IMAP_MAILBOX);
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      const uids = Array.isArray(unseen) ? unseen : [];
      stats.unseen = uids.length;
      for (const uid of uids.slice(0, MAX_MESSAGES_PER_TICK)) {
        if (stopped) break;
        await processMessage(client, uid, stats);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
  return stats;
}

async function tick(owner: string): Promise<void> {
  if (!isConfigured()) return;

  const acq = await tryAcquireSigurRuntimeLease({
    key: LEASE_KEY,
    owner,
    ttlSeconds: LEASE_TTL_SECONDS,
    meta: { tickedAt: new Date().toISOString() },
  });
  if (!acq.acquired) return;

  const intervalMin = Math.max(1, Math.round((Number.parseInt(env.MTS_BUSINESS_MAIL_POLL_MS, 10) || 300_000) / 60_000));
  try {
    await runWithCronMonitor(
      'mts-business-mail-ingest',
      async () => {
        let cronStatus: CronRunStatus = 'ok';
        try {
          const s = await processMailbox();
          console.log(
            `[mts-biz-mail] tick: unseen=${s.unseen} ingested=${s.ingested} foreign=${s.foreign}`
            + ` empty=${s.empty} failed=${s.failed} parsed=${s.parsed} inserted=${s.inserted}`,
          );
        } catch (error) {
          cronStatus = 'error';
          console.error('[mts-biz-mail] tick failed:', error instanceof Error ? error.message : 'unknown');
          Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'mail-ingest' } });
        }
        return cronStatus;
      },
      {
        schedule: { type: 'interval', value: intervalMin, unit: 'minute' },
        checkinMargin: 5,
        maxRuntime: 10,
      },
    );
  } finally {
    await releaseSigurRuntimeLease({ key: LEASE_KEY, owner }).catch(err =>
      console.error('[mts-biz-mail] release lease failed:', (err as Error).message),
    );
  }
}

export function startMtsBusinessMailIngest(): void {
  if (timer) return;
  stopped = false;
  if (!isConfigured()) {
    console.log('[mts-biz-mail] IMAP не настроен (MTS_BUSINESS_IMAP_*) — автозабор выключен');
    return;
  }
  const intervalMs = Math.max(60_000, Number.parseInt(env.MTS_BUSINESS_MAIL_POLL_MS, 10) || 300_000);
  const owner = getSigurRuntimeOwner('mts_business_mail_ingest');

  console.log(`[mts-biz-mail] starting (interval=${Math.round(intervalMs / 1000)}s, owner=${owner})`);

  const run = (): void => {
    if (stopped) return;
    void tick(owner);
  };

  setTimeout(run, STARTUP_DELAY_MS);
  timer = setInterval(run, intervalMs);
}

export function stopMtsBusinessMailIngest(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
