import { useState, useEffect, useMemo } from 'react';
import type { FC } from 'react';
import { Search, Save, Check, RefreshCw } from 'lucide-react';
import { skudService } from '../../services/skudService';
import type { AccessPointOption, IAccessPointSetting } from '../../types';

interface IAccessPointsTabProps {
  connected: boolean | null;
  canEdit: boolean;
  selectedConnection: 'internal' | 'external';
  setError: (error: string) => void;
}

export const AccessPointsTab: FC<IAccessPointsTabProps> = ({
  connected,
  canEdit,
  selectedConnection,
  setError,
}) => {
  const [accessPoints, setAccessPoints] = useState<AccessPointOption[]>([]);
  const [apLoading, setApLoading] = useState(false);
  const [apSettings, setApSettings] = useState<Map<string, boolean>>(new Map());
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [syncingAP, setSyncingAP] = useState(false);
  const [syncAPResult, setSyncAPResult] = useState<{ added: number; removed: number } | null>(null);
  const [apSearch, setApSearch] = useState('');

  useEffect(() => {
    setApLoading(true);
    skudService.getAccessPointOptions(selectedConnection)
      .then(setAccessPoints)
      .catch(() => setError('Ошибка загрузки точек доступа'))
      .finally(() => setApLoading(false));

    skudService.getAccessPointSettings()
      .then(settings => {
        const map = new Map<string, boolean>();
        for (const s of settings) {
          map.set(s.access_point_name.trim(), s.is_internal);
        }
        setApSettings(map);
      })
      .catch(() => {});
  }, [selectedConnection, setError]);

  const filteredAccessPoints = useMemo(() => {
    if (!apSearch.trim()) return accessPoints;
    const q = apSearch.toLowerCase();
    return accessPoints.filter(ap => {
      const label = ap.id == null ? ap.name : `${ap.name} (${ap.id})`;
      return label.toLowerCase().includes(q);
    });
  }, [accessPoints, apSearch]);

  const toggleApInternal = (apName: string) => {
    const key = apName.trim();
    setApSettings(prev => {
      const next = new Map(prev);
      next.set(key, !next.get(key));
      return next;
    });
    setSettingsSaved(false);
  };

  const handleSaveApSettings = async () => {
    setSavingSettings(true);
    try {
      const settings: IAccessPointSetting[] = accessPoints.map(ap => ({
        access_point_name: ap.name,
        is_internal: apSettings.get(ap.name.trim()) || false,
      }));
      await skudService.saveAccessPointSettings(settings);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch {
      setError('Ошибка сохранения настроек');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSyncAccessPoints = async () => {
    setSyncingAP(true);
    setSyncAPResult(null);
    setError('');
    try {
      const oldSet = new Set(accessPoints.map(ap => ap.name));
      const result = await skudService.syncAccessPoints(selectedConnection);
      try {
        const refreshed = await skudService.getAccessPointOptions(selectedConnection);
        setAccessPoints(refreshed);
      } catch {
        setAccessPoints(result.accessPoints.map(name => ({ name, id: null })));
      }
      if (result.removed.length > 0) {
        setApSettings(prev => {
          const next = new Map(prev);
          for (const name of result.removed) next.delete(name);
          return next;
        });
      }
      const addedCount = result.accessPoints.filter(ap => !oldSet.has(ap)).length;
      setSyncAPResult({ added: addedCount, removed: result.removed.length });
      setTimeout(() => setSyncAPResult(null), 5000);
    } catch {
      setError('Ошибка обновления точек доступа');
    } finally {
      setSyncingAP(false);
    }
  };

  return (
    <div className="sigur-section sigur-section--full-height">
      <div className="sigur-ap-toolbar">
        <div className="sigur-ap-search-wrap">
          <Search size={14} />
          <input
            type="text"
            placeholder="Поиск точки доступа..."
            value={apSearch}
            onChange={e => setApSearch(e.target.value)}
          />
        </div>
        {canEdit && (<>
          <button
            className="sigur-btn"
            onClick={handleSyncAccessPoints}
            disabled={syncingAP || !connected}
            title="Обновить список из Sigur"
          >
            <RefreshCw size={14} className={syncingAP ? 'sigur-spin' : ''} />
            {syncingAP ? 'Обновление...' : 'Обновить'}
          </button>
          <button
            className={`sigur-btn sigur-btn-primary ${settingsSaved ? 'sigur-btn-saved' : ''}`}
            onClick={handleSaveApSettings}
            disabled={savingSettings}
          >
            {settingsSaved ? <><Check size={14} /> Сохранено</> : <><Save size={14} /> Сохранить</>}
          </button>
        </>)}
      </div>

      {syncAPResult && (
        <div className="sigur-sync-result" style={{ marginBottom: '0.75rem' }}>
          <div className="sigur-sync-stats">
            {syncAPResult.added > 0 && (
              <span className="sigur-sync-stat success">Добавлено: <strong>{syncAPResult.added}</strong></span>
            )}
            {syncAPResult.removed > 0 && (
              <span className="sigur-sync-stat skipped">Удалено: <strong>{syncAPResult.removed}</strong></span>
            )}
            {syncAPResult.added === 0 && syncAPResult.removed === 0 && (
              <span className="sigur-sync-stat">Изменений нет</span>
            )}
          </div>
        </div>
      )}

      {apLoading ? (
        <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          Загрузка точек доступа...
        </div>
      ) : accessPoints.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          Нет точек доступа
        </div>
      ) : (
        <div className="sigur-preview-table-wrap">
          <table className="sigur-preview-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Точка доступа</th>
                <th>Тип зоны</th>
              </tr>
            </thead>
            <tbody>
              {filteredAccessPoints.map((ap, idx) => {
                const label = ap.id == null ? ap.name : `${ap.name} (${ap.id})`;
                const isInternal = apSettings.get(ap.name.trim()) || false;
                return (
                  <tr key={ap.name}>
                    <td style={{ width: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>{idx + 1}</td>
                    <td>{label}</td>
                    <td>
                      {canEdit ? (
                        <button
                          className={`sigur-ap-type-btn ${isInternal ? 'internal' : 'external'}`}
                          onClick={() => toggleApInternal(ap.name)}
                        >
                          {isInternal ? 'Внутренняя' : 'Внешняя'}
                        </button>
                      ) : (
                        <span className={`sigur-ap-type-label ${isInternal ? 'internal' : 'external'}`}>
                          {isInternal ? 'Внутренняя' : 'Внешняя'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
