import { type FC, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsService, type IOpenRouterSettings, type IOpenRouterTestResult } from '../../services/settingsService';
import styles from '../../pages/super-admin/SystemSettingsPage.module.css';

export const OpenRouterSettingsSection: FC = () => {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['openrouter-settings'],
    queryFn: () => settingsService.getOpenRouterSettings(),
  });

  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('google/gemini-2.5-flash');
  const [baseUrl, setBaseUrl] = useState('https://openrouter.ai/api/v1');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (settingsQuery.data) {
      setEnabled(settingsQuery.data.enabled);
      setModel(settingsQuery.data.model);
      setBaseUrl(settingsQuery.data.baseUrl);
    }
  }, [settingsQuery.data]);

  const config: IOpenRouterSettings | null = settingsQuery.data ?? null;

  const handleSave = async () => {
    setSaving(true);
    setResult(null);
    try {
      const patch: { enabled?: boolean; apiKey?: string; model?: string; baseUrl?: string } = {
        enabled,
        model,
        baseUrl,
      };
      if (apiKey && apiKey !== '••••••••') patch.apiKey = apiKey;
      await settingsService.saveOpenRouterSettings(patch);
      setApiKey('');
      await queryClient.invalidateQueries({ queryKey: ['openrouter-settings'] });
      setResult({ ok: true, msg: 'Настройки сохранены' });
      setIsEditing(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка сохранения';
      setResult({ ok: false, msg });
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setApiKey('');
    setResult(null);
    if (settingsQuery.data) {
      setEnabled(settingsQuery.data.enabled);
      setModel(settingsQuery.data.model);
      setBaseUrl(settingsQuery.data.baseUrl);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res: IOpenRouterTestResult = await settingsService.testOpenRouter();
      if (res.ok) {
        setResult({ ok: true, msg: `Подключение успешно (${res.model || 'модель неизвестна'})` });
      } else {
        setResult({ ok: false, msg: res.error || 'Не удалось подключиться' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка теста';
      setResult({ ok: false, msg });
    } finally {
      setTesting(false);
    }
  };

  const isConfigured = !!config?.enabled && !!config?.hasApiKey;
  const modelLabel = config?.allowedModels.find(m => m.id === config.model)?.label || config?.model || '—';

  if (isConfigured && !isEditing) {
    return (
      <div className={`${styles.section} ${styles.sectionCollapsed}`}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Распознавание чеков (OpenRouter)</h2>
          <div className={styles.headerRight}>
            <span className={`${styles.statusBadge} ${styles.statusConnected}`}>Включено</span>
            <button className={styles.btnEdit} onClick={() => setIsEditing(true)}>Редактировать</button>
          </div>
        </div>
        <div className={styles.summaryLine}>
          <span><b>Модель:</b>{modelLabel}</span>
          <span><b>API ключ:</b>установлен</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Распознавание чеков (OpenRouter)</h2>
        <span className={`${styles.statusBadge} ${config?.enabled && config.hasApiKey ? styles.statusConnected : styles.statusDisconnected}`}>
          {config?.enabled && config.hasApiKey ? 'Включено' : 'Выключено'}
        </span>
      </div>

      <p className={styles.description}>
        Автоматическое распознавание чеков НДФЛ за патент через OpenRouter.{' '}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Получить API ключ</a>.
        После загрузки чека сотрудником в категории «Чек от патента» поля извлекаются и сохраняются в раздел «Чеки за патент».
      </p>

      <div className={styles.formGrid}>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Включено</label>
          <select
            className={styles.formInput}
            value={enabled ? 'true' : 'false'}
            onChange={e => setEnabled(e.target.value === 'true')}
          >
            <option value="true">Да</option>
            <option value="false">Нет</option>
          </select>
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Модель</label>
          <select
            className={styles.formInput}
            value={model}
            onChange={e => setModel(e.target.value)}
          >
            {(config?.allowedModels || []).map(m => (
              <option key={m.id} value={m.id} disabled={!m.supportsVision}>
                {m.label} (~{m.costPer1kReceiptsRub.toFixed(0)}₽ на 1000 чеков)
                {!m.supportsVision ? ' — не для чеков' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.formGroupFull}>
          <label className={styles.formLabel}>API ключ OpenRouter</label>
          <input
            className={styles.formInput}
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={config?.hasApiKey ? '•••••••• (установлен)' : 'sk-or-v1-...'}
            autoComplete="off"
          />
          <span className={styles.hint}>
            Источник: {config?.source === 'system_settings' ? 'настройки' : config?.source === 'env' ? '.env' : 'не задан'}
          </span>
        </div>
        <div className={styles.formGroupFull}>
          <label className={styles.formLabel}>Base URL</label>
          <input
            className={styles.formInput}
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://openrouter.ai/api/v1"
          />
        </div>
      </div>

      <div className={styles.actions}>
        <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
        <button className={styles.btnSecondary} onClick={handleTest} disabled={testing || !config?.hasApiKey}>
          {testing ? 'Проверка...' : 'Тест подключения'}
        </button>
        {isConfigured && (
          <button className={styles.btnSecondary} onClick={handleCancelEdit} disabled={saving}>
            Отмена
          </button>
        )}
      </div>

      {result && (
        <div className={`${styles.testResult} ${result.ok ? styles.testSuccess : styles.testError}`}>
          {result.msg}
        </div>
      )}
    </div>
  );
};
