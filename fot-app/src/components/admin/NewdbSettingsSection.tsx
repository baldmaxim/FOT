import { type FC, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { checksService } from '../../services/checksService';
import styles from '../../pages/admin/SystemSettingsPage.module.css';

const MASK = '••••••••';

export const NewdbSettingsSection: FC = () => {
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['newdb', 'settings'],
    queryFn: () => checksService.getConnectionSettings(),
    retry: false,
  });

  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Мягкий 403: нет доступа к настройкам проверок — не ломаем всю страницу.
  if (settingsQuery.isError && settingsQuery.error instanceof ApiError && settingsQuery.error.status === 403) {
    return (
      <div className={`${styles.section} ${styles.sectionCollapsed}`}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Проверки РКЛ / Патент (newdb.net)</h2>
          <span className={styles.hint}>Нет доступа к настройкам проверок</span>
        </div>
      </div>
    );
  }

  const config = settingsQuery.data ?? null;
  const hasToken = !!config?.hasToken;

  const handleSave = async () => {
    setSaving(true);
    setResult(null);
    try {
      // Пустое поле = «не менять»: включаем token в patch только если задан и не маска.
      const patch: { token?: string } = {};
      const trimmed = token.trim();
      if (trimmed && trimmed !== MASK) patch.token = trimmed;
      await checksService.saveConnectionSettings(patch);
      setToken(''); // не держим токен в DOM дольше нужного
      await queryClient.invalidateQueries({ queryKey: ['newdb', 'settings'] });
      setResult({ ok: true, msg: patch.token ? 'Токен сохранён' : 'Изменений нет (поле пустое)' });
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : 'Ошибка сохранения' });
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    setResult(null);
    try {
      const r = await checksService.validateConnection();
      setResult(r.ok
        ? { ok: true, msg: `Настройки в порядке · ${r.baseUrl}` }
        : { ok: false, msg: `Проблемы: ${r.problems.join('; ')}` });
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : 'Ошибка валидации' });
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Проверки РКЛ / Патент (newdb.net)</h2>
        <span className={`${styles.statusBadge} ${hasToken ? styles.statusConnected : styles.statusDisconnected}`}>
          {hasToken ? 'Токен задан' : 'Токен не задан'}
        </span>
      </div>

      <p className={styles.description}>
        Проверка иностранных граждан по реестру контролируемых лиц (РКЛ) и патентам через API newdb.net.
        Токен (X-API-KEY) хранится в зашифрованном виде. Базовый URL: <code>{config?.baseUrl ?? '—'}</code>.
        Запуск проверок — во вкладке «Проверки».
      </p>

      <div className={styles.formGrid}>
        <div className={styles.formGroupFull}>
          <label className={styles.formLabel}>API-токен (X-API-KEY)</label>
          <input
            className={styles.formInput}
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={hasToken ? '•••••••• (задан)' : 'Вставьте API-токен'}
            autoComplete="off"
          />
          <span className={styles.hint}>
            Источник: {config?.source === 'system_settings' ? 'настройки' : config?.source === 'env' ? '.env' : 'не задан'}
          </span>
        </div>
      </div>

      <div className={styles.actions}>
        <button className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
        <button className={styles.btnSecondary} onClick={handleValidate} disabled={validating}>
          {validating ? 'Проверка...' : 'Проверить настройки'}
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
