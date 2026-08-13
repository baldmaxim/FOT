/**
 * Модалка массового ПРОДЛЕНИЯ срока действия карт выбранным сотрудникам Sigur.
 *
 * Сначала предпросмотр под выбранную дату (что продлим, что пропустим и почему),
 * затем запись с SSE-прогрессом. Сервер выполняет операцию по подписанному
 * previewToken — то, что пользователь видел, и то, что будет записано, совпадает.
 *
 * Срок никогда не сокращается: карты со сроком больше выбранной даты и бессрочные
 * попадают в пропуски. Истёкшие продлеваются только после явного подтверждения —
 * среди них могут быть намеренно погашенные пропуска.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { FC } from 'react';
import { sigurAdminService } from '../../../services/sigurAdminService';
import type {
  BulkExtendCardsPreview,
  BulkExtendCardsProgressEvent,
  BulkExtendCardsResult,
} from '../../../services/sigurAdminService';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { ProgressBar } from '../../ui/ProgressBar';
import type { SigurConnectionScope } from '../../../types';
import styles from './BulkExtendCardsModal.module.css';

interface IBulkExtendCardsModalProps {
  employeeIds: number[];
  connection?: SigurConnectionScope;
  onClose: () => void;
  onApplied: () => void;
}

interface IProgressState {
  processed: number;
  total: number;
  failed: number;
}

/** Завтрашняя дата по МСК: сервер требует строго будущую дату в этой же зоне. */
const moscowTomorrowIso = (): string => {
  const moscowToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const [year, month, day] = moscowToday.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
};

const REASON_LABELS: Record<string, string> = {
  already_longer: 'Уже действуют дольше',
  no_expiration: 'Бессрочные',
  no_start_date: 'Без даты начала (Sigur не даёт продлить)',
  start_after_target: 'Дата начала позже выбранной',
  expired_not_confirmed: 'Истёкшие (без подтверждения)',
  changed_since_snapshot: 'Изменились во время операции',
  not_in_preview: 'Появились после предпросмотра',
  invalid_card_id: 'Некорректная привязка карты',
  invalid_start_date: 'Некорректная дата начала',
  invalid_expiration_date: 'Некорректный текущий срок',
  duplicate_binding: 'Дублирующая привязка',
  conflicting_duplicate_binding: 'Конфликтующая привязка',
};

