import { type FC, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adaptiveTestingService,
  type IAdaptiveSettings,
  type IAdaptiveSettingsPatch,
} from '../../services/adaptiveTestingService';
import styles from '../../pages/admin/SystemSettingsPage.module.css';

const QUERY_KEY = ['adaptive-testing', 'settings'] as const;

/**
 * Блок «Адаптивное тестирование (OpenRouter)» — отдельная конфигурация Luna.
 * OCR-блок чеков не трогает: в shared_proxy наследуются только ключ и Base URL.
 */
export const AdaptiveTestingSettingsSection: FC = () => {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => adaptiveTestingService.getSettings(),
  });

  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState('openai/gpt-5.6-luna');
  const [allowedEmails, setAllowedEmails] = useState('');
  const [dailyLimit, setDailyLimit] = useState(1);
  const [connectionMode, setConnectionMode] = useState<'shared_proxy' | 'dedicated_proxy'>('shared_proxy');
  const [zdrRequired, setZdrRequired] = useState(false);
  const [dedicatedKey, setDedicatedKey] = useState('');
  const [dedicatedBaseUrl, setDedicatedBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    const data = settingsQuery.data;
    if (data) {
      setEnabled(data.enabled);
      setModel(data.model);
      setAllowedEmails(data.allowedEmails);
      setDailyLimit(data.dailySessionsLimit);
      setConnectionMode(data.connectionMode);
      setZdrRequired(data.zdrRequired);
      setDedicatedBaseUrl(data.dedicatedBaseUrl ?? data.trustedBaseUrls[0] ?? '');
    }
  }, [settingsQuery.data]);

  const config: IAdaptiveSettings | null = settingsQuery.data ?? null;

  const handleSave = async () => {
    setSaving(true);
    setResult(null);
    try {
      const patch: IAdaptiveSettingsPatch = {
        enabled,
        model,
        allowedEmails,
        dailySessionsLimit: dailyLimit,
        connectionMode,
        zdrRequired,
      };
      // Ключ и URL — атомарная пара; маска никогда не отправляется как ключ.
      if (connectionMode === 'dedicated_proxy' && dedicatedKey && !/^[•*]+$/.test(dedicatedKey)) {
        patch.dedicated = { apiKey: dedicatedKey, baseUrl: dedicatedBaseUrl };
      }
      await adaptiveTestingService.saveSettings(patch);
      setDedicatedKey('');
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setResult({ ok: true, msg: 'Настройки сохранены' });
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : 'Ошибка сохранения' });
    } finally {
      setSaving(false);
    }
  };

  const handleHealthCheck = async (withZdr: boolean) => {
    setChecking(true);
    setResult(null);
    try {
      const res = await adaptiveTestingService.healthCheck(withZdr);
      if (res.ok) {
        setResult({ ok: true, msg: `Luna отвечает${withZdr ? ' (ZDR подтверждён)' : ''}: ${res.model ?? ''}` });
      } else {
        const reason = res.configReason ? ` [${res.configReason}]` : '';
        setResult({ ok: false, msg: `${res.error ?? 'Проверка не пройдена'}${reason}` });
      }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : 'Ошибка проверки' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Адаптивное тестирование (OpenRouter)</h2>
        <span className={`${styles.statusBadge} ${config?.enabled ? styles.statusConnected : styles.statusDisconnected}`}>
          {config?.enabled ? 'Включено' : 'Выключено'}
        </span>
      </div>

      <p className={styles.description}>
        Тестирование знаний в ЛК: 10 вопросов от модели GPT-5.6 Luna по профилю отдела и должности.
        Кнопка «Тест» видна только сотрудникам из списка разрешённых email.
        По умолчанию используется общее подключение блока «Распознавание чеков» (ключ и Base URL);
        выключение распознавания чеков тестирование не останавливает.
      </p>

      <div className={styles.formGrid}>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Включено</label>
          <select className={styles.formInput} value={enabled ? 'true' : 'false'} onChange={e => setEnabled(e.target.value === 'true')}>
            <option value="true">Да</option>
            <option value="false">Нет</option>
          </select>
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Модель</label>
          <select className={styles.formInput} value={model} onChange={e => setModel(e.target.value)}>
            {(config?.allowedModels ?? []).map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className={styles.formGroupFull}>
          <label className={styles.formLabel}>Разрешённые email (CSV; пусто — никому; * — всем с правом)</label>
          <input
            className={styles.formInput}
            value={allowedEmails}
            onChange={e => setAllowedEmails(e.target.value)}
            placeholder="esenov.m.n@su10.ru"
          />
          <span className={styles.hint}>
            «*» разрешено только после включения ZDR и успешной проверки с ZDR.
          </span>
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Сессий в сутки на сотрудника</label>
          <input
            className={styles.formInput}
            type="number"
            min={1}
            max={10}
            value={dailyLimit}
            onChange={e => setDailyLimit(Number.parseInt(e.target.value, 10) || 1)}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Требовать ZDR-роутинг</label>
          <select className={styles.formInput} value={zdrRequired ? 'true' : 'false'} onChange={e => setZdrRequired(e.target.value === 'true')}>
            <option value="false">Нет</option>
            <option value="true">Да</option>
          </select>
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Подключение</label>
          <select
            className={styles.formInput}
            value={connectionMode}
            onChange={e => setConnectionMode(e.target.value as 'shared_proxy' | 'dedicated_proxy')}
          >
            <option value="shared_proxy">Общее (как у чеков)</option>
            <option value="dedicated_proxy">Отдельный ключ и шлюз</option>
          </select>
          <span className={styles.hint}>Сейчас используется: {config?.effectiveBaseUrl ?? 'конфигурация не собирается'}</span>
        </div>
        {connectionMode === 'dedicated_proxy' && (
          <>
            <div className={styles.formGroupFull}>
              <label className={styles.formLabel}>Отдельный API-ключ</label>
              <input
                className={styles.formInput}
                type="password"
                value={dedicatedKey}
                onChange={e => setDedicatedKey(e.target.value)}
                placeholder={config?.hasDedicatedApiKey ? '•••••••• (установлен)' : 'sk-or-v1-...'}
                autoComplete="off"
              />
              <span className={styles.hint}>Хранится зашифрованным; при смене вводится вместе с Base URL.</span>
            </div>
            <div className={styles.formGroupFull}>
              <label className={styles.formLabel}>Base URL (только доверенные шлюзы)</label>
              <select className={styles.formInput} value={dedicatedBaseUrl} onChange={e => setDedicatedBaseUrl(e.target.value)}>
                {(config?.trustedBaseUrls ?? []).map(u => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      <div className={styles.actions}>
        <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
        <button className={styles.btnSecondary} onClick={() => handleHealthCheck(false)} disabled={checking}>
          {checking ? 'Проверка...' : 'Проверить Luna'}
        </button>
        <button className={styles.btnSecondary} onClick={() => handleHealthCheck(true)} disabled={checking}>
          Проверить с ZDR
        </button>
      </div>

      {result && (
        <div className={`${styles.testResult} ${result.ok ? styles.testSuccess : styles.testError}`}>
          {result.msg}
        </div>
      )}
    </div>
  );
};
