import { type FC, useState, useEffect, useCallback } from 'react';
import { settingsService, type IR2Status } from '../../services/settingsService';
import styles from './SystemSettingsPage.module.css';

export const SystemSettingsPage: FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<IR2Status | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Form
  const [accountId, setAccountId] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [bucketName, setBucketName] = useState('fot-documents');

  const load = useCallback(async () => {
    try {
      const s = await settingsService.getR2Status();
      setStatus(s);
      if (s.bucket_name) setBucketName(s.bucket_name);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
      await load();
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
    </div>
  );
};
