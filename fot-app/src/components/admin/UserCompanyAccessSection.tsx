import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import styles from '../../pages/admin/Admin.module.css';

interface IProps {
  userId: string;
  /** true, если у пользователя is_admin (по выбранной роли). Иначе секция не рендерится. */
  isUserAdmin: boolean;
  /** Компактный режим — меньше padding/font, ограниченный max-height списка. */
  compact?: boolean;
}

const arraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((v, i) => v === b[i]);
};

export const UserCompanyAccessSection: FC<IProps> = ({ userId, isUserAdmin, compact = false }) => {
  const toast = useToast();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const companiesQuery = useQuery({
    queryKey: ['admin-companies'],
    queryFn: () => adminService.listCompanies(),
    enabled: isUserAdmin,
    staleTime: 5 * 60_000,
  });

  const userCompaniesQuery = useQuery({
    queryKey: ['admin-user-companies', userId],
    queryFn: () => adminService.getUserCompanies(userId),
    enabled: isUserAdmin,
    staleTime: 30_000,
  });

  const initial = useMemo(
    () => userCompaniesQuery.data?.company_root_ids ?? [],
    [userCompaniesQuery.data?.company_root_ids],
  );

  useEffect(() => {
    setDraft(null);
  }, [userId]);

  const current = draft ?? initial;
  const hasChanges = !arraysEqual(current, initial);

  const toggle = (id: string) => {
    setDraft(() => {
      const set = new Set(current);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return [...set];
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await adminService.replaceUserCompanies(userId, current);
      setDraft(result.company_root_ids);
      toast.success(
        result.is_system_admin
          ? 'Снято — пользователь снова системный администратор'
          : 'Привязки компаний обновлены',
      );
      await userCompaniesQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  if (!isUserAdmin) return null;

  const companies = companiesQuery.data || [];
  const isSystemAdmin = current.length === 0;

  return (
    <div className={`${styles.departmentAccessSection} ${compact ? styles.departmentAccessSectionCompact : ''}`}>
      <div className={styles.departmentAccessHeader}>
        <div>
          <div className={styles.departmentAccessTitle}>Компании администратора</div>
          <div className={styles.departmentAccessHint}>
            Если ничего не выбрано — пользователь видит все компании (системный администратор).
            Выберите компании, чтобы ограничить зону доступа.
          </div>
        </div>
        <div className={styles.departmentAccessCount}>
          {isSystemAdmin ? 'все' : `${current.length} выбрано`}
        </div>
      </div>

      {companiesQuery.isLoading || userCompaniesQuery.isLoading ? (
        <div className={styles.departmentAccessEmpty}>Загрузка…</div>
      ) : companies.length === 0 ? (
        <div className={styles.departmentAccessEmpty}>Компании не найдены</div>
      ) : (
        <div className={styles.departmentAccessList}>
          {companies.map(company => {
            const checked = current.includes(company.id);
            return (
              <label
                key={company.id}
                className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(company.id)}
                />
                <span className={styles.departmentAccessItemLabel}>{company.name}</span>
              </label>
            );
          })}
        </div>
      )}

      <div className={styles.departmentAccessActions}>
        <button
          type="button"
          className={styles.cancelBtn}
          onClick={() => setDraft(null)}
          disabled={!hasChanges || saving}
        >
          Сбросить
        </button>
        <button
          type="button"
          className={styles.saveBtn}
          onClick={() => void handleSave()}
          disabled={!hasChanges || saving}
        >
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
};