export const BulkExtendCardsModal: FC<IBulkExtendCardsModalProps> = ({
  employeeIds,
  connection,
  onClose,
  onApplied,
}) => {
  const minDate = useMemo(() => moscowTomorrowIso(), []);
  const [expirationDate, setExpirationDate] = useState('');
  const [confirmExpired, setConfirmExpired] = useState(false);
  const [preview, setPreview] = useState<BulkExtendCardsPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<IProgressState | null>(null);
  const [result, setResult] = useState<BulkExtendCardsResult | null>(null);
  const [error, setError] = useState('');

  const dismissGuard = saving ? () => undefined : onClose;
  const overlayHandlers = useOverlayDismiss(dismissGuard);

  // Предпросмотр считается под конкретную дату: без неё нельзя понять, какие
  // карты уже действуют дольше, а какие Sigur вообще не даст тронуть.
  useEffect(() => {
    if (!expirationDate || expirationDate < minDate) {
      setPreview(null);
      setPreviewError('');
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError('');
      sigurAdminService.previewBulkExtendCards(employeeIds, expirationDate, connection)
        .then(data => {
          if (cancelled) return;
          setPreview(data);
          if (data.expiredCards === 0) setConfirmExpired(false);
        })
        .catch(err => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(err instanceof Error ? err.message : 'Не удалось рассчитать предпросмотр');
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [employeeIds, expirationDate, connection, minDate]);

  const activeCards = preview ? preview.willExtendCards - preview.expiredCards : 0;
  const plannedCards = preview ? (confirmExpired ? preview.willExtendCards : activeCards) : 0;
  const canSubmit = !!preview && !previewLoading && !previewError && plannedCards > 0 && !saving;

  const handleSubmit = async () => {
    if (!canSubmit || !preview) return;
    setSaving(true);
    setError('');
    setProgress({ processed: 0, total: employeeIds.length, failed: 0 });

    try {
      const onProgress = (event: BulkExtendCardsProgressEvent) => {
        if (event.type === 'progress') {
          setProgress(prev => ({
            processed: event.processed,
            total: event.total,
            failed: (prev?.failed ?? 0) + event.failedCards,
          }));
        }
      };
      const res = await sigurAdminService.bulkExtendCardsStream(
        { previewToken: preview.previewToken, confirmExpired },
        onProgress,
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось продлить карты');
    } finally {
      setSaving(false);
    }
  };

  const handleDone = () => {
    if (result) onApplied();
    onClose();
  };

  const renderPreview = () => {
    if (previewLoading) return <div className={styles.loading}>Считаем, что изменится…</div>;
    if (previewError) return <div className={styles.error}>{previewError}</div>;
    if (!preview) return <div className={styles.loading}>Выберите дату окончания</div>;

    return (
      <>
        <div className={styles.stats}>
          <span className={`${styles.statLabel} ${styles.statMain}`}>Будет продлено карт</span>
          <span className={`${styles.statValue} ${styles.statMain}`}>{plannedCards}</span>
          {preview.expiredCards > 0 && (
            <Fragment key="expired">
              <span className={styles.statLabel}>Из них истёкших</span>
              <span className={styles.statValue}>{confirmExpired ? preview.expiredCards : 0}</span>
            </Fragment>
          )}
          {Object.entries(preview.byReason).map(([reason, count]) => (
            <Fragment key={reason}>
              <span className={styles.statLabel}>{REASON_LABELS[reason] || reason}</span>
              <span className={styles.statValue}>{count}</span>
            </Fragment>
          ))}
          {preview.noCardEmployees > 0 && (
            <Fragment key="no-card">
              <span className={styles.statLabel}>Сотрудников без карты</span>
              <span className={styles.statValue}>{preview.noCardEmployees}</span>
            </Fragment>
          )}
          {preview.unreadableEmployees > 0 && (
            <Fragment key="unreadable">
              <span className={styles.statLabel}>Не удалось прочитать карты</span>
              <span className={styles.statValue}>{preview.unreadableEmployees}</span>
            </Fragment>
          )}
        </div>

        {preview.expiredCards > 0 && (
          <div className={styles.expiredBox}>
            <label className={styles.expiredToggle}>
              <input
                type="checkbox"
                checked={confirmExpired}
                onChange={event => setConfirmExpired(event.target.checked)}
                disabled={saving}
              />
              <span>{`Продлить и истёкшие карты (${preview.expiredCards})`}</span>
            </label>
            <div className={styles.expiredHint}>
              Среди истёкших могут быть намеренно погашенные пропуска — продление вернёт их в строй.
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="ep-modal-overlay" {...overlayHandlers}>
      <div className="ep-modal" onClick={event => event.stopPropagation()}>
        <div className="ep-modal-header">
          <div className="ep-modal-heading">
            <div className="ep-modal-title">
              {`Продлить карты — ${employeeIds.length} сотр.`}
            </div>
          </div>
        </div>

        <div className="ep-modal-body">
          {result ? (
            <div className={styles.summary}>
              <div>Продлено карт: <b>{result.updatedCards}</b> у <b>{result.updatedEmployees}</b> сотр.</div>
              {result.expiredExtendedCards > 0 && (
                <div>Из них истёкших: <b>{result.expiredExtendedCards}</b></div>
              )}
              {result.unknownCards > 0 && (
                <div className={styles.attention}>
                  Результат не подтверждён: <b>{result.unknownCards}</b> — проверьте карточки вручную
                </div>
              )}
              {result.changedDuringWriteCards > 0 && (
                <div className={styles.attention}>
                  Изменены параллельно: <b>{result.changedDuringWriteCards}</b>
                </div>
              )}
              <div>Пропущено карт: <b>{result.skippedCards}</b></div>
              {result.failedCards > 0 && <div>Ошибок: <b>{result.failedCards}</b></div>}
              {result.localUpdatedPasses > 0 && (
                <div>Обновлено пропусков подрядчиков: <b>{result.localUpdatedPasses}</b></div>
              )}
              {(result.localSyncFailedPasses > 0 || result.localUnknownPasses > 0) && (
                <div className={styles.attention}>
                  Пропуска без синхронизации: <b>{result.localSyncFailedPasses + result.localUnknownPasses}</b>
                </div>
              )}
              {result.warnings.length > 0 && (
                <ul className={styles.warnings}>
                  {result.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}
              <div className={styles.operationId}>{`ID операции: ${result.operationId}`}</div>
            </div>
          ) : (
            <>
              <div className={styles.dateRow}>
                <label htmlFor="bulk-extend-date">Действует до</label>
                <input
                  id="bulk-extend-date"
                  type="date"
                  value={expirationDate}
                  min={minDate}
                  onChange={event => setExpirationDate(event.target.value)}
                  disabled={saving}
                />
              </div>

              {renderPreview()}

              {saving && progress && (
                <ProgressBar
                  label={progress.failed > 0
                    ? `Продление карт (ошибок: ${progress.failed})`
                    : 'Продление карт'}
                  current={progress.processed}
                  total={progress.total}
                />
              )}

              {error && <div className={styles.error}>{error}</div>}
            </>
          )}
        </div>

        <div className="ep-modal-footer">
          {result ? (
            <button className="ep-modal-btn primary" onClick={handleDone}>
              Готово
            </button>
          ) : (
            <>
              <button className="ep-modal-btn secondary" onClick={onClose} disabled={saving}>
                Отмена
              </button>
              <button
                className="ep-modal-btn primary"
                onClick={handleSubmit}
                disabled={!canSubmit}
              >
                {saving ? 'Продление…' : 'Продлить'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
