import { type FC, useEffect, useRef, useState } from 'react';
import {
  useMtsBusinessRefreshAllStatus,
  useStartMtsBusinessRefreshAll,
  useMtsBusinessRefreshAllCompletion,
} from '../../../hooks/useMtsBusinessRefreshAll';
import { useMtsBusinessAccounts } from '../../../hooks/useMtsBusinessData';
import type { IMtsRefreshStep } from '../../../services/mtsBusinessRefreshService';
import { UnavailableNotice } from '../common/UnavailableNotice';
import { errText, fmtLast } from '../mtsBusinessFormat';
import s from './RefreshAllPanel.module.css';

const StepIcon: FC<{ status: IMtsRefreshStep['status'] }> = ({ status }) => {
  switch (status) {
    case 'running': return <span className={s.spinner} aria-label="выполняется" />;
    case 'ok': return <span className={s.iconOk}>✓</span>;
    case 'error': return <span className={s.iconErr}>✕</span>;
    case 'unavailable': return <span className={s.iconWarn}>!</span>;
    default: return <span className={s.iconPending}>·</span>;
  }
};

/**
 * Доля выполнения прогона по шагам: завершённые (ok/error/unavailable) — 1,
 * идущий — 0.5 (внутришагового прогресса бэк не отдаёт). 0..1.
 */
const refreshProgress = (steps: IMtsRefreshStep[]): number => {
  if (steps.length === 0) return 0;
  const done = steps.filter(st => st.status === 'ok' || st.status === 'error' || st.status === 'unavailable').length;
  const running = steps.filter(st => st.status === 'running').length;
  return Math.min(1, (done + running * 0.5) / steps.length);
};

/** Заполняющееся кольцо прогресса на кнопке (вместо неопределённого спиннера). */
const ProgressRing: FC<{ progress: number }> = ({ progress }) => {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <svg className={s.progressRing} viewBox="0 0 14 14" role="img" aria-label={`Выполнено ${Math.round(progress * 100)}%`}>
      <circle className={s.progressTrack} cx="7" cy="7" r={r} />
      <circle
        className={s.progressFill}
        cx="7"
        cy="7"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - progress)}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
};

/**
 * Кнопка «Обновить» (строка вкладок страницы): запуск фонового полного
 * обновления. Без accountId — все активные ЛС; с accountId (фильтр ЛС на
 * «Основном») — точечный прогон одного ЛС, подпись показывает какого.
 * Дата и статистика последнего прогона — в поповере значка «i» рядом.
 */
export const RefreshAllButton: FC<{ accountId?: string }> = ({ accountId }) => {
  const status = useMtsBusinessRefreshAllStatus();
  const start = useStartMtsBusinessRefreshAll();
  const accounts = useMtsBusinessAccounts();
  const [startError, setStartError] = useState<string | null>(null);
  const running = status.data?.running === true;
  useMtsBusinessRefreshAllCompletion(status.data?.running);

  const accountLabel = accountId ? accounts.data?.find(a => a.id === accountId)?.label : undefined;
  const progress = running ? refreshProgress(status.data?.steps ?? []) : 0;
  const progressPct = Math.round(progress * 100);

  const onStart = async (): Promise<void> => {
    setStartError(null);
    try {
      await start.mutateAsync(accountId ? { accountId } : {});
    } catch (e) {
      setStartError(errText(e, 'Не удалось запустить (возможно нужен 2FA)'));
    }
  };

  return (
    <span className={s.controls}>
      {startError && <span className={s.err}>{startError}</span>}
      <RefreshAllInfo />
      <button
        className={s.btn}
        onClick={() => { void onStart(); }}
        disabled={running || start.isPending}
        title={running ? `Обновление: ${progressPct}%` : undefined}
      >
        {running
          ? <><ProgressRing progress={progress} /> Обновление…</>
          : start.isPending
            ? <><span className={s.spinnerLight} /> Обновление…</>
            : accountLabel ? `Обновить ${accountLabel}` : 'Обновить'}
      </button>
    </span>
  );
};

/**
 * Значок «i» рядом с кнопкой: поповер с последним/текущим прогоном «Обновить
 * всё» — когда запущен/завершён, окно детализации и статус каждого шага.
 * Пока прогон идёт, статус обновляется живьём (общий polling-кэш раз в 3с).
 */
const RefreshAllInfo: FC = () => {
  const status = useMtsBusinessRefreshAllStatus();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Закрытие по клику вне поповера и по Esc (это поповер, не модалка с overlay).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const data = status.data;
  const running = data?.running === true;
  const hasRun = data?.startedAt != null;
  const multiAccount = new Set((data?.steps ?? []).map(st => st.accountId)).size > 1;

  return (
    <span className={s.infoWrap} ref={wrapRef}>
      <button
        className={`${s.infoBtn} ${open ? s.infoBtnActive : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-label="Последнее обновление из МТС"
        title="Последнее обновление из МТС"
      >
        i
      </button>
      {open && (
        <div className={s.popover}>
          {!hasRun || !data ? (
            <p className={s.popoverEmpty}>Обновление ещё не запускалось.</p>
          ) : (
            <>
              <div className={s.panelHead}>
                <span className={s.panelTitle}>
                  {running ? 'Идёт полное обновление из МТС' : 'Последнее обновление из МТС'}
                </span>
              </div>
              <div className={s.panelMeta}>
                {data.window ? `детализация ${data.window.dateFrom} — ${data.window.dateTo} · ` : ''}
                запущено {fmtLast(data.startedAt)}
                {!running && data.finishedAt ? ` · завершено ${fmtLast(data.finishedAt)}` : ''}
              </div>
              {data.error && <p className={s.err}>{data.error}</p>}
              <div className={s.steps}>
                {data.steps.map(st => (
                  <div key={`${st.accountId}-${st.step}`} className={s.stepRow}>
                    <StepIcon status={st.status} />
                    <span className={s.stepLabel}>
                      {multiAccount ? `${st.accountLabel} · ` : ''}{st.label}
                    </span>
                    <span className={s.stepMeta}>
                      {st.status === 'unavailable'
                        ? <UnavailableNotice compact message={st.message ?? undefined} />
                        : [st.count != null && st.status === 'ok' ? String(st.count) : null, st.message]
                            .filter(Boolean).join(' · ') || null}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
};
