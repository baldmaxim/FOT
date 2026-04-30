import { type FC, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { dailyTaskService } from '../../services/dailyTaskService';
import {
  getMyDailyTasksQueryKey,
  getTodayDailyTaskQueryKey,
  useTodayDailyTask,
} from '../../hooks/usePortalData';
import styles from './DailyTasksCard.module.css';

const formatToday = (): string =>
  new Date().toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  });

const formatSavedAt = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export const DailyTasksCard: FC = () => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: todayTask, isLoading } = useTodayDailyTask();

  const [text, setText] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!hydrated && !isLoading) {
      setText(todayTask?.content ?? '');
      setHydrated(true);
    }
  }, [hydrated, isLoading, todayTask]);

  const dateLabel = useMemo(formatToday, []);
  const savedAtLabel = todayTask?.updated_at ? formatSavedAt(todayTask.updated_at) : null;

  const trimmed = text.trim();
  const dirty = trimmed !== (todayTask?.content ?? '').trim();
  const canSave = !saving && dirty && trimmed.length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await dailyTaskService.save(trimmed);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getTodayDailyTaskQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getMyDailyTasksQueryKey() }),
      ]);
      showToast('success', 'Задачи сохранены');
    } catch (err) {
      console.error('daily-tasks save error:', err);
      showToast('error', 'Не удалось сохранить задачи');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <h3 className={styles.title}>Задачи на сегодня</h3>
        <span className={styles.dateBadge}>{dateLabel}</span>
      </div>
      <p className={styles.hint}>Опишите, что сделали за день. Можно дополнять до полуночи.</p>
      {isLoading && !hydrated ? (
        <div className={styles.loading}>Загрузка...</div>
      ) : (
        <textarea
          className={styles.textarea}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Например: Подготовил отчёт по продажам, провёл встречу с подрядчиком..."
          maxLength={5000}
        />
      )}
      <div className={styles.footer}>
        <span className={styles.savedAt}>
          {savedAtLabel ? `Обновлено в ${savedAtLabel}` : 'Ещё не сохранено'}
        </span>
        <button className={styles.saveBtn} onClick={handleSave} disabled={!canSave}>
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
};
