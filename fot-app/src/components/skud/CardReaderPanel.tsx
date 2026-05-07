import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FC } from 'react';
import { useCardReader, type ICardEvent } from '../../hooks/useCardReader';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useToast } from '../../contexts/ToastContext';
import { employeeService } from '../../services/employeeService';
import {
  collectCardUids,
  sigurCardReaderService,
  type CardLookupResult,
  type ICardAssignResult,
  type ICardLookupDebug,
  type ISigurCardEmployee,
} from '../../services/sigurCardReaderService';
import { sigurAdminService } from '../../services/sigurAdminService';
import { ApiError } from '../../api/client';
import type { Employee } from '../../types';
import './CardReaderPanel.css';

export type CardReaderMode =
  | {
      kind: 'lookup';
      /** Найден сотрудник в ФОТ — переход на /employees/{id}. */
      onEmployeeFound?: (employeeId: number) => void;
      /** Найден sigurEmployeeId в Sigur (с FOT-сматчем или без) — открыть его inline (например, в SigurEmployeesTab). Приоритетнее onEmployeeFound, если задан. */
      onSigurEmployeeFound?: (sigurEmployeeId: number, fullName: string) => void;
    }
  | { kind: 'assign-to'; presetEmployeeId: number; presetEmployeeName: string; onAssigned: () => void }
  | { kind: 'assign-to-sigur'; presetSigurEmployeeId: number; presetEmployeeName: string; onAssigned: () => void };

interface ICardReaderPanelProps {
  mode: CardReaderMode;
  embedded?: boolean;
  onAssignSuccess?: (result: ICardAssignResult) => void;
}

const formatExpiry = (iso: string | null): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('ru-RU');
  } catch {
    return iso;
  }
};

const defaultExpirationISO = (): string => {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 5);
  return date.toISOString().slice(0, 10);
};

const UidPanel: FC<{ card: ICardEvent }> = ({ card }) => (
  <div className="scr-uid-panel">
    <div className="scr-uid-row">
      <span className="scr-uid-label">Sigur</span>
      <code className="scr-uid-value scr-uid-value--primary">{card.sigurCard || '—'}</code>
    </div>
    <div className="scr-uid-row">
      <span className="scr-uid-label">W26</span>
      <code className="scr-uid-value">{card.w26 || '—'}</code>
    </div>
    <div className="scr-uid-row">
      <span className="scr-uid-label">HEX</span>
      <code className="scr-uid-value">{card.hexUid || '—'}</code>
    </div>
    <div className="scr-uid-row">
      <span className="scr-uid-label">DEC</span>
      <code className="scr-uid-value">{card.decBe || '—'}</code>
    </div>
  </div>
);

