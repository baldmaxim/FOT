import { type FC, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  settingsService,
  type IR2Status,
  type ISigurMonitorSettings,
  type ITimesheetReminderSettings,
} from '../../services/settingsService';
import {
  getR2StatusQueryKey,
  getSigurMonitorSettingsQueryKey,
  getTimesheetReminderSettingsQueryKey,
  useR2Status,
  useSigurMonitorSettings,
  useTimesheetReminderSettings,
} from '../../hooks/useSettingsData';
import {
  getTimesheetResponsibleCandidatesQueryKey,
  getTimesheetResponsiblesQueryKey,
} from '../../hooks/useTimesheetApprovalData';
import { useStructureTree } from '../../hooks/useStructure';
import { timesheetApprovalService, type ITimesheetResponsibleCandidate } from '../../services/timesheetApprovalService';
import styles from './SystemSettingsPage.module.css';

export const SystemSettingsPage: FC = () => {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const queryClient = useQueryClient();
  const r2StatusQuery = useR2Status();
  const monitorSettingsQuery = useSigurMonitorSettings();
  const reminderSettingsQuery = useTimesheetReminderSettings();
  const structureQuery = useStructureTree();
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
  const [selectedDepartmentId, setSelectedDepartmentId] = useState('');
  const [primaryUserId, setPrimaryUserId] = useState('');
  const [backupUserId, setBackupUserId] = useState('');
  const [responsiblesSaving, setResponsiblesSaving] = useState(false);
  const [responsiblesResult, setResponsiblesResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const departments = useMemo(() => {
    const flatten = (nodes: Array<{ id: string; name: string; children?: unknown[] }>): Array<{ id: string; name: string }> => {
      const result: Array<{ id: string; name: string }> = [];
      for (const node of nodes) {
        result.push({ id: node.id, name: node.name });
        if (Array.isArray(node.children)) {
          result.push(...flatten(node.children as Array<{ id: string; name: string; children?: unknown[] }>));
        }
      }
      return result;
    };

    return flatten(structureQuery.data?.departments ?? []).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [structureQuery.data]);

  const responsiblesQuery = useQuery({
    queryKey: getTimesheetResponsiblesQueryKey(selectedDepartmentId || null),
    queryFn: () => timesheetApprovalService.getResponsibles(selectedDepartmentId),
    enabled: selectedDepartmentId.length > 0,
    staleTime: 60_000,
  });

  const candidatesQuery = useQuery({
    queryKey: getTimesheetResponsibleCandidatesQueryKey(selectedDepartmentId || null),
    queryFn: () => timesheetApprovalService.getResponsibleCandidates(selectedDepartmentId),
    enabled: selectedDepartmentId.length > 0,
    staleTime: 60_000,
  });

  const candidates: ITimesheetResponsibleCandidate[] = candidatesQuery.data ?? [];
  const loading = r2StatusQuery.isLoading || monitorSettingsQuery.isLoading || reminderSettingsQuery.isLoading || structureQuery.isLoading;

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
    if (!selectedDepartmentId && departments.length > 0) {
      setSelectedDepartmentId(departments[0].id);
    }
  }, [departments, selectedDepartmentId]);

  useEffect(() => {
    const responsibles = responsiblesQuery.data ?? [];
    const primary = responsibles.find(item => item.role === 'primary')?.user_id || '';
    const backup = responsibles.find(item => item.role === 'backup')?.user_id || '';
    setPrimaryUserId(primary);
    setBackupUserId(backup);
  }, [responsiblesQuery.data, selectedDepartmentId]);

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

  const handleSaveResponsibles = async () => {
    if (!selectedDepartmentId) return;
    if (primaryUserId && primaryUserId === backupUserId) {
      setResponsiblesResult({ ok: false, msg: 'Основной и резервный ответственные должны отличаться' });
      return;
    }

    setResponsiblesSaving(true);
    setResponsiblesResult(null);
    try {
      await timesheetApprovalService.saveResponsibles({
        department_id: selectedDepartmentId,
        primary_user_id: primaryUserId || null,
        backup_user_id: backupUserId || null,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getTimesheetResponsiblesQueryKey(selectedDepartmentId) }),
        queryClient.invalidateQueries({ queryKey: getTimesheetResponsibleCandidatesQueryKey(selectedDepartmentId) }),
      ]);
      setResponsiblesResult({ ok: true, msg: 'Ответственные по табелю сохранены' });
    } catch {
      setResponsiblesResult({ ok: false, msg: 'Ошибка сохранения ответственных по табелю' });
    } finally {
      setResponsiblesSaving(false);
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
            <label className={styles.formLabel}>Просрочка в HR, час</label>
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
          <h2 className={styles.sectionTitle}>Ответственные за табель</h2>
        </div>

        <p className={styles.description}>
          Для каждого отдела назначьте основного и резервного ответственного. Напоминания и эскалации будут уходить именно им.
        </p>

        <div className={styles.formGrid}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Отдел</label>
            <select
              className={styles.formInput}
              value={selectedDepartmentId}
              onChange={e => setSelectedDepartmentId(e.target.value)}
            >
              {departments.map(department => (
                <option key={department.id} value={department.id}>{department.name}</option>
              ))}
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Основной ответственный</label>
            <select
              className={styles.formInput}
              value={primaryUserId}
              onChange={e => setPrimaryUserId(e.target.value)}
              disabled={candidatesQuery.isLoading}
            >
              <option value="">Не назначен</option>
              {candidates.map(candidate => (
                <option key={candidate.user_id} value={candidate.user_id}>
                  {candidate.full_name || `Пользователь ${candidate.user_id}`}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Резервный ответственный</label>
            <select
              className={styles.formInput}
              value={backupUserId}
              onChange={e => setBackupUserId(e.target.value)}
              disabled={candidatesQuery.isLoading}
            >
              <option value="">Не назначен</option>
              {candidates.map(candidate => (
                <option key={candidate.user_id} value={candidate.user_id}>
                  {candidate.full_name || `Пользователь ${candidate.user_id}`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={handleSaveResponsibles} disabled={responsiblesSaving || !selectedDepartmentId}>
            {responsiblesSaving ? 'Сохранение...' : 'Сохранить ответственных'}
          </button>
        </div>

        {candidatesQuery.isLoading && <div className={styles.testResult}>Загрузка сотрудников отдела...</div>}
        {!candidatesQuery.isLoading && selectedDepartmentId && candidates.length === 0 && (
          <div className={`${styles.testResult} ${styles.testError}`}>
            В выбранном отделе нет одобренных пользователей, которых можно назначить ответственными.
          </div>
        )}
        {responsiblesResult && (
          <div className={`${styles.testResult} ${responsiblesResult.ok ? styles.testSuccess : styles.testError}`}>
            {responsiblesResult.msg}
          </div>
        )}
      </div>
    </div>
  );
};
