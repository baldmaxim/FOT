import { type FC, lazy, Suspense, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { useAvailableTests } from '../../hooks/usePortalData';
import styles from './TestPromptCard.module.css';

const TestTakingModal = lazy(() =>
  import('../tests/TestTakingModal').then(m => ({ default: m.TestTakingModal })),
);

export const TestPromptCard: FC = () => {
  const { data: tests } = useAvailableTests();
  const [activeTestId, setActiveTestId] = useState<string | null>(null);

  // Показываем только если есть назначенные непройденные тесты (или черновики).
  const pending = (tests ?? []).filter(t => t.my_status !== 'submitted');
  if (pending.length === 0) return null;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <ClipboardList size={16} className={styles.icon} />
        <h3 className={styles.title}>Тестирование</h3>
      </div>
      <p className={styles.hint}>Для вашего отдела назначены тесты.</p>
      <div className={styles.list}>
        {pending.map(t => (
          <button
            key={t.id}
            type="button"
            className={styles.testBtn}
            onClick={() => setActiveTestId(t.id)}
          >
            <span className={styles.testTitle}>{t.title}</span>
            {t.my_status === 'draft' && <span className={styles.draftBadge}>черновик</span>}
          </button>
        ))}
      </div>

      {activeTestId && (
        <Suspense fallback={null}>
          <TestTakingModal testId={activeTestId} onClose={() => setActiveTestId(null)} />
        </Suspense>
      )}
    </div>
  );
};