const DebugBlock: FC<{ debug: ICardLookupDebug | undefined }> = ({ debug }) => {
  if (!debug) return null;
  return (
    <details className="scr-debug" open>
      <summary>Диагностика поиска</summary>
      <div className="scr-debug-section">
        <strong>Искали по:</strong>
        <ul>
          {debug.tried.map((t, i) => <li key={i}><code>{t}</code></li>)}
        </ul>
      </div>
      {debug.sampleCards.length > 0 && (
        <div className="scr-debug-section">
          <strong>Сырые поля первых карт Sigur:</strong>
          {debug.sampleCards.map((card, idx) => (
            <div key={idx} className="scr-debug-card">
              <div className="scr-debug-card-title">Карта #{idx + 1}</div>
              <table className="scr-debug-table">
                <tbody>
                  {Object.entries(card).map(([k, v]) => (
                    <tr key={k}>
                      <td className="scr-debug-key"><code>{k}</code></td>
                      <td className="scr-debug-val"><code>{v}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </details>
  );
};

export const CardReaderPanel: FC<ICardReaderPanelProps> = ({ mode, embedded, onAssignSuccess }) => {
  const { success, error: toastError } = useToast();
  const { connected, message, lastCard, cardSeq, clearLastCard } = useCardReader();

  const [lookupResult, setLookupResult] = useState<CardLookupResult | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearch = useDebouncedValue(searchTerm, 300);
  const [searchResults, setSearchResults] = useState<Employee[]>([]);
  const [searching, setSearching] = useState(false);

  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [expirationDate, setExpirationDate] = useState<string>(defaultExpirationISO());
  const [assigning, setAssigning] = useState(false);
  const [assignSuccess, setAssignSuccess] = useState(false);
  const [assignErrorDebug, setAssignErrorDebug] = useState<ICardLookupDebug | null>(null);

  const lookupSeqRef = useRef(0);
  const assignedCardRef = useRef<string | null>(null);

  const isAssignTo = mode.kind === 'assign-to' || mode.kind === 'assign-to-sigur';

  const resetForNewCard = useCallback(() => {
    setLookupResult(null);
    setLookupError(null);
    setAssignSuccess(false);
    setAssignErrorDebug(null);
    setSelectedEmployee(null);
    setSearchTerm('');
    setSearchResults([]);
    if (!isAssignTo) {
      setExpirationDate(defaultExpirationISO());
    }
  }, [isAssignTo]);

  const runAutoAssign = useCallback(async (card: ICardEvent) => {
    if (mode.kind !== 'assign-to' && mode.kind !== 'assign-to-sigur') return;
    if (assignedCardRef.current === card.sigurCard) return;
    assignedCardRef.current = card.sigurCard;
    setAssigning(true);
    setLookupError(null);
    setAssignErrorDebug(null);
    try {
      const expIso = expirationDate ? new Date(expirationDate + 'T23:59:59').toISOString() : undefined;
      const uids = collectCardUids(card);

      if (mode.kind === 'assign-to-sigur') {
        const result = await sigurAdminService.assignEmployeeCardBinding(mode.presetSigurEmployeeId, {
          uid: card.sigurCard,
          uids,
          expirationDate: expIso,
        });
        const reassignNote = result.previousSigurEmployeeId
          ? ` (переоформлено с sigurEmployeeId ${result.previousSigurEmployeeId})`
          : '';
        success(`Пропуск привязан: ${mode.presetEmployeeName}${reassignNote}`);
        setAssignSuccess(true);
        mode.onAssigned();
        return;
      }

      const result = await sigurCardReaderService.assign({
        uid: card.sigurCard,
        uids,
        employeeId: mode.presetEmployeeId,
        expirationDate: expIso,
      });
      const reassignNote = result.previousSigurEmployeeId
        ? ` (переоформлено с sigurEmployeeId ${result.previousSigurEmployeeId})`
        : '';
      success(`Пропуск привязан: ${mode.presetEmployeeName}${reassignNote}`);
      setAssignSuccess(true);
      onAssignSuccess?.(result);
      mode.onAssigned();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Не удалось привязать карту';
      setLookupError(msg);
      if (err instanceof ApiError && err.details && typeof err.details === 'object') {
        const dbg = (err.details as Record<string, unknown>).debug;
        if (dbg && typeof dbg === 'object') {
          setAssignErrorDebug(dbg as ICardLookupDebug);
        }
      }
      assignedCardRef.current = null;
    } finally {
      setAssigning(false);
    }
  }, [mode, expirationDate, success, onAssignSuccess]);

  useEffect(() => {
    if (!lastCard || !lastCard.sigurCard) return;
    resetForNewCard();
    const seq = ++lookupSeqRef.current;
    setLookupLoading(true);

    sigurCardReaderService
      .lookup(lastCard)
      .then(result => {
        if (seq !== lookupSeqRef.current) return;
        setLookupResult(result);
        if (mode.kind === 'assign-to' || mode.kind === 'assign-to-sigur') {
          void runAutoAssign(lastCard);
          return;
        }
        // mode === 'lookup' и сотрудник найден — авто-открытие через 800ms (чтобы пользователь увидел кого нашли).
        if (mode.kind === 'lookup' && result.found && result.sigurEmployeeId) {
          const sigurId = result.sigurEmployeeId;
          const fullName = result.employee?.full_name || `Сотрудник Sigur #${sigurId}`;
          const fotId = result.employee?.source === 'fot' ? result.employee.id : null;
          setTimeout(() => {
            if (seq !== lookupSeqRef.current) return;
            // Приоритет: inline-открытие в SigurEmployeesTab, иначе переход на /employees/{id}.
            if (mode.onSigurEmployeeFound) {
              mode.onSigurEmployeeFound(sigurId, fullName);
            } else if (fotId != null && mode.onEmployeeFound) {
              mode.onEmployeeFound(fotId);
            }
          }, 800);
        }
      })
      .catch((err: unknown) => {
        if (seq !== lookupSeqRef.current) return;
        const msg = err instanceof Error ? err.message : 'Ошибка обращения к Sigur';
        setLookupError(msg);
      })
      .finally(() => {
        if (seq !== lookupSeqRef.current) return;
        setLookupLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardSeq]);

  useEffect(() => {
    if (isAssignTo) return;
    if (lookupResult?.found) return;
    const query = debouncedSearch.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    employeeService
      .getPaginated({ page: 1, pageSize: 8, search: query, status: 'active' })
      .then(res => {
        if (cancelled) return;
        setSearchResults(res.data);
      })
      .catch(() => {
        if (cancelled) return;
        setSearchResults([]);
      })
      .finally(() => {
        if (cancelled) return;
        setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, lookupResult, isAssignTo]);

  const handleManualAssign = useCallback(async () => {
    if (!lastCard || !selectedEmployee || mode.kind !== 'lookup') return;
    setAssigning(true);
    try {
      const expIso = expirationDate ? new Date(expirationDate + 'T23:59:59').toISOString() : undefined;
      const uids = collectCardUids(lastCard);
      const result = await sigurCardReaderService.assign({
        uid: lastCard.sigurCard,
        uids,
        employeeId: selectedEmployee.id,
        expirationDate: expIso,
      });
      success(`Пропуск привязан: ${selectedEmployee.full_name}`);
      const employeeBrief: ISigurCardEmployee = {
        id: result.employeeId,
        full_name: selectedEmployee.full_name,
        position_name: selectedEmployee.position_name ?? null,
        department: selectedEmployee.department ?? null,
        tab_number: selectedEmployee.tab_number ?? null,
        sigur_employee_id: result.sigurEmployeeId,
        source: 'fot',
      };
      setLookupResult({
        found: true,
        uid: lastCard.sigurCard,
        card: result.card,
        sigurEmployeeId: result.sigurEmployeeId,
        employee: employeeBrief,
      });
      onAssignSuccess?.(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Не удалось привязать карту';
      toastError(msg);
    } finally {
      setAssigning(false);
    }
  }, [lastCard, selectedEmployee, expirationDate, mode, success, toastError, onAssignSuccess]);

  const handleClear = useCallback(() => {
    clearLastCard();
    resetForNewCard();
    assignedCardRef.current = null;
  }, [clearLastCard, resetForNewCard]);

  const statusClass = useMemo(() => connected ? 'scr-status scr-status--ok' : 'scr-status scr-status--off', [connected]);

  const statusBar = (
    <div className={statusClass}>
      <span className="scr-status-dot" />
      <span className="scr-status-text">{message}</span>
    </div>
  );

  return (
    <div className={`scr-panel ${embedded ? 'scr-panel--embedded' : ''}`}>
      {!embedded && (
        <div className="scr-panel-status-bar">{statusBar}</div>
      )}
      {embedded && <div className="scr-panel-status-bar scr-panel-status-bar--inline">{statusBar}</div>}

      {!connected && (
        <div className="scr-hint">
          Запустите приложение <strong>Sigur Reader EH</strong> на этом ПК. Если оно ещё не установлено —{' '}
          смотрите <a href="/docs/skud-card-reader.md" target="_blank" rel="noreferrer">инструкцию</a>.
        </div>
      )}

      {isAssignTo && (
        <div className="scr-assign-target">
          <div className="scr-assign-target-label">Сотрудник</div>
          <div className="scr-assign-target-name">
            {mode.kind === 'assign-to' || mode.kind === 'assign-to-sigur' ? mode.presetEmployeeName : ''}
          </div>
          <label className="scr-field scr-field--inline">
            <span>Срок действия</span>
            <input
              type="date"
              value={expirationDate}
              onChange={e => setExpirationDate(e.target.value)}
              disabled={assigning}
            />
          </label>
        </div>
      )}

      <section className="scr-reader">
        {!lastCard ? (
          <div className={`scr-prompt ${connected ? 'scr-prompt--ready' : 'scr-prompt--idle'}`}>
            <div className="scr-prompt-icon" aria-hidden>⌬</div>
            <div className="scr-prompt-text">
              {connected ? 'Приложите карту к считывателю' : 'Ожидание подключения агента…'}
            </div>
          </div>
        ) : (
          <>
            <div className="scr-card-head">
              <h2 className="scr-card-title">Карта считана</h2>
              <button type="button" className="scr-clear-btn" onClick={handleClear}>
                Очистить
              </button>
            </div>
            <UidPanel card={lastCard} />
          </>
        )}
      </section>

      {lastCard && (
        <section className="scr-result">
          {lookupLoading && <div className="scr-loader">Поиск в Sigur…</div>}
          {assigning && <div className="scr-loader">Привязка…</div>}

          {lookupError && <div className="scr-error">{lookupError}</div>}

          {isAssignTo && assignErrorDebug && (
            <DebugBlock debug={assignErrorDebug} />
          )}

          {isAssignTo && assignSuccess && (
            <div className="scr-card scr-card--known">
              <div className="scr-card-row">
                <span className="scr-card-label">Готово</span>
                <span className="scr-card-name">Пропуск привязан</span>
              </div>
            </div>
          )}

          {!isAssignTo && !lookupLoading && lookupResult?.found && lookupResult.employee && (
            <div className={`scr-card scr-card--known ${lookupResult.employee.source === 'sigur' ? 'scr-card--sigur-only' : ''}`}>
              <div className="scr-card-row">
                <span className="scr-card-label">Сотрудник</span>
                <span className="scr-card-name">{lookupResult.employee.full_name}</span>
              </div>
              <div className="scr-card-row">
                <span className="scr-card-label">Должность</span>
                <span>{lookupResult.employee.position_name || '—'}</span>
              </div>
              <div className="scr-card-row">
                <span className="scr-card-label">Подразделение</span>
                <span>{lookupResult.employee.department || '—'}</span>
              </div>
              {lookupResult.employee.tab_number && (
                <div className="scr-card-row">
                  <span className="scr-card-label">Табельный №</span>
                  <span>{lookupResult.employee.tab_number}</span>
                </div>
              )}
              <div className="scr-card-row">
                <span className="scr-card-label">Срок карты</span>
                <span>{formatExpiry(lookupResult.card.expirationDate)}</span>
              </div>
              {lookupResult.employee.source === 'sigur' && (
                <div className="scr-source-note">
                  Данные из Sigur (sigurEmployeeId <strong>{lookupResult.sigurEmployeeId}</strong>) — этот сотрудник не сматчен с ФОТ.
                </div>
              )}
              {(lookupResult.employee.source === 'sigur' || (lookupResult.employee.source === 'fot' && lookupResult.employee.id != null)) && (
                <button
                  type="button"
                  className="scr-primary-btn"
                  onClick={() => {
                    if (mode.kind !== 'lookup' || !lookupResult.employee) return;
                    const sigurId = lookupResult.sigurEmployeeId;
                    if (mode.onSigurEmployeeFound && sigurId != null) {
                      mode.onSigurEmployeeFound(sigurId, lookupResult.employee.full_name);
                    } else if (mode.onEmployeeFound && lookupResult.employee.id != null) {
                      mode.onEmployeeFound(lookupResult.employee.id);
                    }
                  }}
                >
                  Открыть профиль
                </button>
              )}
              <DebugBlock debug={lookupResult.debug} />
            </div>
          )}

          {!isAssignTo && !lookupLoading && lookupResult?.found && !lookupResult.employee && (
            <div className="scr-card scr-card--orphan">
              <p>
                Карта привязана к сотруднику Sigur{lookupResult.sigurEmployeeId ? <> (id <strong>{lookupResult.sigurEmployeeId}</strong>)</> : ''},
                но получить его данные не удалось. Проверьте подключение к Sigur или сотрудника в Sigur Manager.
              </p>
              <DebugBlock debug={lookupResult.debug} />
            </div>
          )}

          {!isAssignTo && !lookupLoading && lookupResult && !lookupResult.found && (
            <div className="scr-card scr-card--assign">
              <div className="scr-assign-head">
                <h3>Карта не привязана</h3>
                <p>Найдите сотрудника и привяжите этот пропуск.</p>
              </div>

              <input
                type="search"
                className="scr-search-input"
                placeholder="ФИО или табельный номер"
                value={searchTerm}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setSelectedEmployee(null);
                }}
                autoFocus
              />

              {searching && <div className="scr-loader scr-loader--inline">Поиск…</div>}

              {!searching && searchResults.length > 0 && !selectedEmployee && (
                <ul className="scr-search-list">
                  {searchResults.map(emp => (
                    <li key={emp.id} className="scr-search-row">
                      <button
                        type="button"
                        className="scr-search-item"
                        onClick={() => {
                          if (mode.kind !== 'lookup') return;
                          if (mode.onSigurEmployeeFound && emp.sigur_employee_id) {
                            mode.onSigurEmployeeFound(emp.sigur_employee_id, emp.full_name);
                          } else if (mode.onEmployeeFound) {
                            mode.onEmployeeFound(emp.id);
                          }
                        }}
                        title="Открыть профиль сотрудника"
                      >
                        <span className="scr-search-name">{emp.full_name}</span>
                        <span className="scr-search-meta">
                          {[emp.position_name, emp.department].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="scr-search-attach"
                        onClick={() => setSelectedEmployee(emp)}
                        title="Привязать карту к этому сотруднику"
                      >
                        Привязать
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {!searching && debouncedSearch.trim().length >= 2 && searchResults.length === 0 && !selectedEmployee && (
                <div className="scr-empty">Никого не нашли</div>
              )}

              {selectedEmployee && (
                <div className="scr-selected">
                  <div className="scr-selected-row">
                    <span className="scr-selected-name">{selectedEmployee.full_name}</span>
                    <button
                      type="button"
                      className="scr-link-btn"
                      onClick={() => setSelectedEmployee(null)}
                    >
                      Сменить
                    </button>
                  </div>
                  <div className="scr-selected-meta">
                    {[selectedEmployee.position_name, selectedEmployee.department].filter(Boolean).join(' · ') || '—'}
                  </div>
                  <label className="scr-field">
                    <span>Срок действия</span>
                    <input
                      type="date"
                      value={expirationDate}
                      onChange={e => setExpirationDate(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="scr-primary-btn"
                    onClick={handleManualAssign}
                    disabled={assigning}
                  >
                    {assigning ? 'Привязка…' : 'Привязать пропуск'}
                  </button>
                </div>
              )}

              <DebugBlock debug={lookupResult.debug} />
            </div>
          )}
        </section>
      )}
    </div>
  );
};
