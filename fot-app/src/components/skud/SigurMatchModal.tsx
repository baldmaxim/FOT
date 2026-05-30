import { useState, useCallback, useRef, type FC } from 'react';
import { X, Search, Link2, UserPlus, SkipForward, Check } from 'lucide-react';
import { sigurService } from '../../services/sigurService';
import { employeeService } from '../../services/employeeService';
import { ModalShell } from '../ui/ModalShell';
import type { Employee } from '../../types';
import type { IUnmatchedSigurEmployee } from './sigur-settings.types';

type Decision = { action: 'link'; employeeId: number; employeeName: string }
  | { action: 'create' }
  | { action: 'skip' };

interface ISigurMatchModalProps {
  unmatched: IUnmatchedSigurEmployee[];
  onClose: () => void;
  onSaved: (result: { linked: number; created: number }) => void;
}

export const SigurMatchModal: FC<ISigurMatchModalProps> = ({ unmatched, onClose, onSaved }) => {
  const [decisions, setDecisions] = useState<Map<number, Decision>>(new Map());
  const [searchResults, setSearchResults] = useState<Map<number, Employee[]>>(new Map());
  const [searchingIdx, setSearchingIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const searchTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const setDecision = (idx: number, decision: Decision) => {
    setDecisions(prev => {
      const next = new Map(prev);
      next.set(idx, decision);
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

  const handleSave = async () => {
    setSaving(true);
    setError('');

    const matches: Array<{ sigurId: number; employeeId: number }> = [];
    const createNew: Array<{ sigurId?: number; name: string; orgDepartmentId?: string; positionId?: string }> = [];

    for (const [idx, dec] of decisions) {
      const emp = unmatched[idx];
      if (dec.action === 'link' && emp.sigurId) {
        matches.push({ sigurId: emp.sigurId, employeeId: dec.employeeId });
      } else if (dec.action === 'create') {
        createNew.push({
          sigurId: emp.sigurId,
          name: emp.name,
          orgDepartmentId: emp.orgDepartmentId || undefined,
          positionId: emp.positionId || undefined,
        });
      }
    }

    if (matches.length === 0 && createNew.length === 0) {
      onClose();
      return;
    }

    try {
      const result = await sigurService.matchEmployees(matches, createNew);
      if (result.errors.length > 0) {
        setError(`Ошибки: ${result.errors.slice(0, 3).join('; ')}`);
      }
      onSaved({ linked: result.linked, created: result.created });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const linkedCount = [...decisions.values()].filter(d => d.action === 'link').length;
  const createCount = [...decisions.values()].filter(d => d.action === 'create').length;
  const skippedCount = [...decisions.values()].filter(d => d.action === 'skip').length;
  const pendingCount = unmatched.length - decisions.size;

  return (
    <ModalShell onClose={onClose} overlayClassName="sigur-match-overlay" containerClassName="sigur-match-modal">
      {({ requestClose }) => (
        <>
        <div className="sigur-match-header">
          <h3>Несопоставленные сотрудники ({unmatched.length})</h3>
          <button className="sigur-match-close" onClick={requestClose}><X size={18} /></button>
        </div>

        <div className="sigur-match-stats">
          <span className="sigur-match-stat"><Link2 size={14} /> Привязано: <strong>{linkedCount}</strong></span>
          <span className="sigur-match-stat"><UserPlus size={14} /> Новых: <strong>{createCount}</strong></span>
          <span className="sigur-match-stat"><SkipForward size={14} /> Пропущено: <strong>{skippedCount}</strong></span>
          {pendingCount > 0 && (
            <span className="sigur-match-stat pending">Ожидает: <strong>{pendingCount}</strong></span>
          )}
        </div>

        {error && <div className="sigur-match-error">{error}</div>}

        <div className="sigur-match-list">
          {unmatched.map((emp, idx) => {
            const dec = decisions.get(idx);
            const results = searchResults.get(idx);

            return (
              <div key={idx} className={`sigur-match-row ${dec ? `sigur-match-row--${dec.action}` : ''}`}>
                <div className="sigur-match-emp-info">
                  <div className="sigur-match-emp-name">{emp.name}</div>
                  <div className="sigur-match-emp-meta">
                    {emp.departmentName && <span>{emp.departmentName}</span>}
                    {emp.positionName && <span>{emp.positionName}</span>}
                  </div>
                </div>

                {dec?.action === 'link' ? (
                  <div className="sigur-match-decision">
                    <Check size={14} className="sigur-match-check" />
                    <span>→ {dec.employeeName}</span>
                    <button className="sigur-match-undo" onClick={() => {
                      setDecisions(prev => { const next = new Map(prev); next.delete(idx); return next; });
                    }}>Отмена</button>
                  </div>
                ) : dec?.action === 'create' ? (
                  <div className="sigur-match-decision">
                    <UserPlus size={14} />
                    <span>Создать нового</span>
                    <button className="sigur-match-undo" onClick={() => {
                      setDecisions(prev => { const next = new Map(prev); next.delete(idx); return next; });
                    }}>Отмена</button>
                  </div>
                ) : dec?.action === 'skip' ? (
                  <div className="sigur-match-decision sigur-match-decision--skip">
                    <SkipForward size={14} />
                    <span>Пропущен</span>
                    <button className="sigur-match-undo" onClick={() => {
                      setDecisions(prev => { const next = new Map(prev); next.delete(idx); return next; });
                    }}>Отмена</button>
                  </div>
                ) : (
                  <div className="sigur-match-actions">
                    <div className="sigur-match-search-wrap">
                      <Search size={14} />
                      <input
                        type="text"
                        placeholder="Поиск сотрудника..."
                        defaultValue={emp.name}
                        onChange={e => handleSearch(idx, e.target.value)}
                        onFocus={e => { if (e.target.value) handleSearch(idx, e.target.value); }}
                      />
                      {searchingIdx === idx && <span className="sigur-match-searching" />}
                    </div>

                    {results && results.length > 0 && (
                      <div className="sigur-match-dropdown">
                        {results.map(r => (
                          <button
                            key={r.id}
                            className="sigur-match-dropdown-item"
                            onClick={() => {
                              setDecision(idx, { action: 'link', employeeId: r.id, employeeName: r.full_name });
                              setSearchResults(prev => { const next = new Map(prev); next.delete(idx); return next; });
                            }}
                          >
                            <span className="sigur-match-dropdown-name">{r.full_name}</span>
                            {r.department && <span className="sigur-match-dropdown-dept">{r.department}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    {results && results.length === 0 && (
                      <div className="sigur-match-no-results">Не найдено</div>
                    )}

                    <div className="sigur-match-btn-row">
                      <button className="sigur-match-btn-create" onClick={() => setDecision(idx, { action: 'create' })}>
                        <UserPlus size={13} /> Создать
                      </button>
                      <button className="sigur-match-btn-skip" onClick={() => setDecision(idx, { action: 'skip' })}>
                        <SkipForward size={13} /> Пропустить
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="sigur-match-footer">
          <button className="sigur-btn" onClick={requestClose} disabled={saving}>Отмена</button>
          <button
            className="sigur-btn sigur-btn-primary"
            onClick={handleSave}
            disabled={saving || (linkedCount === 0 && createCount === 0)}
          >
            {saving ? 'Сохранение...' : `Сохранить (${linkedCount} привязано, ${createCount} новых)`}
          </button>
        </div>
        </>
      )}
    </ModalShell>
  );
};
