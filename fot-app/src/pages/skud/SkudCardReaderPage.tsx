import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCardReader, type ICardEvent } from '../../hooks/useCardReader';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useToast } from '../../contexts/ToastContext';
import { employeeService } from '../../services/employeeService';
import {
  sigurCardReaderService,
  type CardLookupResult,
  type ISigurCardEmployee,
} from '../../services/sigurCardReaderService';
import type { Employee } from '../../types';
import '../../styles/SkudCardReaderPage.css';

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

interface IUidPanelProps {
  card: ICardEvent;
}

const UidPanel: FC<IUidPanelProps> = ({ card }) => (
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

export const SkudCardReaderPage: FC = () => {
  const navigate = useNavigate();
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

  const lookupSeqRef = useRef(0);

  const resetForNewCard = useCallback(() => {
    setLookupResult(null);
    setLookupError(null);
    setSelectedEmployee(null);
    setSearchTerm('');
    setSearchResults([]);
    setExpirationDate(defaultExpirationISO());
  }, []);

  useEffect(() => {
    if (!lastCard || !lastCard.sigurCard) return;
    resetForNewCard();
    const seq = ++lookupSeqRef.current;
    setLookupLoading(true);

    sigurCardReaderService
      .lookup(lastCard.sigurCard)
      .then(result => {
        if (seq !== lookupSeqRef.current) return;
        setLookupResult(result);
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
  }, [cardSeq, lastCard, resetForNewCard]);

  useEffect(() => {
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
  }, [debouncedSearch, lookupResult]);

  const handleAssign = useCallback(async () => {
    if (!lastCard || !selectedEmployee) return;
    setAssigning(true);
    try {
      const expIso = expirationDate ? new Date(expirationDate + 'T23:59:59').toISOString() : undefined;
      const result = await sigurCardReaderService.assign({
        uid: lastCard.sigurCard,
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
      };
      setLookupResult({
        found: true,
        uid: lastCard.sigurCard,
        card: result.card,
        sigurEmployeeId: result.sigurEmployeeId,
        employee: employeeBrief,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Не удалось привязать карту';
      toastError(msg);
    } finally {
      setAssigning(false);
    }
  }, [lastCard, selectedEmployee, expirationDate, success, toastError]);

  const handleClear = useCallback(() => {
    clearLastCard();
    resetForNewCard();
  }, [clearLastCard, resetForNewCard]);

  const statusClass = useMemo(() => {
    if (connected) return 'scr-status scr-status--ok';
    return 'scr-status scr-status--off';
  }, [connected]);

  return (
    <div className="scr-page">
      <header className="scr-header">
        <h1 className="scr-title">Считыватель пропусков</h1>
        <div className={statusClass}>
          <span className="scr-status-dot" />
          <span className="scr-status-text">{message}</span>
        </div>
      </header>

      {!connected && (
        <div className="scr-hint">
          Запустите приложение <strong>Sigur Reader EH</strong> на этом ПК. Если оно ещё не установлено —{' '}
          смотрите <a href="/docs/skud-card-reader.md" target="_blank" rel="noreferrer">инструкцию</a>.
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

          {lookupError && (
            <div className="scr-error">{lookupError}</div>
          )}

          {!lookupLoading && lookupResult?.found && lookupResult.employee && (
            <div className="scr-card scr-card--known">
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
              <button
                type="button"
                className="scr-primary-btn"
                onClick={() => navigate(`/employees/${lookupResult.employee!.id}`)}
              >
                Открыть профиль
              </button>
            </div>
          )}

          {!lookupLoading && lookupResult?.found && !lookupResult.employee && (
            <div className="scr-card scr-card--orphan">
              <p>
                Карта привязана к сотруднику Sigur (id <strong>{lookupResult.sigurEmployeeId}</strong>),
                но он не сматчен с ФОТ. Запустите синхронизацию структуры или проверьте сотрудника в Sigur Manager.
              </p>
            </div>
          )}

          {!lookupLoading && lookupResult && !lookupResult.found && (
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
                    <li key={emp.id}>
                      <button
                        type="button"
                        className="scr-search-item"
                        onClick={() => setSelectedEmployee(emp)}
                      >
                        <span className="scr-search-name">{emp.full_name}</span>
                        <span className="scr-search-meta">
                          {[emp.position_name, emp.department].filter(Boolean).join(' · ') || '—'}
                        </span>
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
                    onClick={handleAssign}
                    disabled={assigning}
                  >
                    {assigning ? 'Привязка…' : 'Привязать пропуск'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default SkudCardReaderPage;
