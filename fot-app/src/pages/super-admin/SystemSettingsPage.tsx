import { type FC, useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { settingsService, type IR2Status, type ISigurMonitorSettings } from '../../services/settingsService';
import {
  getR2StatusQueryKey,
  getSigurMonitorSettingsQueryKey,
  useR2Status,
  useSigurMonitorSettings,
} from '../../hooks/useSettingsData';
import styles from './SystemSettingsPage.module.css';

export const SystemSettingsPage: FC = () => {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const queryClient = useQueryClient();
  const r2StatusQuery = useR2Status();
  const monitorSettingsQuery = useSigurMonitorSettings();
  const status: IR2Status | null = r2StatusQuery.data ?? null;

  // Form
  const [accountId, setAccountId] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [bucketName, setBucketName] = useState('fot-documents');
  const [monitorSettings, setMonitorSettings] = useState<ISigurMonitorSettings>({
    enabled: true,
    failureThreshold: 2,
    recoveryThreshold: 2,
    silenceWindowMinutes: 15,
    baselineLookbackDays: 28,
    baselineMinEvents: 5,
    alertCooldownMinutes: 60,
    timezone: 'Europe/Moscow',
  });
  const [monitorSaving, setMonitorSaving] = useState(false);
  const [monitorResult, setMonitorResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const loading = r2StatusQuery.isLoading || monitorSettingsQuery.isLoading;

  useEffect(() => {
    if (status?.bucket_name) {
      setBucketName(status.bucket_name);
    }
  }, [status?.bucket_name]);

  useEffect(() => {
    if (monitorSettingsQuery.data) {
      setMonitorSettings(monitorSettingsQuery.data);
    }
  }, [monitorSettingsQuery.data]);

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const data: Record<string, string> = {};
      if (accountId) data.account_id = accountId;
      if (accessKeyId) data.access_key_id = accessKeyId;
      if (secretAccessKey) data.secret_access_key = secretAccessKey;
      data.bucket_name = bucketName;

      await settingsService.saveR2(data);
      await queryClient.invalidateQueries({ queryKey: getR2StatusQueryKey() });
      setAccountId('');
      setAccessKeyId('');
      setSecretAccessKey('');
    } catch {
      setTestResult({ ok: false, msg: 'Ошибка сохранения' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await settingsService.testR2();
      if (result.connected) {
        setTestResult({ ok: true, msg: 'Подключение успешно!' });
      } else {
        setTestResult({ ok: false, msg: result.error || 'Не удалось подключиться' });
      }
    } catch {
      setTestResult({ ok: false, msg: 'Ошибка тестирования' });
    } finally {
      setTesting(false);
    }
  };

  const handleMonitorChange = <K extends keyof ISigurMonitorSettings>(key: K, value: ISigurMonitorSettings[K]) => {
    setMonitorSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveMonitor = async () => {
    setMonitorSaving(true);
    setMonitorResult(null);
    try {
      const next = await settingsService.saveSigurMonitorSettings(monitorSettings);
      setMonitorSettings(next);
      queryClient.setQueryData(getSigurMonitorSettingsQueryKey(), next);
      setMonitorResult({ ok: true, msg: 'Настройки мониторинга сохранены' });
    } catch {
      setMonitorResult({ ok: false, msg: 'Ошибка сохранения настроек мониторинга' });
    } finally {
      setMonitorSaving(false);
    }
  };

  if (loading) return <div className={styles.loading}>Загрузка...</div>;

  return (
    <div className={styles.page}>
      {/* R2 Storage */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Cloudflare R2 хранилище</h2>
          <span className={`${styles.statusBadge} ${status?.enabled ? styles.statusConnected : styles.statusDisconnected}`}>
            {status?.enabled ? 'Подключено' : 'Не подключено'}
          </span>
        </div>

        <p className={styles.description}>
          R2 используется для хранения файлов-вложений к заявкам и документам сотрудников.
          Создайте API-токен в Cloudflare Dashboard → R2 → Manage R2 API Tokens.
        </p>

        <div className={styles.formGrid}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Account ID</label>
            <input
              className={styles.formInput}
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              placeholder={status?.has_account_id ? '••• (установлен)' : 'Cloudflare Account ID'}
            />
            <span className={styles.hint}>Cloudflare Dashboard → Overview → Account ID</span>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Bucket Name</label>
            <input
              className={styles.formInput}
              value={bucketName}
              onChange={e => setBucketName(e.target.value)}
              placeholder="fot-documents"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Access Key ID</label>
            <input
              className={styles.formInput}
              value={accessKeyId}
              onChange={e => setAccessKeyId(e.target.value)}
              placeholder={status?.has_access_key ? '••• (установлен)' : 'Access Key ID из R2 API Token'}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Secret Access Key</label>
            <input
              className={styles.formInput}
              type="password"
              value={secretAccessKey}
              onChange={e => setSecretAccessKey(e.target.value)}
              placeholder={status?.has_secret_key ? '••• (установлен)' : 'Secret Access Key из R2 API Token'}
            />
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
          <button className={styles.btnSecondary} onClick={handleTest} disabled={testing}>
            {testing ? 'Проверка...' : 'Тест подключения'}
          </button>
        </div>

        {testResult && (
          <div className={`${styles.testResult} ${testResult.ok ? styles.testSuccess : styles.testError}`}>
            {testResult.msg}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Мониторинг Sigur</h2>
          <span className={`${styles.statusBadge} ${monitorSettings.enabled ? styles.statusConnected : styles.statusDisconnected}`}>
            {monitorSettings.enabled ? 'Включён' : 'Выключен'}
          </span>
        </div>

        <p className={styles.description}>
          Настройки мониторинга управляют открытием инцидентов по сбоям подключения и аномальному отсутствию событий Sigur.
        </p>

        <div className={styles.formGrid}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Мониторинг включён</label>
            <select
              className={styles.formInput}
              value={monitorSettings.enabled ? 'true' : 'false'}
              onChange={e => handleMonitorChange('enabled', e.target.value === 'true')}
            >
              <option value="true">Да</option>
              <option value="false">Нет</option>
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Таймзона</label>
            <input
              className={styles.formInput}
              value={monitorSettings.timezone}
              onChange={e => handleMonitorChange('timezone', e.target.value)}
              placeholder="Europe/Moscow"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Порог ошибок подряд</label>
            <input
              className={styles.formInput}
              type="number"
              min={1}
              value={monitorSettings.failureThreshold}
              onChange={e => handleMonitorChange('failureThreshold', Number(e.target.value) || 1)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Порог восстановления</label>
            <input
              className={styles.formInput}
              type="number"
              min={1}
              value={monitorSettings.recoveryThreshold}
              onChange={e => handleMonitorChange('recoveryThreshold', Number(e.target.value) || 1)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Окно тишины, минут</label>
            <input
              className={styles.formInput}
              type="number"
              min={1}
              value={monitorSettings.silenceWindowMinutes}
              onChange={e => handleMonitorChange('silenceWindowMinutes', Number(e.target.value) || 1)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Lookback baseline, дней</label>
            <input
              className={styles.formInput}
              type="number"
              min={1}
              value={monitorSettings.baselineLookbackDays}
              onChange={e => handleMonitorChange('baselineLookbackDays', Number(e.target.value) || 1)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Минимальный baseline</label>
            <input
              className={styles.formInput}
              type="number"
              min={1}
              value={monitorSettings.baselineMinEvents}
              onChange={e => handleMonitorChange('baselineMinEvents', Number(e.target.value) || 1)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Cooldown уведомлений, минут</label>
            <input
              className={styles.formInput}
              type="number"
              min={1}
              value={monitorSettings.alertCooldownMinutes}
              onChange={e => handleMonitorChange('alertCooldownMinutes', Number(e.target.value) || 1)}
            />
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={handleSaveMonitor} disabled={monitorSaving}>
            {monitorSaving ? 'Сохранение...' : 'Сохранить мониторинг'}
          </button>
        </div>

        {monitorResult && (
          <div className={`${styles.testResult} ${monitorResult.ok ? styles.testSuccess : styles.testError}`}>
            {monitorResult.msg}
          </div>
        )}
      </div>
    </div>
  );
};
