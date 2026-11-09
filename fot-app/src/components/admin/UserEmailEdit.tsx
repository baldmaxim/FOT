import { useState } from 'react';
import type { FC } from 'react';
import { ClearableInput } from '../ui/ClearableInput';
import styles from '../../pages/admin/Admin.module.css';

interface IUserEmailEditProps {
  email: string;
  /** Право edit на /admin/users; без него — просто адрес. */
  canEdit: boolean;
  /** Сохраняет новую почту; при ошибке бросает — поле остаётся открытым. */
  onSave: (email: string) => Promise<void>;
}

/** Почта для входа в карточке пользователя: правка как у ФИО. */
export const UserEmailEdit: FC<IUserEmailEditProps> = ({ email, canEdit, onSave }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!canEdit) {
    return <span className={styles.emailEditText}>{email || '—'}</span>;
  }

  const handleSave = async () => {
    if (draft === null || saving) return;
    const next = draft.trim().toLowerCase();
    if (!next) return;
    if (next === email) {
      setDraft(null);
      return;
    }
    if (!confirm(`Сменить почту для входа: ${email} → ${next}?`)) return;
    setSaving(true);
    try {
      await onSave(next);
      setDraft(null);
    } catch {
      // Причину показал тост, поле остаётся открытым для исправления.
    } finally {
      setSaving(false);
    }
  };

  if (draft === null) {
    return (
      <button type="button" className={styles.editNameBtn} onClick={() => setDraft(email)}>
        <span className={styles.emailEditText}>{email || '—'}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
    );
  }

  return (
    <div className={styles.nameEditGroup}>
      <ClearableInput
        className={styles.emailEditField}
        type="email"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-label="Новая почта для входа"
        clearLabel="Очистить почту"
        value={draft}
        onValueChange={setDraft}
        disabled={saving}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleSave();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      <button type="button" className={styles.saveBtn} onClick={() => void handleSave()} disabled={saving}>
        Сохранить
      </button>
      <button type="button" className={styles.cancelBtn} onClick={() => setDraft(null)} disabled={saving}>
        Отмена
      </button>
    </div>
  );
};
