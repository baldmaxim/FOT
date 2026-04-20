import { useState, useEffect, useMemo, useRef } from 'react';
import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wifi, WifiOff, RefreshCw, Eye, Search, ChevronDown, LockKeyhole, Pencil, Save } from 'lucide-react';
import { sigurService } from '../../services/sigurService';
import { sortDepartmentOptions } from '../../utils/departmentUtils';
import type { IPreviewData, SettingsTab } from './sigur-settings.types';
import type { SigurConnectionSettings } from '../../types';
import { FIELD_LABELS, DIRECTION_LABELS } from './sigur-settings.utils';
import { StructureSyncSection } from './StructureSyncSection';
import { EventsSyncSection } from './EventsSyncSection';
import { SigurDiagnosticsButton } from './SigurDiagnosticsButton';

interface IConnectionSettingsTabProps {
  connected: boolean | null;
  checking: boolean;
  availableConnections: { internal: boolean; external: boolean };
  canEdit: boolean;
  error: string;
  setError: (error: string) => void;
  checkConnection: () => Promise<boolean>;
  setActiveTab: (tab: SettingsTab) => void;
  syncFilterSummary: string;
}

interface IConnectionDraft {
  url: string;
  username: string;
  password: string;
}

function hasSavedExternalCredentials(settings: SigurConnectionSettings | null): boolean {
  if (!settings) return false;

  return Boolean(
    settings.external.url
    && settings.external.username
    && settings.external.hasPassword
    && settings.external.source !== 'unset',
  );
}

const SOURCE_LABELS: Record<SigurConnectionSettings['internal']['source'], string> = {
  system_settings: 'Сохранённые настройки',
  env: '.env',
  unset: 'Не настроено',
};

