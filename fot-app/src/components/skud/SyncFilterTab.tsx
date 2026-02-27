import { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Save, Check, RefreshCw, Info } from 'lucide-react';
import { sigurService } from '../../services/sigurService';
import '../../styles/SigurSettingsPage.css';

interface ISigurDepartment {
  id: number;
  name: string;
  parentId?: number;
}

interface ISyncFilterTabProps {
  connected: boolean | null;
  canEdit: boolean;
}

export const SyncFilterTab = ({ connected, canEdit }: ISyncFilterTabProps) => {
  const [sigurDepts, setSigurDepts] = useState<ISigurDepartment[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [initialIds, setInitialIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [deptsRes, filterRes] = await Promise.all([
        sigurService.getDepartments(),
        sigurService.getSyncFilter(),
      ]);

      const depts: ISigurDepartment[] = ((deptsRes.data || []) as Record<string, unknown>[]).map(d => ({
        id: d.id as number,
        name: (d.name as string) || '',
        parentId: d.parentId as number | undefined,
      })).filter(d => d.name.trim()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      setSigurDepts(depts);

      const filterIds = new Set<number>(
        (filterRes || []).map(f => f.sigur_department_id)
      );
      setSelectedIds(filterIds);
      setInitialIds(filterIds);
    } catch {
      setError('Ошибка загрузки данных');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) loadData();
  }, [connected, loadData]);

  const filteredDepts = useMemo(() => {
    if (!search.trim()) return sigurDepts;
    const q = search.toLowerCase();
    return sigurDepts.filter(d => d.name.toLowerCase().includes(q));
  }, [sigurDepts, search]);

  const isDirty = useMemo(() => {
    if (selectedIds.size !== initialIds.size) return true;
    for (const id of selectedIds) {
      if (!initialIds.has(id)) return true;
    }
    return false;
  }, [selectedIds, initialIds]);

  const toggleDept = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSaved(false);
  };

  const handleSelectAll = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const d of filteredDepts) next.add(d.id);
      return next;
    });
    setSaved(false);
  };

  const handleDeselectAll = () => {
    if (search.trim()) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const d of filteredDepts) next.delete(d.id);
        return next;
      });
    } else {
      setSelectedIds(new Set());
    }
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const departments = sigurDepts
        .filter(d => selectedIds.has(d.id))
        .map(d => ({ sigur_department_id: d.id, sigur_department_name: d.name }));
      await sigurService.updateSyncFilter(departments);
      setInitialIds(new Set(selectedIds));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Ошибка сохранения фильтра');
    } finally {
      setSaving(false);
    }
  };

  if (!connected) {
    return (
      <div className="sigur-section">
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          Нет подключения к Sigur
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="sigur-section">
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          Загрузка отделов Sigur...
        </div>
      </div>
    );
  }

  return (
    <div className="sigur-section sigur-section--full-height">
      {error && (
        <div className="sigur-error" style={{ marginBottom: '0.75rem' }}>
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}

      <div className="sync-filter-header">
        <div className="sync-filter-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Поиск отдела..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="sync-filter-actions">
          {canEdit && (
            <>
              <button className="sigur-btn" onClick={handleSelectAll}>
                Выбрать все
              </button>
              <button className="sigur-btn" onClick={handleDeselectAll}>
                Снять все
              </button>
            </>
          )}
          <button className="sigur-btn" onClick={loadData} title="Обновить список">
            <RefreshCw size={14} />
          </button>
          {canEdit && (
            <button
              className={`sigur-btn sigur-btn-primary ${saved ? 'sigur-btn-saved' : ''}`}
              onClick={handleSave}
              disabled={saving || !isDirty}
            >
              {saved ? <><Check size={14} /> Сохранено</> : <><Save size={14} /> Сохранить</>}
            </button>
          )}
        </div>
      </div>

      <div className="sync-filter-counter">
        Выбрано: <strong>{selectedIds.size}</strong> из {sigurDepts.length}
      </div>

      {selectedIds.size === 0 && (
        <div className="sync-filter-info">
          <Info size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          Если ничего не выбрано — синхронизируются все отделы Sigur
        </div>
      )}

      {sigurDepts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          Нет отделов в Sigur
        </div>
      ) : (
        <div className="sigur-preview-table-wrap sync-filter-table-wrap">
          <table className="sigur-preview-table">
            <thead>
              <tr>
                <th style={{ width: 40, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    className="sync-filter-checkbox"
                    checked={filteredDepts.length > 0 && filteredDepts.every(d => selectedIds.has(d.id))}
                    onChange={() => {
                      const allSelected = filteredDepts.every(d => selectedIds.has(d.id));
                      if (allSelected) handleDeselectAll();
                      else handleSelectAll();
                    }}
                    disabled={!canEdit}
                  />
                </th>
                <th>#</th>
                <th>Отдел Sigur</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {filteredDepts.map((dept, idx) => (
                <tr
                  key={dept.id}
                  onClick={() => canEdit && toggleDept(dept.id)}
                  style={{ cursor: canEdit ? 'pointer' : 'default' }}
                >
                  <td style={{ width: 40, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      className="sync-filter-checkbox"
                      checked={selectedIds.has(dept.id)}
                      onChange={() => toggleDept(dept.id)}
                      disabled={!canEdit}
                      onClick={e => e.stopPropagation()}
                    />
                  </td>
                  <td style={{ width: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>{idx + 1}</td>
                  <td>{dept.name}</td>
                  <td style={{ color: 'var(--text-tertiary)', fontSize: '0.6875rem' }}>{dept.id}</td>
                </tr>
              ))}
              {filteredDepts.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-tertiary)', padding: '1rem' }}>
                    Не найдено
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
