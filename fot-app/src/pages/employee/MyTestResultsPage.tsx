import { type FC, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BrainCircuit, ChevronDown, ChevronUp } from 'lucide-react';
import {
  adaptiveTestingService,
  type IAdaptiveResultDetail,
} from '../../services/adaptiveTestingService';
import styles from './MyTestResultsPage.module.css';

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

const statusLabel = (status: string): string => {
  switch (status) {
    case 'completed': return 'Завершён';
    case 'error': return 'Прерван (ошибка)';
    case 'cancelled': return 'Отменён';
    default: return status;
  }
};

const ResultDetail: FC<{ sessionId: string }> = ({ sessionId }) => {
  const detailQuery = useQuery<IAdaptiveResultDetail>({
    queryKey: ['adaptive-testing', 'my-result', sessionId],
    queryFn: () => adaptiveTestingService.getMyResultDetail(sessionId),
    staleTime: 5 * 60_000,
  });

  if (detailQuery.isLoading) return <div className={styles.detailLoading}>Загрузка…</div>;
  const detail = detailQuery.data;
  if (!detail) return <div className={styles.detailLoading}>Не удалось загрузить результат.</div>;

  return (
    <div className={styles.detail}>
      {detail.result && (
        <>
          {detail.result.strengths.length > 0 && (
            <div className={styles.detailBlock}>
              <h4>Сильные стороны</h4>
              <ul>{detail.result.strengths.map(s => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {detail.result.weaknesses.length > 0 && (
            <div className={styles.detailBlock}>
              <h4>Зоны развития</h4>
              <ul>{detail.result.weaknesses.map(s => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {detail.result.recommendations.length > 0 && (
            <div className={styles.detailBlock}>
              <h4>Рекомендации</h4>
              <ul>{detail.result.recommendations.map(s => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
        </>
      )}

      {detail.competencies.length > 0 && (
        <div className={styles.detailBlock}>
          <h4>По компетенциям</h4>
          <div className={styles.compList}>
            {detail.competencies.map(c => (
              <div key={c.key} className={styles.compRow}>
                <span className={styles.compName}>{c.name}</span>
                <div className={styles.compTrack}>
                  <div
                    className={`${styles.compFill} ${c.askedCount > 0 && c.avgScore < 60 ? styles.compLow : ''}`}
                    style={{ width: `${c.askedCount > 0 ? c.avgScore : 0}%` }}
                  />
                </div>
                <span className={styles.compScore}>{c.askedCount > 0 ? c.avgScore : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.answers && detail.answers.length > 0 && (
        <div className={styles.detailBlock}>
          <h4>Ответы</h4>
          <div className={styles.answers}>
            {detail.answers.map(a => (
              <div key={a.seq} className={styles.answerRow}>
                <div className={styles.answerHead}>
                  <span className={styles.answerSeq}>Вопрос {a.seq}</span>
                  <span className={styles.answerScore}>{a.score ?? '—'} / 100</span>
                </div>
                <p className={styles.answerQuestion}>{a.questionText}</p>
                {a.answer?.type === 'text' && <p className={styles.answerText}>{a.answer.text}</p>}
                {a.answer && a.answer.type !== 'text' && a.options && (
                  <p className={styles.answerText}>
                    {(a.answer.type === 'single' ? [a.answer.optionId] : a.answer.optionIds)
                      .map(id => a.options?.find(o => o.id === id)?.text ?? id)
                      .join('; ')}
                  </p>
                )}
                {a.correctOptionIds && a.options && (
                  <p className={styles.answerCorrect}>
                    Правильно: {a.correctOptionIds.map(id => a.options?.find(o => o.id === id)?.text ?? id).join('; ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const MyTestResultsPage: FC = () => {
  const [openId, setOpenId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['adaptive-testing', 'my-results'],
    queryFn: () => adaptiveTestingService.listMyResults(),
    staleTime: 60_000,
  });

  const results = listQuery.data ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <BrainCircuit size={18} className={styles.pageIcon} />
        <h2 className={styles.pageTitle}>Мои результаты тестирования</h2>
      </div>

      {listQuery.isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : results.length === 0 ? (
        <div className={styles.empty}>Пройденных тестов пока нет.</div>
      ) : (
        <div className={styles.list}>
          {results.map(r => {
            const opened = openId === r.sessionId;
            return (
              <div key={r.sessionId} className={styles.item}>
                <button
                  type="button"
                  className={styles.itemHead}
                  onClick={() => setOpenId(opened ? null : r.sessionId)}
                >
                  <div className={styles.itemMain}>
                    <span className={styles.itemDate}>{fmtDate(r.completedAt ?? r.startedAt)}</span>
                    <span className={styles.itemStatus}>{statusLabel(r.status)}</span>
                  </div>
                  <div className={styles.itemRight}>
                    {r.status === 'completed' && (
                      <span className={styles.itemScore}>{r.overallScore ?? '—'} / 100</span>
                    )}
                    {opened ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </div>
                </button>
                {opened && r.status === 'completed' && <ResultDetail sessionId={r.sessionId} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
