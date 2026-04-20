import { useState, useCallback, useRef, type FC } from 'react';
import { X, CheckCircle, AlertCircle, Users, ChevronDown, ChevronUp, Search, SkipForward, Check, RefreshCw } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import type { EnrichPreview, Employee, ConflictRow } from '../../types';

type Decision = { action: 'link'; employeeId: number; employeeName: string } | { action: 'skip' };

interface IEnrichPreviewModalProps {
  preview: EnrichPreview;
  conflicts?: ConflictRow[];
  loading: boolean;
  onApply: (manualMatches: Array<{ fullName: string; employeeId: number }>, conflictResolutions?: Array<{ employeeId: number; overwrite: boolean }>) => void;
  onClose: () => void;
  title?: string;
}

export const EnrichPreviewModal: FC<IEnrichPreviewModalProps> = ({
  preview,
  conflicts,
  loading,
  onApply,
  onClose,
  title = 'Импорт сотрудников — Превью',
}) => {
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [showAmbiguous, setShowAmbiguous] = useState(false);
  const [showConflicts, setShowConflicts] = useState(true);
  const [conflictResolutions, setConflictResolutions] = useState<Map<number, boolean>>(new Map());
  const [decisions, setDecisions] = useState<Map<number, Decision>>(new Map());
  const [searchResults, setSearchResults] = useState<Map<number, Employee[]>>(new Map());
  const [searchingIdx, setSearchingIdx] = useState<number | null>(null);
  const searchTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const { matched, unmatched, ambiguous, stats } = preview;

  const setDecision = (idx: number, decision: Decision) => {
    setDecisions(prev => {
      const next = new Map(prev);
      next.set(idx, decision);
      return next;
    });
  };

  const clearDecision = (idx: number) => {
    setDecisions(prev => {
      const next = new Map(prev);
      next.delete(idx);
      return next;
    });
  };

  const handleSearch = useCallback((idx: number, query: string) => {
    const existing = searchTimers.current.get(idx);
    if (existing) clearTimeout(existing);

    if (!query.trim()) {
      setSearchResults(prev => {
        const next = new Map(prev);
        next.delete(idx);
        return next;
      });
      return;
    }

    const timer = setTimeout(async () => {
      setSearchingIdx(idx);
      try {
        const res = await employeeService.getPaginated({ page: 1, pageSize: 5, search: query.trim(), status: 'active' });
        setSearchResults(prev => {
          const next = new Map(prev);
          next.set(idx, res.data);
          return next;
        });
      } catch {
        // ignore
      } finally {
        setSearchingIdx(null);
      }
    }, 300);
    searchTimers.current.set(idx, timer);
  }, []);

  const linkedCount = [...decisions.values()].filter(d => d.action === 'link').length;
  const skippedCount = [...decisions.values()].filter(d => d.action === 'skip').length;
  const pendingCount = unmatched.length - decisions.size;
  const overwriteCount = [...conflictResolutions.values()].filter(Boolean).length;
  const totalApply = matched.length + linkedCount + overwriteCount;

  const setConflictResolution = (employeeId: number, overwrite: boolean) => {
    setConflictResolutions(prev => {
      const next = new Map(prev);
      next.set(employeeId, overwrite);
      return next;
    });
  };

  const handleApply = () => {
    const manualMatches = [...decisions.entries()]
      .filter(([, d]) => d.action === 'link')
      .map(([idx, d]) => ({
        fullName: unmatched[idx].fullName,
        employeeId: (d as { action: 'link'; employeeId: number }).employeeId,
      }));
    const resolvedConflicts = conflicts?.map(c => ({
      employeeId: c.id,
      overwrite: conflictResolutions.get(c.id) ?? false,
    }));
    onApply(manualMatches, resolvedConflicts);
  };

  return (
    <div className="ep-modal-overlay" onClick={onClose}>
      <div className="ep-modal enrich-modal" onClick={e => e.stopPropagation()}>
        <div className="ep-modal-header">
          <span className="ep-modal-title">{title}</span>
          <button className="ep-modal-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="ep-modal-body enrich-body">
          {/* Статистика */}
          <div className="enrich-stats">
            <div className="enrich-stat">
              <Users size={16} />
              <span>Всего в файле: <strong>{stats.total}</strong></span>
            </div>
            <div className="enrich-stat success">
              <CheckCircle size={16} />
              <span>Совпало: <strong>{stats.matched}{linkedCount > 0 ? ` +${linkedCount}` : ''}</strong></span>
            </div>
            <div className="enrich-stat warning">
              <AlertCircle size={16} />
              <span>Не найдено: <strong>{stats.unmatched - linkedCount - skippedCount}</strong></span>
            </div>
            {conflicts && conflicts.length > 0 && (
              <div className="enrich-stat warning">
                <AlertCircle size={16} />
                <span>Конфликты email: <strong>{conflicts.length}</strong></span>
              </div>
            )}
            {stats.ambiguous > 0 && (
              <div className="enrich-stat warning">
                <AlertCircle size={16} />
                <span>Дубликаты: <strong>{stats.ambiguous}</strong></span>
              </div>
            )}
          </div>

          {/* Таблица совпавших */}
          {matched.length > 0 && (
            <div className="enrich-section">
              <h4>Будут обновлены ({matched.length})</h4>
              <div className="enrich-table-wrap">
                <table className="enrich-table">
                  <thead>
                    <tr>
                      <th>ФИО</th>
                      <th>Обновляемые поля</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matched.map(item => (
                      <tr key={item.id}>
                        <td className="enrich-name">{item.fullName}</td>
                        <td>
                          <div className="enrich-updates">
                            {Object.entries(item.updates).map(([field, val]) => (
                              <span key={field} className="enrich-update-tag">
                                {field}: {val.new}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Конфликты email */}
          {conflicts && conflicts.length > 0 && (
            <div className="enrich-section">
              <button
                className="enrich-toggle"
                onClick={() => setShowConflicts(!showConflicts)}
              >
                {showConflicts ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                Конфликты email ({conflicts.length})
                {overwriteCount > 0 && <span className="enrich-toggle-linked"> — заменить: {overwriteCount}</span>}
              </button>
              {showConflicts && (
                <div className="enrich-match-list">
                  {conflicts.map(item => {
                    const overwrite = conflictResolutions.get(item.id) ?? false;
                    return (
                      <div key={item.id} className="enrich-conflict-row">
                        <div className="enrich-match-info">
                          <span className="enrich-match-name">{item.fullName}</span>
                          <span className="enrich-conflict-emails">
                            <span className="enrich-conflict-old">{item.existingEmail}</span>
                            <RefreshCw size={12} />
                            <span className="enrich-conflict-new">{item.newEmail}</span>
                          </span>
                        </div>
                        <div className="enrich-conflict-actions">
                          <button
                            className={`enrich-conflict-btn${!overwrite ? ' active' : ''}`}
                            onClick={() => setConflictResolution(item.id, false)}
                          >
                            Оставить
                          </button>
                          <button
                            className={`enrich-conflict-btn enrich-conflict-btn--replace${overwrite ? ' active' : ''}`}
                            onClick={() => setConflictResolution(item.id, true)}
                          >
                            Заменить
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Несовпавшие — с возможностью ручного сопоставления */}
          {unmatched.length > 0 && (
            <div className="enrich-section">
              <button
                className="enrich-toggle"
                onClick={() => setShowUnmatched(!showUnmatched)}
              >
                {showUnmatched ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                Не найдены в системе ({unmatched.length})
                {linkedCount > 0 && <span className="enrich-toggle-linked"> — привязано: {linkedCount}</span>}
                {pendingCount > 0 && <span className="enrich-toggle-pending"> — ожидает: {pendingCount}</span>}
              </button>
              {showUnmatched && (
                <div className="enrich-match-list">
                  {unmatched.map((item, idx) => {
                    const dec = decisions.get(idx);
                    const results = searchResults.get(idx);

                    return (
                      <div key={idx} className={`enrich-match-row ${dec ? `enrich-match-row--${dec.action}` : ''}`}>
                        <div className="enrich-match-info">
                          <span className="enrich-match-name">{item.fullName}</span>
                          {item.department && <span className="enrich-match-dept">{item.department}</span>}
                        </div>

                        {dec?.action === 'link' ? (
                          <div className="enrich-match-decision">
                            <Check size={14} className="enrich-match-check" />
                            <span>→ {dec.employeeName}</span>
                            <button className="enrich-match-undo" onClick={() => clearDecision(idx)}>Отмена</button>
                          </div>
                        ) : dec?.action === 'skip' ? (
                          <div className="enrich-match-decision enrich-match-decision--skip">
                            <SkipForward size={14} />
                            <span>Пропущен</span>
                            <button className="enrich-match-undo" onClick={() => clearDecision(idx)}>Отмена</button>
                          </div>
                        ) : (
                          <div className="enrich-match-actions">
                            <div className="enrich-match-search-wrap">
                              <Search size={14} />
                              <input
                                type="text"
                                placeholder="Поиск сотрудника..."
                                defaultValue={item.fullName}
                                onChange={e => handleSearch(idx, e.target.value)}
                                onFocus={e => { if (e.target.value) handleSearch(idx, e.target.value); }}
                              />
                              {searchingIdx === idx && <span className="enrich-match-spinner" />}
                            </div>

                            {results && results.length > 0 && (
                              <div className="enrich-match-dropdown">
                                {results.map(r => (
                                  <button
                                    key={r.id}
                                    className="enrich-match-dropdown-item"
                                    onClick={() => {
                                      setDecision(idx, { action: 'link', employeeId: r.id, employeeName: r.full_name });
                                      setSearchResults(prev => { const next = new Map(prev); next.delete(idx); return next; });
                                    }}
                                  >
                                    <span className="enrich-match-dropdown-name">{r.full_name}</span>
                                    {r.position_name && <span className="enrich-match-dropdown-dept">{r.position_name}</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                            {results && results.length === 0 && (
                              <div className="enrich-match-no-results">Не найдено</div>
                            )}

                            <button className="enrich-match-btn-skip" onClick={() => setDecision(idx, { action: 'skip' })}>
                              <SkipForward size={13} /> Пропустить
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Дубликаты */}
          {ambiguous.length > 0 && (
            <div className="enrich-section">
              <button
                className="enrich-toggle"
                onClick={() => setShowAmbiguous(!showAmbiguous)}
              >
                {showAmbiguous ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                Неоднозначные совпадения ({ambiguous.length})
              </button>
              {showAmbiguous && (
                <div className="enrich-list">
                  {ambiguous.map((item, i) => (
                    <div key={i} className="enrich-list-item">
                      <span>{item.fullName}</span>
                      <span className="enrich-dept">{item.count} записей в БД</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="ep-modal-footer">
          <button className="ep-modal-btn secondary" onClick={onClose} disabled={loading}>
            Отмена
          </button>
          <button
            className="ep-modal-btn primary"
            onClick={handleApply}
            disabled={loading || totalApply === 0}
          >
            {loading ? 'Применяется...' : `Применить (${totalApply})`}
          </button>
        </div>
      </div>
    </div>
  );
};
