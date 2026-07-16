import { type FC, useState } from 'react';
import { useMtsBusinessSyncLogRuns, useMtsBusinessSyncLogEntries } from '../../../hooks/useMtsBusinessSyncLog';
import { mtsBusinessSyncLogService, type IMtsSyncLogEntry, type IMtsSyncRun } from '../../../services/mtsBusinessSyncLogService';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { fmtLast, fmtPhone } from '../mtsBusinessFormat';
import pageStyles from '../MtsBusinessPage.module.css';
import styles from './SyncLogSection.module.css';

// «Лог синхронизации»: история прогонов всех фоновых синков МТС (миграция 222).
// Клик по прогону раскрывает записи (ошибки по номерам, изменения ФИО и т.п.);
// каждую запись и все ошибки прогона можно скопировать — для отладки ночных сбоев.

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

const PAGE_SIZE = 20;

/** Диф из details: «Иванов → Петров» (ФИО/комментарий), иначе null. */
const entryDiff = (e: IMtsSyncLogEntry): string | null => {
  const d = e.details?.fio ?? e.details?.comment;
  return d ? `${d.old} → ${d.new}` : null;
};

/** Plain-текст записи для копирования (время | уровень | номер | шаг | код | сообщение). */
const entryText = (e: IMtsSyncLogEntry): string => [
  fmtLast(e.at),
  e.level,
  e.msisdn ?? '',
  e.step ?? '',
  e.errorCode ?? '',
  e.message + (entryDiff(e) ? `: ${entryDiff(e)}` : ''),
].filter(Boolean).join(' | ');