export const ConnectionSettingsTab: FC<IConnectionSettingsTabProps> = ({
  connected,
  checking,
  availableConnections,
  canEdit,
  setError,
  checkConnection,
  setActiveTab,
  syncFilterSummary,
}) => {
  // Предпросмотр
  const [previewData, setPreviewData] = useState<IPreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewStart, setPreviewStart] = useState('');
  const [previewEnd, setPreviewEnd] = useState('');
  const [previewDepartment, setPreviewDepartment] = useState('');
  const [departments, setDepartments] = useState<{ id: number; name: string }[]>([]);
  const [deptOpen, setDeptOpen] = useState(false);
  const [deptSearch, setDeptSearch] = useState('');
  const deptRef = useRef<HTMLDivElement>(null);
  const [connectionSettings, setConnectionSettings] = useState<SigurConnectionSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<IConnectionDraft>({ url: '', username: '', password: '' });

  // Закрытие dropdown по клику вне
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (deptRef.current && !deptRef.current.contains(e.target as Node)) {
        setDeptOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Discover
  const [discovering, setDiscovering] = useState(false);
  const [discoverData, setDiscoverData] = useState<Record<string, unknown> | null>(null);

  // Инициализация дат текущим месяцем
  useEffect(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const mStr = String(m).padStart(2, '0');
    const dStr = String(now.getDate()).padStart(2, '0');
    setPreviewStart(`${y}-${mStr}-01`);
    setPreviewEnd(`${y}-${mStr}-${dStr}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSettingsLoading(true);

    sigurService.getConnectionSettings()
      .then(settings => {
        if (cancelled) return;
        setConnectionSettings(settings);
        setDraft({
          url: settings.external.url || '',
          username: settings.external.username || '',
          password: '',
        });
        setShowConnectionForm(!hasSavedExternalCredentials(settings));
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить настройки подключения Sigur');
        setShowConnectionForm(true);
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [setError]);

  const syncFilterQuery = useQuery({
    queryKey: ['sigur', 'sync-filter'],
    queryFn: () => sigurService.getSyncFilter(),
    enabled: connected === true,
    staleTime: 5 * 60_000,
  });

  const filterDepartments = useMemo(() => {
    if (!syncFilterQuery.data) return null;
    return sortDepartmentOptions(syncFilterQuery.data.map((d) => ({
      id: d.sigur_department_id,
      name: d.sigur_department_name,
    })));
  }, [syncFilterQuery.data]);

  useEffect(() => {
    if (filterDepartments) setDepartments(filterDepartments);
  }, [filterDepartments]);

  const handlePreview = async () => {
    if (!previewStart || !previewEnd) return;
    setPreviewLoading(true);
    setError('');
    try {
      const startTime = `${previewStart}T00:00:00`;
      const endTime = `${previewEnd}T23:59:59`;
      const data = await sigurService.preview(startTime, endTime, previewDepartment || undefined, 'external');
      setPreviewData(data);
    } catch {
      setError('Ошибка загрузки данных предпросмотра');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoverData(null);
    setError('');
    try {
      const result = await sigurService.discover('external');
      setDiscoverData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка диагностики API');
    } finally {
      setDiscovering(false);
    }
  };

  const updateDraft = (field: keyof IConnectionDraft, value: string) => {
    setDraft(prev => ({ ...prev, [field]: value }));
    setSavedFlash(false);
  };

  const handleCancelConnectionSettings = () => {
    setDraft({
      url: connectionSettings?.external.url || '',
      username: connectionSettings?.external.username || '',
      password: '',
    });
    setSavedFlash(false);
    setError('');
    setShowConnectionForm(!hasSavedExternalCredentials(connectionSettings));
  };

  const handleSaveConnectionSettings = async () => {
    setSettingsSaving(true);
    setError('');
    try {
      const payload = {
        external: {
          url: draft.url,
          username: draft.username,
          ...(draft.password.trim() ? { password: draft.password } : {}),
        },
      } as Parameters<typeof sigurService.saveConnectionSettings>[0];

      if (connectionSettings) {
        payload.archiveDepartmentId = connectionSettings.archiveDepartmentId ?? null;
        payload.archiveDepartmentName = connectionSettings.archiveDepartmentName ?? null;
      }

      const nextSettings = await sigurService.saveConnectionSettings(payload);
      setConnectionSettings(nextSettings);
      setDraft({ url: nextSettings.external.url || '', username: nextSettings.external.username || '', password: '' });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2500);
      const hasSavedCredentials = hasSavedExternalCredentials(nextSettings);
      if (hasSavedCredentials) {
        setShowConnectionForm(false);
      }
      void checkConnection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить настройки подключения Sigur');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleEnsureArchiveDepartment = async () => {
    setArchiveBusy(true);
    setError('');
    try {
      const archive = await sigurService.ensureArchiveDepartment('external');
      setConnectionSettings(prev => prev ? ({
        ...prev,
        archiveDepartmentId: archive.sigurDepartmentId,
        archiveDepartmentName: archive.name,
      }) : prev);
      void checkConnection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать архивный отдел Sigur');
    } finally {
      setArchiveBusy(false);
    }
  };

  const statusBadge = () => {
    if (checking) {
      return <span className="sigur-status-badge checking"><span className="sigur-status-dot" />Проверка...</span>;
    }
    if (connected) {
      return <span className="sigur-status-badge connected"><span className="sigur-status-dot" />Подключено</span>;
    }
    if (connected === false) {
      return <span className="sigur-status-badge disconnected"><span className="sigur-status-dot" />Нет связи</span>;
    }
    return null;
  };

  const effectiveConnections = connectionSettings?.connections ?? availableConnections;
  const externalConfig = connectionSettings?.external;
  const isConnectionFormVisible = showConnectionForm === true;
  const canShowCompactConnectionView = showConnectionForm === false;

  return (
    <>
      {/* Секция 1: Подключение */}
      <div className="sigur-section">
        <div className="sigur-section-title-row">
          <h2 className="sigur-section-title">
            {connected ? <Wifi size={18} /> : <WifiOff size={18} />}
            Подключение к Sigur
          </h2>
          {canShowCompactConnectionView && canEdit && (
            <button
              className="sigur-btn"
              onClick={() => setShowConnectionForm(true)}
              disabled={settingsSaving}
            >
              <Pencil size={14} />
              Редактировать
            </button>
          )}
        </div>
        <div className="sigur-connection-row">
          {statusBadge()}
          <span className="sigur-source-badge ready">Используется только внешний контур</span>
          <button
            className="sigur-btn"
            onClick={() => { void checkConnection(); }}
            disabled={checking}
          >
            <RefreshCw size={14} />
            Проверить
          </button>
          <SigurDiagnosticsButton />
        </div>

        {isConnectionFormVisible && (
          <div className="sigur-conn-config-grid">
            <div className="sigur-conn-config-card">
              <div className="sigur-conn-config-head">
                <div>
                  <div className="sigur-conn-config-title">External</div>
                  <div className="sigur-conn-config-hint">Единственный рабочий контур для удалённой работы и серверных задач.</div>
                </div>
                <div className="sigur-conn-config-meta">
                  <span className={`sigur-source-badge ${externalConfig?.source || 'unset'}`}>
                    {SOURCE_LABELS[externalConfig?.source || 'unset']}
                  </span>
                  <span className={`sigur-source-badge ${effectiveConnections.external ? 'ready' : 'unset'}`}>
                    {effectiveConnections.external ? 'Готово к подключению' : 'Нет полного контура'}
                  </span>
                </div>
              </div>

              <div className="sigur-conn-form-grid">
                <label>
                  URL
                  <input
                    className="sigur-form-input"
                    type="text"
                    placeholder="https://..."
                    value={draft.url}
                    onChange={event => updateDraft('url', event.target.value)}
                    disabled={!canEdit || settingsSaving}
                  />
                </label>
                <label>
                  Логин
                  <input
                    className="sigur-form-input"
                    type="text"
                    placeholder="Логин Sigur"
                    value={draft.username}
                    onChange={event => updateDraft('username', event.target.value)}
                    disabled={!canEdit || settingsSaving}
                  />
                </label>
                <div className="sigur-conn-password-block">
                  <div className="sigur-conn-password-status">
                    <LockKeyhole size={14} />
                    {externalConfig?.hasPassword ? 'Пароль уже сохранён. Введите новый, если хотите заменить.' : 'Введите пароль для внешнего контура Sigur.'}
                  </div>
                  <input
                    className="sigur-form-input"
                    type="password"
                    placeholder={externalConfig?.hasPassword ? 'Новый пароль или оставьте пустым' : 'Пароль Sigur'}
                    value={draft.password}
                    onChange={event => updateDraft('password', event.target.value)}
                    disabled={!canEdit || settingsSaving}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {isConnectionFormVisible && (
          <div className="sigur-conn-actions">
            <button
              className="sigur-btn"
              onClick={handleCancelConnectionSettings}
              disabled={settingsSaving}
            >
              Отмена
            </button>
            <button
              className={`sigur-btn sigur-btn-primary ${savedFlash ? 'sigur-btn-saved' : ''}`}
              onClick={() => void handleSaveConnectionSettings()}
              disabled={!canEdit || settingsSaving || settingsLoading}
            >
              <Save size={14} />
              {savedFlash ? 'Сохранено' : settingsSaving ? 'Сохранение...' : 'Сохранить параметры'}
            </button>
            <span className="sigur-muted">
              URL и логин сохраняются в настройках портала. Пустой пароль не затирает текущий секрет, а оставляет его без изменений.
            </span>
          </div>
        )}

        <div className="sigur-archive-card">
          <div>
            <div className="sigur-conn-config-title">Архивный отдел для уволенных</div>
            <div className="sigur-conn-config-hint">
              При увольнении linked-сотрудник переносится в этот отдел в Sigur, затем блокируется.
            </div>
          </div>
          <div className="sigur-archive-status">
            {connectionSettings?.archiveDepartmentId ? (
              <>
                <span>Отдел: <strong>{connectionSettings.archiveDepartmentName || 'Уволенные'}</strong></span>
                <span>ID: <strong>{connectionSettings.archiveDepartmentId}</strong></span>
              </>
            ) : (
              <span>Архивный отдел пока не создан.</span>
            )}
          </div>
          <button
            className="sigur-btn"
            onClick={() => void handleEnsureArchiveDepartment()}
            disabled={!canEdit || archiveBusy || !connected}
          >
            <LockKeyhole size={14} />
            {archiveBusy ? 'Создание...' : connectionSettings?.archiveDepartmentId ? 'Проверить архивный отдел' : 'Создать архивный отдел'}
          </button>
        </div>
      </div>

      {/* Секция 2: Полная синхронизация структуры */}
      <StructureSyncSection
        connected={connected}
        canEdit={canEdit}
        setError={setError}
        setActiveTab={setActiveTab}
        syncFilterSummary={syncFilterSummary}
        externalBusy={false}
      />

      {/* Секция 3: Discover API */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <Search size={18} />
          Диагностика Sigur API
        </h2>
        <div className="sigur-connection-row">
          <button
            className="sigur-btn"
            onClick={handleDiscover}
            disabled={discovering || !connected}
          >
            <Search size={14} />
            {discovering ? 'Анализ...' : 'Discover API'}
          </button>
        </div>
        {discoverData && (
          <div className="sigur-sync-result">
            <pre style={{ fontSize: '0.7rem', maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(discoverData, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Секция 4: Предпросмотр */}
      <div className="sigur-section">
        <h2 className="sigur-section-title">
          <Eye size={18} />
          Предпросмотр данных
        </h2>
        <div className="sigur-preview-controls">
          <label>
            С:
            <input
              type="date"
              value={previewStart}
              onChange={e => setPreviewStart(e.target.value)}
            />
          </label>
          <label>
            По:
            <input
              type="date"
              value={previewEnd}
              onChange={e => setPreviewEnd(e.target.value)}
            />
          </label>
          <div className="sigur-dept-dropdown" ref={deptRef}>
            <span className="sigur-dept-label">Отдел:</span>
            <button
              type="button"
              className={`sigur-dept-trigger${previewDepartment ? ' has-value' : ''}`}
              onClick={() => { setDeptOpen(o => !o); setDeptSearch(''); }}
            >
              <span className="sigur-dept-trigger-text">
                {previewDepartment
                  ? departments.find(d => String(d.id) === previewDepartment)?.name || 'Все отделы'
                  : 'Все отделы'}
              </span>
              <ChevronDown size={14} className={`sigur-dept-chevron${deptOpen ? ' open' : ''}`} />
            </button>
            {deptOpen && (
              <div className="sigur-dept-menu">
                <div className="sigur-dept-search-wrap">
                  <Search size={14} />
                  <input
                    autoFocus
                    placeholder="Поиск отдела..."
                    value={deptSearch}
                    onChange={e => setDeptSearch(e.target.value)}
                  />
                </div>
                <div className="sigur-dept-list">
                  <div
                    className={`sigur-dept-item${!previewDepartment ? ' selected' : ''}`}
                    onClick={() => { setPreviewDepartment(''); setDeptOpen(false); }}
                  >
                    Все отделы
                  </div>
                  {departments
                    .filter(d => d.name.toLowerCase().includes(deptSearch.toLowerCase()))
                    .map(d => (
                      <div
                        key={d.id}
                        className={`sigur-dept-item${String(d.id) === previewDepartment ? ' selected' : ''}`}
                        onClick={() => { setPreviewDepartment(String(d.id)); setDeptOpen(false); }}
                      >
                        {d.name}
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
          <button
            className="sigur-btn"
            onClick={handlePreview}
            disabled={previewLoading || !connected || !previewStart || !previewEnd}
          >
            <Eye size={14} />
            {previewLoading ? 'Загрузка...' : 'Загрузить'}
          </button>
        </div>

        {previewData && (
          <>
            <div className="sigur-preview-info">
              Всего событий: {previewData.totalFetched} | Проходы (PASS): {previewData.mappedCount ?? previewData.data.length} | Показано: {previewData.data.length}
            </div>

            {previewData.data.length > 0 && (
              <div className="sigur-preview-table-wrap">
                <table className="sigur-preview-table">
                  <thead>
                    <tr>
                      {previewData.sampleFields.map(f => (
                        <th key={f}>{FIELD_LABELS[f] || f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.data.map((row, i) => (
                      <tr key={i}>
                        {previewData.sampleFields.map(f => {
                          const val = row[f];
                          const display = f === 'direction' && typeof val === 'string'
                            ? (DIRECTION_LABELS[val] || val)
                            : f === 'eventDate' && typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)
                              ? val.split('-').reverse().join('.')
                              : f === 'blocked' && typeof val === 'boolean'
                                ? (val ? 'Да' : 'Нет')
                                : String(val ?? '—');
                          return (
                            <td key={f} title={display}>
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Секция 5: Синхронизация событий */}
      <EventsSyncSection
        connected={connected}
        setError={setError}
        setActiveTab={setActiveTab}
        syncFilterSummary={syncFilterSummary}
        externalBusy={false}
      />
    </>
  );
};
