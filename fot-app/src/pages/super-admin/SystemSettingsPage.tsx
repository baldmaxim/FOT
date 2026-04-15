import { type FC, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  settingsService,
  type IR2Status,
  type ISigurMonitorSettings,
  type ITimesheetReminderSettings,
  type ITimesheetTeamManagementSettings,
} from '../../services/settingsService';
import {
  getR2StatusQueryKey,
  getSigurMonitorSettingsQueryKey,
  getTimesheetReminderSettingsQueryKey,
  getTimesheetTeamManagementSettingsQueryKey,
  useR2Status,
  useSigurMonitorSettings,
  useTimesheetReminderSettings,
  useTimesheetTeamManagementSettings,
} from '../../hooks/useSettingsData';
import styles from './SystemSettingsPage.module.css';

export const SystemSettingsPage: FC = () => {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const queryClient = useQueryClient();
  const r2StatusQuery = useR2Status();
  const monitorSettingsQuery = useSigurMonitorSettings();
  const reminderSettingsQuery = useTimesheetReminderSettings();
  const teamManagementSettingsQuery = useTimesheetTeamManagementSettings();
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
  const [reminderSettings, setReminderSettings] = useState<ITimesheetReminderSettings>({
    enabled: true,
    timezone: 'Europe/Moscow',
    openingReminderHour: 9,
    deadlineMorningHour: 10,
    deadlineAfternoonHour: 16,
    escalationHour: 17,
    overdueHour: 9,
  });
  const [reminderSaving, setReminderSaving] = useState(false);
  const [reminderResult, setReminderResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [teamManagementSettings, setTeamManagementSettings] = useState<ITimesheetTeamManagementSettings>({
    enabled: false,
  });
  const [teamManagementSaving, setTeamManagementSaving] = useState(false);
  const [teamManagementResult, setTeamManagementResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const loading = r2StatusQuery.isLoading
    || monitorSettingsQuery.isLoading
    || reminderSettingsQuery.isLoading
    || teamManagementSettingsQuery.isLoading;

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

  useEffect(() => {
    if (reminderSettingsQuery.data) {
      setReminderSettings(reminderSettingsQuery.data);
    }
  }, [reminderSettingsQuery.data]);

  useEffect(() => {
    if (teamManagementSettingsQuery.data) {
      setTeamManagementSettings(teamManagementSettingsQuery.data);
    }
  }, [teamManagementSettingsQuery.data]);

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

  const handleReminderChange = <K extends keyof ITimesheetReminderSettings>(key: K, value: ITimesheetReminderSettings[K]) => {
    setReminderSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveReminderSettings = async () => {
    setReminderSaving(true);
    setReminderResult(null);
    try {
      const next = await settingsService.saveTimesheetReminderSettings(reminderSettings);
      setReminderSettings(next);
      queryClient.setQueryData(getTimesheetReminderSettingsQueryKey(), next);
      setReminderResult({ ok: true, msg: 'Настройки напоминаний сохранены' });
    } catch {
      setReminderResult({ ok: false, msg: 'Ошибка сохранения настроек напоминаний' });
    } finally {
      setReminderSaving(false);
    }
  };

  const handleSaveTeamManagementSettings = async () => {
    setTeamManagementSaving(true);
    setTeamManagementResult(null);
    try {
      const next = await settingsService.saveTimesheetTeamManagementSettings(teamManagementSettings);
      setTeamManagementSettings(next);
      queryClient.setQueryData(getTimesheetTeamManagementSettingsQueryKey(), next);
      setTeamManagementResult({ ok: true, msg: 'Настройки управления составом табеля сохранены' });
    } catch {
      setTeamManagementResult({ ok: false, msg: 'Ошибка сохранения настроек управления составом табеля' });
    } finally {
      setTeamManagementSaving(false);
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

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Напоминания по табелю</h2>
          <span className={`${styles.statusBadge} ${reminderSettings.enabled ? styles.statusConnected : styles.statusDisconnected}`}>
            {reminderSettings.enabled ? 'Включены' : 'Выключены'}
          </span>
        </div>

        <p className={styles.description}>
          Система напоминает о подаче табеля два раза в месяц: за период 1-15 и 16-конец месяца.
        </p>

        <div className={styles.formGrid}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Напоминания включены</label>
            <select
              className={styles.formInput}
              value={reminderSettings.enabled ? 'true' : 'false'}
              onChange={e => handleReminderChange('enabled', e.target.value === 'true')}
            >
              <option value="true">Да</option>
              <option value="false">Нет</option>
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Таймзона</label>
            <input
              className={styles.formInput}
              value={reminderSettings.timezone}
              onChange={e => handleReminderChange('timezone', e.target.value)}
              placeholder="Europe/Moscow"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Открытие периода, час</label>
            <input
              className={styles.formInput}
              type="number"
              min={0}
              max={23}
              value={reminderSettings.openingReminderHour}
              onChange={e => handleReminderChange('openingReminderHour', Number(e.target.value) || 0)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Утренний дедлайн-напоминатель</label>
            <input
              className={styles.formInput}
              type="number"
              min={0}
              max={23}
              value={reminderSettings.deadlineMorningHour}
              onChange={e => handleReminderChange('deadlineMorningHour', Number(e.target.value) || 0)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Дневной дедлайн-напоминатель</label>
            <input
              className={styles.formInput}
              type="number"
              min={0}
              max={23}
              value={reminderSettings.deadlineAfternoonHour}
              onChange={e => handleReminderChange('deadlineAfternoonHour', Number(e.target.value) || 0)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Эскалация резервному, час</label>
            <input
              className={styles.formInput}
              type="number"
              min={0}
              max={23}
              value={reminderSettings.escalationHour}
              onChange={e => handleReminderChange('escalationHour', Number(e.target.value) || 0)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Просрочка руководителю, час</label>
            <input
              className={styles.formInput}
              type="number"
              min={0}
              max={23}
              value={reminderSettings.overdueHour}
              onChange={e => handleReminderChange('overdueHour', Number(e.target.value) || 0)}
            />
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={handleSaveReminderSettings} disabled={reminderSaving}>
            {reminderSaving ? 'Сохранение...' : 'Сохранить напоминания'}
          </button>
        </div>

        {reminderResult && (
          <div className={`${styles.testResult} ${reminderResult.ok ? styles.testSuccess : styles.testError}`}>
            {reminderResult.msg}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Управление составом табеля</h2>
          <span className={`${styles.statusBadge} ${teamManagementSettings.enabled ? styles.statusConnected : styles.statusDisconnected}`}>
            {teamManagementSettings.enabled ? 'Разрешено' : 'Закрыто'}
          </span>
        </div>

        <p className={styles.description}>
          Если настройка включена, руководители смогут на странице табеля вручную исключать сотрудников во внутренний архив и добавлять людей поиском с переводом в текущий отдел.
        </p>

        <div className={styles.checkboxRow}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={teamManagementSettings.enabled}
              onChange={e => setTeamManagementSettings({ enabled: e.target.checked })}
            />
            <span>Разрешить ручное управление составом сотрудников в табеле</span>
          </label>
        </div>

        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={handleSaveTeamManagementSettings} disabled={teamManagementSaving}>
            {teamManagementSaving ? 'Сохранение...' : 'Сохранить настройку'}
          </button>
        </div>

        {teamManagementResult && (
          <div className={`${styles.testResult} ${teamManagementResult.ok ? styles.testSuccess : styles.testError}`}>
            {teamManagementResult.msg}
          </div>
        )}
      </div>

    </div>
  );
};
