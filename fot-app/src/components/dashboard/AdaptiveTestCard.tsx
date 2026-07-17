import { type FC, lazy, Suspense, useState } from 'react';
import { BrainCircuit } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { adaptiveTestingService } from '../../services/adaptiveTestingService';
import styles from './TestPromptCard.module.css';

const AdaptiveTestModal = lazy(() =>
  import('../adaptive-testing/AdaptiveTestModal').then(m => ({ default: m.AdaptiveTestModal })),
);

export const ADAPTIVE_AVAILABILITY_QUERY_KEY = ['adaptive-testing', 'availability'] as const;

/**
 * Карточка «Тестирование» в ЛК. Кнопка запуска — строго «Тест»
 * (при активной сессии — «Продолжить тест»). Availability запрашивается
 * только при праве на страницу — роли без права не создают фоновые 403.
 */
export const AdaptiveTestCard: FC = () => {
  const { canViewPage } = useAuth();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const hasAccess = canViewPage('/employee/testing');

  const availabilityQuery = useQuery({
    queryKey: ADAPTIVE_AVAILABILITY_QUERY_KEY,
    queryFn: adaptiveTestingService.getAvailability,
    enabled: hasAccess,
    staleTime: 30_000,
  });

  if (!hasAccess) return null;
  const availability = availabilityQuery.data;
  if (!availability) return null;

  const hasActive = Boolean(availability.activeSessionId);
  // Вне allowlist без активной сессии карточка скрыта; с активной — остаётся
  // («Продолжить тест» доступен и после удаления из allowlist).
  if (!availability.available && !hasActive) return null;

  const limitReached = !hasActive && !availability.canStartNew;

  const handleClose = () => {
    setModalOpen(false);
    void queryClient.invalidateQueries({ queryKey: ADAPTIVE_AVAILABILITY_QUERY_KEY });
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <BrainCircuit size={16} className={styles.icon} />
        <h3 className={styles.title}>Тестирование</h3>
      </div>
      <p className={styles.hint}>
        Проверка знаний по обязанностям вашей должности: 10 вопросов.
        Ответы обрабатываются ИИ — не указывайте персональные данные.
      </p>
      <button
        type="button"
        className={styles.testBtn}
        disabled={limitReached}
        onClick={() => setModalOpen(true)}
      >
        <span className={styles.testTitle}>{hasActive ? 'Продолжить тест' : 'Тест'}</span>
      </button>
      {limitReached && (
        <p className={styles.hint}>Дневной лимит тестирований исчерпан — возвращайтесь завтра.</p>
      )}

      {modalOpen && (
        <Suspense fallback={null}>
          <AdaptiveTestModal
            hasActiveSession={hasActive}
            onClose={handleClose}
          />
        </Suspense>
      )}
    </div>
  );
};
