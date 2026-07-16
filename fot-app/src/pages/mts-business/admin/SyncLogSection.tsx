import { type FC, useMemo, useState } from 'react';
import { useMtsBusinessSyncLogRuns, useMtsBusinessSyncLogFeed } from '../../../hooks/useMtsBusinessSyncLog';
import { type IMtsSyncLogEntry, type IMtsSyncRun } from '../../../services/mtsBusinessSyncLogService';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { fmtLast, fmtPhone } from '../mtsBusinessFormat';
import pageStyles from '../MtsBusinessPage.module.css';
import styles from './SyncLogSection.module.css';

// «Лог синхронизации» — единая лента без фильтров и раскрытий: строки прогонов
// (старт/итог) и все записи (ошибки по номерам, изменения ФИО/комментариев,
// персданные) вперемешку по времени, свежие сверху. Кнопка «Скопировать лог»
// кладёт видимую ленту plain-текстом — чтобы кидать в чат для отладки.

// «refresh_all» — это кнопка «Обновить» на вкладке «Основное» (полный прогон).
const JOB_LABELS: Record<string, string> = {
  refresh_all: 'Обновить (полный прогон)',
  cdr_daily: 'Детализация (ночная)',
  metrics_daily: 'Финансы (ночные)',
  catalog_weekly: 'Каталог (еженедельный)',
  rolling: 'Конвейер выписки',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'выполняется',
  ok: 'ок',
  partial: 'частично',
  error: 'ошибка',
  interrupted: 'прерван',
};

const statusBadgeClass = (status: string): string => {
  if (status === 'ok') return pageStyles.badgeOk;
  if (status === 'partial' || status === 'running') return pageStyles.badgeWait;
  return pageStyles.badgeErr;
};

const FEED_PAGE = 150;
const FEED_MAX = 500;

/** Диф из details: «Иванов → Петров» (ФИО/комментарий), иначе null. */
const entryDiff = (e: IMtsSyncLogEntry): string | null => {
  const d = e.details?.fio ?? e.details?.comment;
  return d ? `${d.old} → ${d.new}` : null;
};

/** Plain-текст записи для копирования. */
const entryText = (e: IMtsSyncLogEntry): string => [
  fmtLast(e.at),
  JOB_LABELS[e.job] ?? e.job,
  e.level,
  e.msisdn ?? '',
  e.step ?? '',
  e.errorCode ?? '',
  e.message + (entryDiff(e) ? `: ${entryDiff(e)}` : ''),
].filter(Boolean).join(' | ');

const runText = (r: IMtsSyncRun): string => [
  fmtLast(r.startedAt),
  `${JOB_LABELS[r.job] ?? r.job} (${r.initiator === 'schedule' ? 'авто' : 'вручную'})`,
  STATUS_LABELS[r.status] ?? r.status,
  r.summary ?? '',
  r.error ? `Ошибка: ${r.error}` : '',
].filter(Boolean).join(' | ');

type FeedItem = { at: string; run?: IMtsSyncRun; entry?: IMtsSyncLogEntry };

const CopyButton: FC<{ getText: () => string }> = ({ getText }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    try {
      await copyTextToClipboard(getText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard недоступен (http/старый браузер) — молча, кнопка не критична
    }
  };
  return (
    <button type="button" className={pageStyles.btn} onClick={() => { void onCopy(); }}>
      {copied ? '✓ Скопировано' : 'Скопировать лог'}
    </button>
  );
};