const CopyButton: FC<{ getText: () => string | Promise<string>; title: string; label?: string }> = ({ getText, title, label }) => {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const onCopy = async (): Promise<void> => {
    setBusy(true);
    try {
      await copyTextToClipboard(await getText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard недоступен (http/старый браузер) — молча, кнопка не критична
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={styles.copyBtn} title={title} disabled={busy} onClick={() => { void onCopy(); }}>
      {copied ? '✓ Скопировано' : busy ? '…' : (label ?? 'Копировать')}
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
      <CopyButton getText={() => entryText(entry)} title="Скопировать запись" label="⧉" />
    </div>
  );
};

/** Записи раскрытого прогона (грузятся лениво) + «скопировать все ошибки». */
const RunEntries: FC<{ runId: string; runHeader: string; runStatus?: string }> = ({ runId, runHeader, runStatus }) => {
  // У идущего прогона записи прибывают по мере обработки — подтягиваем каждые 15с.
  const entries = useMtsBusinessSyncLogEntries(runId, runStatus === 'running' ? 15_000 : false);
  const list = entries.data?.entries ?? [];
  const problems = list.filter(e => e.level !== 'info');
  const allText = (): string => [runHeader, ...list.map(entryText)].join('\n');
  const problemsText = (): string => [runHeader, ...problems.map(entryText)].join('\n');

  if (entries.isLoading) return <p className={pageStyles.hint}>Загрузка записей…</p>;
  if (entries.isError) return <p className={pageStyles.err}>Не удалось загрузить записи прогона</p>;
  if (list.length === 0) {
    return (
      <p className={pageStyles.hint}>
        {runStatus === 'running'
          ? 'Записей пока нет — прогон ещё идёт, ошибки и изменения данных появляются по мере обработки.'
          : runStatus === 'interrupted'
            ? 'Записей нет — прогон был прерван (рестарт сервера или деплой).'
            : runId === 'standalone'
              ? 'Ошибок конвейера нет.'
              : 'Записей нет — прогон прошёл без ошибок и изменений данных.'}
      </p>
    );
  }

  return (
    <div className={styles.entries}>
      <div className={styles.entriesToolbar}>
        <span className={pageStyles.hint}>
          Записей: {entries.data?.total ?? list.length}
          {(entries.data?.total ?? 0) > list.length && ` (показаны первые ${list.length})`}
        </span>
        {problems.length > 0 && (
          <CopyButton getText={problemsText} title="Скопировать все ошибки и предупреждения" label="Скопировать все ошибки" />
        )}
        <CopyButton getText={allText} title="Скопировать все записи прогона" label="Скопировать всё" />
      </div>
      {list.map(e => <EntryRow key={e.id} entry={e} />)}
    </div>
  );
};

const runHeaderText = (run: IMtsSyncRun): string => {
  const parts = [
    `${JOB_LABELS[run.job] ?? run.job} · ${run.initiator === 'schedule' ? 'авто' : 'вручную'}`,
    `${fmtLast(run.startedAt)} → ${fmtLast(run.finishedAt)}`,
    STATUS_LABELS[run.status] ?? run.status,
  ];
  if (run.summary) parts.push(run.summary);
  if (run.error) parts.push(`Ошибка: ${run.error}`);
  return parts.join(' | ');
};

export const SyncLogSection: FC = () => {
  const [job, setJob] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const runs = useMtsBusinessSyncLogRuns(
    { limit, offset: 0, job: job || undefined, onlyProblems: onlyProblems || undefined },
    true,
  );
  const list = runs.data?.runs ?? [];
  const total = runs.data?.total ?? 0;

  // Весь видимый лог одним текстом: строка на прогон, у проблемных прогонов —
  // их записи (подгружаются на клик), в конце — ошибки rolling-конвейера.
  const copyWholeLog = async (): Promise<string> => {
    const problemRuns = list.filter(r => r.status !== 'ok');
    const [entriesByRun, standalone] = await Promise.all([
      Promise.all(problemRuns.map(async r => {
        try {
          const { entries } = await mtsBusinessSyncLogService.listEntries(r.id);
          return [r.id, entries] as const;
        } catch {
          return [r.id, null] as const;
        }
      })).then(pairs => new Map(pairs)),
      mtsBusinessSyncLogService.listEntries('standalone').catch(() => null),
    ]);
    const lines: string[] = [];
    for (const run of list) {
      lines.push(runHeaderText(run));
      const entries = entriesByRun.get(run.id);
      if (entries === null) lines.push('  (записи не загрузились)');
      for (const e of entries ?? []) lines.push(`  ${entryText(e)}`);
    }
    if (standalone && standalone.entries.length > 0) {
      lines.push('Конвейер выписки — ошибки вне прогонов:');
      for (const e of standalone.entries) lines.push(`  ${entryText(e)}`);
    }
    return lines.join('\n') || 'Лог пуст';
  };

  return (
    <>
      <div className={styles.filters}>
        <select
          className={`${pageStyles.select} ${pageStyles.selectSm}`}
          value={job}
          onChange={e => { setJob(e.target.value); setLimit(PAGE_SIZE); setExpandedId(null); }}
        >
          <option value="">Все синхронизации</option>
          {Object.entries(JOB_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <label className={pageStyles.checkField}>
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={e => { setOnlyProblems(e.target.checked); setLimit(PAGE_SIZE); setExpandedId(null); }}
          />
          Только с ошибками
        </label>
        <button
          type="button"
          className={styles.rollingLink}
          onClick={() => setExpandedId(prev => (prev === 'standalone' ? null : 'standalone'))}
        >
          {expandedId === 'standalone' ? 'Скрыть ошибки конвейера' : 'Ошибки конвейера (вне прогонов)'}
        </button>
        {list.length > 0 && (
          <CopyButton
            getText={copyWholeLog}
            title="Скопировать весь видимый лог: прогоны + записи проблемных прогонов + ошибки конвейера"
            label="Скопировать лог"
          />
        )}
      </div>

      {expandedId === 'standalone' && (
        <div className={styles.runBox}>
          <RunEntries runId="standalone" runHeader="Конвейер выписки — ошибки вне прогонов" />
        </div>
      )}

      {runs.isLoading && <p className={pageStyles.hint}>Загрузка лога…</p>}
      {runs.isError && <p className={pageStyles.err}>Не удалось загрузить лог синхронизации</p>}
      {!runs.isLoading && !runs.isError && list.length === 0 && (
        <p className={pageStyles.hint}>Прогонов ещё не было — лог наполняется ночными и ручными синхронизациями.</p>
      )}

      {list.map(run => {
        const expanded = expandedId === run.id;
        return (
          <div key={run.id} className={styles.runBox}>
            <button
              type="button"
              className={styles.runRow}
              onClick={() => setExpandedId(expanded ? null : run.id)}
              aria-expanded={expanded}
            >
              <span className={styles.runChevron}>{expanded ? '▾' : '▸'}</span>
              <span className={styles.runTitle}>
                {JOB_LABELS[run.job] ?? run.job}
                <span className={styles.runInitiator}>{run.initiator === 'schedule' ? 'авто' : 'вручную'}</span>
              </span>
              <span className={styles.runMeta}>
                {fmtLast(run.startedAt)}
                <span className={`${pageStyles.badge} ${statusBadgeClass(run.status)}`}>
                  {STATUS_LABELS[run.status] ?? run.status}
                </span>
              </span>
            </button>
            {(run.summary || run.error) && (
              <div className={styles.runSummary}>
                {run.error ? <span className={pageStyles.err}>{run.error}</span> : run.summary}
              </div>
            )}
            {expanded && <RunEntries runId={run.id} runHeader={runHeaderText(run)} runStatus={run.status} />}
          </div>
        );
      })}

      {list.length < total && (
        <button
          type="button"
          className={pageStyles.btn}
          style={{ marginTop: 8 }}
          onClick={() => setLimit(l => Math.min(l + PAGE_SIZE, 100))}
          disabled={runs.isFetching || limit >= 100}
        >
          {limit >= 100 ? 'Показаны первые 100' : `Показать ещё (всего: ${total})`}
        </button>
      )}
    </>
  );
};
