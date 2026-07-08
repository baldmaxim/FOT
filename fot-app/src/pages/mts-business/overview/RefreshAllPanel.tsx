import { type FC, useMemo, useState } from 'react';
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

// Персист «Скрыть»: startedAt скрытого прогона в localStorage, чтобы карточка
// не возвращалась после рефреша/деплоя (новый прогон = новый startedAt → снова видна).
const DISMISSED_KEY = 'mts-refresh-all-dismissed-started-at';

const readDismissed = (): string | null => {
  try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
};

const writeDismissed = (startedAt: string): void => {
  try { localStorage.setItem(DISMISSED_KEY, startedAt); } catch { /* приватный режим/недоступно */ }
};

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
 * Кнопка «Обновить» (строка вкладок страницы): запуск фонового полного
 * обновления. Без accountId — все активные ЛС; с accountId (фильтр ЛС на
 * «Основном») — точечный прогон одного ЛС, подпись показывает какого.
 * Прогресс — в RefreshAllPanel на «Основном» (общий react-query кэш статуса).
 */
export const RefreshAllButton: FC<{ accountId?: string }> = ({ accountId }) => {
  const status = useMtsBusinessRefreshAllStatus();
  const start = useStartMtsBusinessRefreshAll();
  const accounts = useMtsBusinessAccounts();
  const [startError, setStartError] = useState<string | null>(null);
  const running = status.data?.running === true;
  useMtsBusinessRefreshAllCompletion(status.data?.running);

  const accountLabel = accountId ? accounts.data?.find(a => a.id === accountId)?.label : undefined;

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
      <button className={s.btn} onClick={() => { void onStart(); }} disabled={running || start.isPending}>
        {running || start.isPending
          ? <><span className={s.spinnerLight} /> Обновление…</>
          : accountLabel ? `Обновить ${accountLabel}` : 'Обновить'}
      </button>
    </span>
  );
};

/**
 * Панель прогресса фонового полного обновления. Состояние живёт на бэке
 * (переживает уход со страницы/рестарт): polling раз в 3с пока идёт прогон;
 * по завершении инвалидируются все запросы модуля.
 */
export const RefreshAllPanel: FC = () => {
  const status = useMtsBusinessRefreshAllStatus();
  const [dismissedStartedAt, setDismissedStartedAt] = useState<string | null>(() => readDismissed());

  const data = status.data;
  const running = data?.running === true;

  const multiAccount = useMemo(
    () => new Set((data?.steps ?? []).map(st => st.accountId)).size > 1,
    [data?.steps],
  );

  const showPanel = data != null
    && data.startedAt != null
    && (running || (data.finishedAt != null && dismissedStartedAt !== data.startedAt));

  return (
    <div className={s.wrap}>
      {showPanel && data && (
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span className={s.panelTitle}>
              {running ? 'Идёт полное обновление из МТС' : 'Последнее обновление из МТС'}
            </span>
            <span className={s.panelMeta}>
              {data.window ? `детализация ${data.window.dateFrom} — ${data.window.dateTo} · ` : ''}
              запущено {fmtLast(data.startedAt)}
            </span>
            {!running && (
              <button
                className={s.hideBtn}
                onClick={() => {
                  if (data.startedAt) { writeDismissed(data.startedAt); setDismissedStartedAt(data.startedAt); }
                }}
              >Скрыть</button>
            )}
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
        </div>
      )}
    </div>
  );
};