const EntryRow: FC<{ entry: IMtsSyncLogEntry }> = ({ entry }) => {
  const diff = entryDiff(entry);
  return (
    <div className={`${styles.entryRow} ${entry.level === 'error' ? styles.entryErr : entry.level === 'warn' ? styles.entryWarn : ''}`}>
      <span className={styles.entryTime}>{fmtLast(entry.at)}</span>
      <span className={styles.entryLevel}>{entry.level === 'error' ? 'ошибка' : entry.level === 'warn' ? 'внимание' : 'инфо'}</span>
      <span className={styles.entryBody}>
        {entry.msisdn && <span className={styles.entryMsisdn}>{fmtPhone(entry.msisdn)}</span>}
        {entry.errorCode && <span className={styles.entryCode}>{entry.errorCode}</span>}
        <span>{entry.message}{diff && <>: <b>{diff}</b></>}</span>
      </span>
    </div>
  );
};

const RunRow: FC<{ run: IMtsSyncRun }> = ({ run }) => (
  <div className={styles.feedRunRow}>
    <span className={styles.entryTime}>{fmtLast(run.startedAt)}</span>
    <span className={styles.feedRunTitle}>
      {JOB_LABELS[run.job] ?? run.job}
      <span className={styles.runInitiator}>{run.initiator === 'schedule' ? 'авто' : 'вручную'}</span>
    </span>
    <span className={`${pageStyles.badge} ${statusBadgeClass(run.status)}`}>
      {STATUS_LABELS[run.status] ?? run.status}
    </span>
    {(run.error || run.summary) && (
      <span className={run.error ? styles.feedRunError : styles.feedRunSummary}>
        {run.error ?? run.summary}
      </span>
    )}
  </div>
);

export const SyncLogSection: FC = () => {
  const [limit, setLimit] = useState(FEED_PAGE);
  const runs = useMtsBusinessSyncLogRuns({ limit: 100, offset: 0 }, true);
  const feed = useMtsBusinessSyncLogFeed(limit);

  // Лента: строки прогонов и записи вперемешку, по времени, свежие сверху.
  const items = useMemo<FeedItem[]>(() => {
    const out: FeedItem[] = [
      ...(runs.data?.runs ?? []).map(run => ({ at: run.startedAt, run })),
      ...(feed.data?.entries ?? []).map(entry => ({ at: entry.at, entry })),
    ];
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [runs.data, feed.data]);

  const copyAll = (): string =>
    items.map(i => (i.run ? runText(i.run) : entryText(i.entry as IMtsSyncLogEntry))).join('\n') || 'Лог пуст';

  const totalEntries = feed.data?.total ?? 0;
  const loadedEntries = feed.data?.entries.length ?? 0;

  return (
    <>
      <div className={styles.toolbar}>
        <span className={pageStyles.hint}>
          {feed.isLoading || runs.isLoading
            ? 'Загрузка лога…'
            : `Записей: ${totalEntries}${totalEntries > loadedEntries ? ` (показаны последние ${loadedEntries})` : ''}`}
        </span>
        {items.length > 0 && <CopyButton getText={copyAll} />}
      </div>

      {(feed.isError || runs.isError) && <p className={pageStyles.err}>Не удалось загрузить лог синхронизации</p>}
      {!feed.isLoading && !runs.isLoading && !feed.isError && !runs.isError && items.length === 0 && (
        <p className={pageStyles.hint}>Лог пуст — наполнится ближайшими синхронизациями (ручными и ночными).</p>
      )}

      <div className={styles.feed}>
        {items.map((i, idx) => (i.run
          ? <RunRow key={`run-${i.run.id}`} run={i.run} />
          : <EntryRow key={`e-${(i.entry as IMtsSyncLogEntry).id}-${idx}`} entry={i.entry as IMtsSyncLogEntry} />
        ))}
      </div>

      {loadedEntries < totalEntries && (
        <button
          type="button"
          className={pageStyles.btn}
          style={{ marginTop: 8 }}
          onClick={() => setLimit(l => Math.min(l + FEED_PAGE, FEED_MAX))}
          disabled={feed.isFetching || limit >= FEED_MAX}
        >
          {limit >= FEED_MAX ? `Показаны последние ${FEED_MAX}` : 'Показать ещё'}
        </button>
      )}
    </>
  );
};
