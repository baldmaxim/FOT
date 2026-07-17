import { type FC, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BrainCircuit, ChevronDown, ChevronUp, Settings2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  adaptiveTestingService,
  type IAdaptiveResultDetail,
} from '../services/adaptiveTestingService';
import { AdaptiveProfilesPanel } from '../components/adaptive-testing/AdaptiveProfilesPanel';
import styles from './TestingReviewPage.module.css';

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

const statusLabel = (status: string): string =>
  status === 'completed' ? 'Завершён' : status === 'error' ? 'Прерван' : status;

/** Деталь результата: админ видит ответы, руководитель — итог и компетенции. */
const ResultDetail: FC<{ sessionId: string }> = ({ sessionId }) => {
  const detailQuery = useQuery<IAdaptiveResultDetail>({
    queryKey: ['adaptive-testing', 'result', sessionId],
    queryFn: () => adaptiveTestingService.getResultDetail(sessionId),
    staleTime: 5 * 60_000,
  });

  if (detailQuery.isLoading) return <div className={styles.detailLoading}>Загрузка…</div>;
  const detail = detailQuery.data;
  if (!detail) return <div className={styles.detailLoading}>Не удалось загрузить.</div>;

  return (
    <div className={styles.detail}>
      {detail.result && (
        <div className={styles.detailCols}>
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
        </div>
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
          <h4>Ответы сотрудника</h4>
          <div className={styles.answers}>
            {detail.answers.map(a => (
              <div key={a.seq} className={styles.answerRow}>
                <div className={styles.answerHead}>
                  <span>Вопрос {a.seq} · {a.competencyKey} · сложность {a.difficulty}</span>
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
                {a.eval && a.eval.missed.length > 0 && (
                  <p className={styles.answerMissed}>Упущено: {a.eval.missed.join('; ')}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const TestingReviewPage: FC = () => {
  const { canEditPage } = useAuth();
  const isAdmin = canEditPage('/testing-review');
  const [view, setView] = useState<'results' | 'profiles'>('results');
  const [openId, setOpenId] = useState<string | null>(null);

  const resultsQuery = useQuery({
    queryKey: ['adaptive-testing', 'results'],
    queryFn: () => adaptiveTestingService.listResults(100, 0),
    staleTime: 30_000,
    enabled: view === 'results',
  });

  const results = resultsQuery.data ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.headTitle}>
          <BrainCircuit size={18} className={styles.headIcon} />
          <h2>Тестирование</h2>
        </div>
        {isAdmin && (
          <div className={styles.viewSwitch}>
            <button
              type="button"
              className={`${styles.viewBtn} ${view === 'results' ? styles.viewActive : ''}`}
              onClick={() => setView('results')}
            >
              Результаты
            </button>
            <button
              type="button"
              className={`${styles.viewBtn} ${view === 'profiles' ? styles.viewActive : ''}`}
              onClick={() => setView('profiles')}
            >
              <Settings2 size={14} /> Профили и покрытие
            </button>
          </div>
        )}
      </div>

      {view === 'profiles' && isAdmin ? (
        <AdaptiveProfilesPanel />
      ) : resultsQuery.isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : results.length === 0 ? (
        <div className={styles.empty}>Завершённых тестирований пока нет.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th>Отдел</th>
                <th>Должность</th>
                <th>Дата</th>
                <th>Балл</th>
                <th>Зоны риска</th>
                <th>Статус</th>
                <th aria-label="Раскрыть" />
              </tr>
            </thead>
            <tbody>
              {results.map(r => {
                const opened = openId === r.sessionId;
                return (
                  <FragmentRow
                    key={r.sessionId}
                    opened={opened}
                    onToggle={() => setOpenId(opened ? null : r.sessionId)}
                    row={r}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const FragmentRow: FC<{
  row: {
    sessionId: string;
    employeeName: string | null;
    departmentName: string | null;
    positionName: string | null;
    status: string;
    overallScore: number | null;
    weaknesses: string[] | null;
    startedAt: string;
    completedAt: string | null;
  };
  opened: boolean;
  onToggle: () => void;
}> = ({ row, opened, onToggle }) => (
  <>
    <tr className={styles.row} onClick={onToggle}>
      <td>{row.employeeName ?? '—'}</td>
      <td>{row.departmentName ?? '—'}</td>
      <td>{row.positionName ?? '—'}</td>
      <td>{fmtDate(row.completedAt ?? row.startedAt)}</td>
      <td className={styles.scoreCell}>{row.status === 'completed' ? (row.overallScore ?? '—') : '—'}</td>
      <td className={styles.weakCell}>{(row.weaknesses ?? []).join(', ') || '—'}</td>
      <td>{statusLabel(row.status)}</td>
      <td className={styles.chevronCell}>{opened ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</td>
    </tr>
    {opened && row.status === 'completed' && (
      <tr>
        <td colSpan={8} className={styles.detailCell}>
          <ResultDetail sessionId={row.sessionId} />
        </td>
      </tr>
    )}
  </>
);
