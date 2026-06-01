import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import styles from '../../pages/admin/Admin.module.css';

interface IProps {
  userId: string;
  /** true, если у пользователя is_admin (по выбранной роли). Иначе секция не рендерится. */
  isUserAdmin: boolean;
  /** Компактный режим — оставлен для совместимости вызывающих, на новой вёрстке не влияет. */
  compact?: boolean;
}

const arraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((v, i) => v === b[i]);
};

export const UserCompanyAccessSection: FC<IProps> = ({ userId, isUserAdmin }) => {
  const toast = useToast();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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

  // Сброс draft и закрытие popover'а при смене пользователя — иначе предыдущий выбор
  // утечёт в строку другого админа.
  useEffect(() => {
    setDraft(null);
    setOpen(false);
  }, [userId]);

  // Закрытие popover'а по клику/тапу вне (паттерн как в skud-поиске).
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent | TouchEvent) => {
      const node = wrapRef.current;
      if (!node) return;
      const target = event.target as Node | null;
      if (target && node.contains(target)) return;
      setOpen(false);
    };
    const escHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [open]);

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
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  if (!isUserAdmin) return null;

  const companiesList = companiesQuery.data || [];
  const isSystemAdmin = current.length === 0;
  const isLoading = companiesQuery.isLoading || userCompaniesQuery.isLoading;

  const selectedSet = new Set(initial);
  const companies = useMemo(() => {
    return [...companiesList].sort((a, b) => {
      const aSelected = selectedSet.has(a.id) ? 0 : 1;
      const bSelected = selectedSet.has(b.id) ? 0 : 1;
      return aSelected - bSelected;
    });
  }, [companiesList, initial]);

  const selectedNames = companies
    .filter(company => current.includes(company.id))
    .map(company => company.name);

  const triggerText = isLoading
    ? 'Загрузка…'
    : isSystemAdmin
      ? 'Системный администратор — все компании'
      : selectedNames.join(', ');

  return (
    <div className={styles.companyAccessWrap} ref={wrapRef}>
      <div className={styles.companyAccessLabel}>Компании администратора</div>
      <div className={styles.companyAccessHint}>
        Если ничего не выбрано — пользователь видит все компании. Выберите компании, чтобы ограничить зону доступа.
      </div>

      <div className={styles.companyAccessRow}>
        <div className={styles.companyAccessTriggerSlot}>
          <button
            type="button"
            className={`${styles.companyAccessTrigger} ${open ? styles.companyAccessTriggerOpen : ''}`}
            onClick={() => setOpen(prev => !prev)}
          >
            <span
              className={`${styles.companyAccessTriggerText} ${isSystemAdmin ? styles.companyAccessTriggerSystem : ''}`}
              title={isSystemAdmin ? undefined : selectedNames.join(', ')}
            >
              {triggerText}
            </span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`${styles.companyAccessChevron} ${open ? styles.companyAccessChevronOpen : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {open && (
            <div className={styles.companyAccessPopover}>
              {isLoading ? (
                <div className={styles.departmentAccessEmpty}>Загрузка…</div>
              ) : companies.length === 0 ? (
                <div className={styles.departmentAccessEmpty}>Компании не найдены</div>
              ) : (
                <div className={styles.companyAccessPopoverList}>
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
            </div>
          )}
        </div>

        {hasChanges && (
          <>
            <button
              type="button"
              className={styles.companyAccessConfirm}
              onClick={() => void handleSave()}
              disabled={saving}
              aria-label="Сохранить изменения"
              title="Сохранить"
            >
              <Check size={18} strokeWidth={2.5} />
            </button>
            <button
              type="button"
              className={styles.companyAccessRevert}
              onClick={() => setDraft(null)}
              disabled={saving}
              aria-label="Отменить изменения"
              title="Отменить"
            >
              <X size={18} strokeWidth={2.5} />
            </button>
          </>
        )}
      </div>
    </div>
  );
};
