import { type FC, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  settingsService,
  type IR2Status,
  type ISigurMonitorSettings,
  type ITimesheetReminderSettings,
  type IEmployeeTransferSettings,
} from '../../services/settingsService';
import { rolesService } from '../../services/rolesService';
import {
  getR2StatusQueryKey,
  getSigurMonitorSettingsQueryKey,
  getTimesheetReminderSettingsQueryKey,
  getEmployeeTransferSettingsQueryKey,
  getDashboardSettingsQueryKey,
  useR2Status,
  useSigurMonitorSettings,
  useTimesheetReminderSettings,
  useEmployeeTransferSettings,
  useDashboardSettings,
} from '../../hooks/useSettingsData';
import { OpenRouterSettingsSection } from '../../components/admin/OpenRouterSettingsSection';
import styles from './SystemSettingsPage.module.css';

export const SystemSettingsPage: FC = () => {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [s3Editing, setS3Editing] = useState(false);
  const queryClient = useQueryClient();
  const r2StatusQuery = useR2Status();
  const monitorSettingsQuery = useSigurMonitorSettings();
  const reminderSettingsQuery = useTimesheetReminderSettings();
  const employeeTransferSettingsQuery = useEmployeeTransferSettings();
  const status: IR2Status | null = r2StatusQuery.data ?? null;

  // Form
  const [accountId, setAccountId] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [bucketName, setBucketName] = useState('fot-documents');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [kmsKeyId, setKmsKeyId] = useState('');
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
  const [employeeTransferSettings, setEmployeeTransferSettings] = useState<IEmployeeTransferSettings>({
    freezeHistory: false,
  });
  const [employeeTransferSaving, setEmployeeTransferSaving] = useState(false);
  const [employeeTransferResult, setEmployeeTransferResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const dashboardSettingsQuery = useDashboardSettings();
  const roleLabelsQuery = useQuery({
    queryKey: ['roles', 'labels'],
    queryFn: () => rolesService.getLabels(),
    staleTime: 5 * 60_000,
  });
  const [managerRoleCodes, setManagerRoleCodes] = useState<string[]>([]);
  const [dashboardSaving, setDashboardSaving] = useState(false);
  const [dashboardResult, setDashboardResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const loading = r2StatusQuery.isLoading
    || monitorSettingsQuery.isLoading
    || reminderSettingsQuery.isLoading
    || employeeTransferSettingsQuery.isLoading
    || dashboardSettingsQuery.isLoading;

  useEffect(() => {
    if (status?.bucket_name) {
      setBucketName(status.bucket_name);
    }
  }, [status?.bucket_name]);

  useEffect(() => {
    if (status) {
      setAccountId(status.account_id || '');
      setEndpoint(status.endpoint || '');
      setRegion(status.region || '');
      setForcePathStyle(!!status.force_path_style);
      setKmsKeyId(status.kms_key_id || '');
    }
  }, [status?.account_id, status?.endpoint, status?.region, status?.force_path_style, status?.kms_key_id]);

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
    if (employeeTransferSettingsQuery.data) {
      setEmployeeTransferSettings(employeeTransferSettingsQuery.data);
    }
  }, [employeeTransferSettingsQuery.data]);

  useEffect(() => {
    if (dashboardSettingsQuery.data) {
      setManagerRoleCodes(dashboardSettingsQuery.data.managerRoleCodes);
    }
  }, [dashboardSettingsQuery.data]);

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const data: {
        account_id?: string;
        access_key_id?: string;
        secret_access_key?: string;
        bucket_name?: string;
        endpoint?: string;
        region?: string;
        force_path_style?: boolean;
        kms_key_id?: string;
      } = {};
      data.account_id = accountId;
      if (accessKeyId) data.access_key_id = accessKeyId;
      if (secretAccessKey) data.secret_access_key = secretAccessKey;
      data.bucket_name = bucketName;
      data.endpoint = endpoint;
      data.region = region;
      data.force_path_style = forcePathStyle;
      data.kms_key_id = kmsKeyId;

      await settingsService.saveR2(data);
      await queryClient.invalidateQueries({ queryKey: getR2StatusQueryKey() });
      setAccessKeyId('');
      setSecretAccessKey('');
      setS3Editing(false);
    } catch {
      setTestResult({ ok: false, msg: 'Ошибка сохранения' });
    } finally {
      setSaving(false);
    }
  };

  const handleCancelS3Edit = () => {
    setS3Editing(false);
    setAccessKeyId('');
    setSecretAccessKey('');
    setTestResult(null);
    if (status) {
      setAccountId(status.account_id || '');
      setBucketName(status.bucket_name || 'fot-documents');
      setEndpoint(status.endpoint || '');
      setRegion(status.region || '');
      setForcePathStyle(!!status.force_path_style);
      setKmsKeyId(status.kms_key_id || '');
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

  const handleSaveEmployeeTransferSettings = async () => {
    setEmployeeTransferSaving(true);
    setEmployeeTransferResult(null);
    try {
      const next = await settingsService.saveEmployeeTransferSettings(employeeTransferSettings);
      setEmployeeTransferSettings(next);
      queryClient.setQueryData(getEmployeeTransferSettingsQueryKey(), next);
      setEmployeeTransferResult({ ok: true, msg: 'Настройки заморозки истории переводов сохранены' });
    } catch {
      setEmployeeTransferResult({ ok: false, msg: 'Ошибка сохранения настроек заморозки истории переводов' });
    } finally {
      setEmployeeTransferSaving(false);
    }
  };

  const toggleManagerRole = (code: string) => {
    setManagerRoleCodes(prev => (prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]));
  };

  const handleSaveDashboardSettings = async () => {
    setDashboardSaving(true);
    setDashboardResult(null);
    try {
      const next = await settingsService.saveDashboardSettings({ managerRoleCodes });
      setManagerRoleCodes(next.managerRoleCodes);
      queryClient.setQueryData(getDashboardSettingsQueryKey(), next);
      setDashboardResult({ ok: true, msg: 'Роли руководителей сохранены' });
    } catch {
      setDashboardResult({ ok: false, msg: 'Ошибка сохранения ролей руководителей' });
    } finally {
      setDashboardSaving(false);
    }
  };

  if (loading) return <div className={styles.loading}>Загрузка...</div>;

  return (
    <div className={styles.page}>
      {/* S3-compatible Storage */}
      {status?.enabled && !s3Editing ? (
        <div className={`${styles.section} ${styles.sectionCollapsed}`}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>S3-совместимое хранилище (R2 / Cloud.ru / др.)</h2>
            <div className={styles.headerRight}>
              <span className={`${styles.statusBadge} ${styles.statusConnected}`}>Подключено</span>
              <button className={styles.btnEdit} onClick={() => setS3Editing(true)}>Редактировать</button>
            </div>
          </div>
          <div className={styles.summaryLine}>
            <span><b>Bucket:</b>{status.bucket_name || '—'}</span>
            {status.endpoint
              ? <span><b>Endpoint:</b>{status.endpoint}</span>
              : status.account_id && <span><b>Account ID:</b>{status.account_id.slice(0, 8)}…</span>
            }
            {status.region && <span><b>Region:</b>{status.region}</span>}
            {status.has_kms_key && <span><b>KMS:</b>включён</span>}
          </div>
        </div>
      ) : (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>S3-совместимое хранилище (R2 / Cloud.ru / др.)</h2>
          <span className={`${styles.statusBadge} ${status?.enabled ? styles.statusConnected : styles.statusDisconnected}`}>
            {status?.enabled ? 'Подключено' : 'Не подключено'}
          </span>
        </div>

        <p className={styles.description}>
          Хранилище для файлов-вложений к заявкам и документам сотрудников.
          Для Cloudflare R2 — укажите Account ID. Для Cloud.ru и других S3-совместимых провайдеров — укажите Endpoint URL, Region и включите Path-style URL.
        </p>

        <div className={styles.formGrid}>
          <div className={styles.formGroupFull}>
            <label className={styles.formLabel}>Endpoint URL</label>
            <input
              className={styles.formInput}
              value={endpoint}
              onChange={e => setEndpoint(e.target.value)}
              placeholder="https://s3.cloud.ru (оставьте пустым для Cloudflare R2)"
            />
            <span className={styles.hint}>Для Cloud.ru: https://s3.cloud.ru. Для R2 — можно оставить пустым и указать Account ID.</span>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Account ID (для R2)</label>
            <input
              className={styles.formInput}
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              placeholder="Cloudflare Account ID"
            />
            <span className={styles.hint}>Только для Cloudflare R2 (Dashboard → Overview → Account ID). Оставьте пустым для Cloud.ru и других S3-совместимых провайдеров.</span>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Region</label>
            <input
              className={styles.formInput}
              value={region}
              onChange={e => setRegion(e.target.value)}
              placeholder="auto"
            />
            <span className={styles.hint}>R2: auto. Cloud.ru: уточните в консоли (например, ru-central-1).</span>
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
              placeholder={status?.has_access_key ? '••• (установлен)' : 'S3 Access Key ID'}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Secret Access Key</label>
            <input
              className={styles.formInput}
              type="password"
              value={secretAccessKey}
              onChange={e => setSecretAccessKey(e.target.value)}
              placeholder={status?.has_secret_key ? '••• (установлен)' : 'S3 Secret Access Key'}
            />
          </div>
          <div className={styles.formGroupFull}>
            <label className={styles.formLabel}>Идентификатор симметричного ключа шифрования (KMS Key ID)</label>
            <input
              className={styles.formInput}
              value={kmsKeyId}
              onChange={e => setKmsKeyId(e.target.value)}
              placeholder="Например: 12345678-1234-1234-1234-123456789abc"
            />
            <span className={styles.hint}>
              Включает SSE-KMS (aws:kms) шифрование всех новых загрузок. Для Cloud.ru требуется роль sckm.user на указанный ключ. Оставьте пустым — шифрование не применяется.
            </span>
          </div>
          <div className={styles.formGroupFull}>
            <div className={styles.checkboxRow}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={forcePathStyle}
                  onChange={e => setForcePathStyle(e.target.checked)}
                />
                Path-style URL (включить для Cloud.ru и большинства не-R2 провайдеров)
              </label>
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
          <button className={styles.btnSecondary} onClick={handleTest} disabled={testing}>
            {testing ? 'Проверка...' : 'Тест подключения'}
          </button>
          {status?.enabled && (
            <button className={styles.btnSecondary} onClick={handleCancelS3Edit} disabled={saving}>
              Отмена
            </button>
          )}
        </div>

        {testResult && (
          <div className={`${styles.testResult} ${testResult.ok ? styles.testSuccess : styles.testError}`}>
            {testResult.msg}
          </div>
        )}
      </div>
      )}

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
          <h2 className={styles.sectionTitle}>Заморозка истории переводов</h2>
          <span className={`${styles.statusBadge} ${employeeTransferSettings.freezeHistory ? styles.statusConnected : styles.statusDisconnected}`}>
            {employeeTransferSettings.freezeHistory ? 'Включена' : 'Выключена'}
          </span>
        </div>

        <p className={styles.description}>
          На время финальной сборки списков сотрудников. При включении переводы (и через
          «Управление кадрами», и через Sigur sync) только обновляют текущее открытое назначение
          в employee_assignments — без закрытия старого и создания нового от текущей даты. После
          того как списки финализированы — обязательно выключить, чтобы дальше копить историю штатно.
        </p>

        <div className={styles.checkboxRow}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={employeeTransferSettings.freezeHistory}
              onChange={e => setEmployeeTransferSettings({ freezeHistory: e.target.checked })}
            />
            <span>Не писать историю при изменении отдела/должности</span>
          </label>
        </div>

        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={handleSaveEmployeeTransferSettings} disabled={employeeTransferSaving}>
            {employeeTransferSaving ? 'Сохранение...' : 'Сохранить настройку'}
          </button>
        </div>

        {employeeTransferResult && (
          <div className={`${styles.testResult} ${employeeTransferResult.ok ? styles.testSuccess : styles.testError}`}>
            {employeeTransferResult.msg}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Дашборд HR · роли руководителей</h2>
          <span className={`${styles.statusBadge} ${managerRoleCodes.length > 0 ? styles.statusConnected : styles.statusDisconnected}`}>
            Выбрано: {managerRoleCodes.length}
          </span>
        </div>

        <p className={styles.description}>
          Какие роли считаются «руководителями» в «Карте руководителей» дашборда HR-табелей.
          Влияет и на список «Отделы без ответственного».
        </p>

        {(roleLabelsQuery.data ?? []).filter(r => !r.is_admin).map(r => (
          <div className={styles.checkboxRow} key={r.code}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={managerRoleCodes.includes(r.code)}
                onChange={() => toggleManagerRole(r.code)}
              />
              <span>{r.name} ({r.code})</span>
            </label>
          </div>
        ))}

        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={handleSaveDashboardSettings} disabled={dashboardSaving}>
            {dashboardSaving ? 'Сохранение...' : 'Сохранить роли'}
          </button>
        </div>

        {dashboardResult && (
          <div className={`${styles.testResult} ${dashboardResult.ok ? styles.testSuccess : styles.testError}`}>
            {dashboardResult.msg}
          </div>
        )}
      </div>

      <OpenRouterSettingsSection />

    </div>
  );
};
