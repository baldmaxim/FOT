import { type FC, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  adaptiveTestingService,
  type IAdaptiveAnswerInput,
  type IAdaptiveCurrent,
} from '../../services/adaptiveTestingService';
import styles from './AdaptiveTestModal.module.css';

interface IProps {
  hasActiveSession: boolean;
  onClose: () => void;
}

const CURRENT_QUERY_KEY = ['adaptive-testing', 'current'] as const;
const POLL_MS = 2000;

const isBusyState = (state: IAdaptiveCurrent['state'] | undefined): boolean =>
  state === 'generating' || state === 'evaluating';

export const AdaptiveTestModal: FC<IProps> = ({ hasActiveSession, onClose }) => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const overlay = useOverlayDismiss(() => onClose());

  const [starting, setStarting] = useState(!hasActiveSession);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [textAnswer, setTextAnswer] = useState('');
  // id вопроса, для которого набран ответ — сбрасываем поля при смене вопроса.
  const answeredForRef = useRef<string | null>(null);

  const currentQuery = useQuery({
    queryKey: CURRENT_QUERY_KEY,
    queryFn: adaptiveTestingService.getCurrent,
    enabled: !starting,
    // Поллинг только пока сервер обрабатывает; поллинг LLM не перезапускает.
    refetchInterval: q => (isBusyState(q.state.data?.state) ? POLL_MS : false),
    refetchOnWindowFocus: true,
  });

  // Старт новой сессии (идемпотентен: активная вернётся как resumed).
  useEffect(() => {
    if (!starting) return;
    let cancelled = false;
    (async () => {
      try {
        await adaptiveTestingService.startSession();
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Не удалось начать тест';
          showToast('error', message);
          onClose();
          return;
        }
      }
      if (!cancelled) {
        setStarting(false);
        void queryClient.invalidateQueries({ queryKey: CURRENT_QUERY_KEY });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starting]);

  const current = currentQuery.data;
  const question = current?.state === 'question_ready' ? current.question : null;

  // Смена вопроса → чистим введённый ответ.
  useEffect(() => {
    if (question && answeredForRef.current !== question.id) {
      answeredForRef.current = question.id;
      setSelected([]);
      setTextAnswer('');
    }
  }, [question]);

  const buildAnswer = (): IAdaptiveAnswerInput | null => {
    if (!question) return null;
    if (question.type === 'single') {
      return selected.length === 1 ? { type: 'single', optionId: selected[0] } : null;
    }
    if (question.type === 'multiple') {
      return selected.length > 0 ? { type: 'multiple', optionIds: selected } : null;
    }
    const text = textAnswer.trim();
    return text ? { type: 'text', text } : null;
  };

  const handleSubmit = async () => {
    if (submitting || !current?.sessionId || !question) return;
    const answer = buildAnswer();
    if (!answer) {
      showToast('error', question.type === 'text' ? 'Введите ответ' : 'Выберите вариант ответа');
      return;
    }
    setSubmitting(true);
    try {
      await adaptiveTestingService.submitAnswer(current.sessionId, question.id, answer);
      await queryClient.invalidateQueries({ queryKey: CURRENT_QUERY_KEY });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось отправить ответ';
      showToast('error', message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetry = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await adaptiveTestingService.retry();
      await queryClient.invalidateQueries({ queryKey: CURRENT_QUERY_KEY });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось перезапустить';
      showToast('error', message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleOption = (optionId: string) => {
    if (!question) return;
    if (question.type === 'single') {
      setSelected([optionId]);
    } else {
      setSelected(prev => (prev.includes(optionId) ? prev.filter(o => o !== optionId) : [...prev, optionId]));
    }
  };

  const renderBody = () => {
    if (starting || currentQuery.isLoading || !current) {
      return <div className={styles.centered}><span className={styles.spinner} />Готовим тест…</div>;
    }

    switch (current.state) {
      case 'generating':
        return <div className={styles.centered}><span className={styles.spinner} />Готовим следующий вопрос…</div>;
      case 'evaluating':
        return <div className={styles.centered}><span className={styles.spinner} />Анализируем ответ…</div>;
      case 'paused':
        return <div className={styles.centered}>Тестирование временно приостановлено. Прогресс сохранён — вернитесь позже.</div>;
      case 'failed':
        return (
          <div className={styles.centered}>
            <p className={styles.errorText}>{current.errorMessage ?? 'Техническая ошибка.'}</p>
            <button type="button" className={styles.primaryBtn} onClick={handleRetry} disabled={submitting}>
              Повторить
            </button>
          </div>
        );
      case 'error':
        return (
          <div className={styles.centered}>
            <p className={styles.errorText}>
              {current.errorMessage ?? 'Тест прерван из-за технической ошибки. Попробуйте в другой день.'}
            </p>
          </div>
        );
      case 'completed':
        return renderResult();
      case 'question_ready':
        return renderQuestion();
      default:
        return <div className={styles.centered}>Активного теста нет.</div>;
    }
  };

  const renderQuestion = () => {
    if (!question || !current) return null;
    const hint = question.type === 'single'
      ? 'Выберите один ответ'
      : question.type === 'multiple'
        ? 'Можно выбрать несколько ответов'
        : 'Введите ответ текстом';

    return (
      <div className={styles.question}>
        <div className={styles.progressRow}>
          <span className={styles.progressLabel}>Вопрос {question.seq} из {current.totalQuestions}</span>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${(question.seq / current.totalQuestions) * 100}%` }}
            />
          </div>
        </div>
        <span className={styles.qHint}>{hint}</span>
        <h3 className={styles.qText}>{question.questionText}</h3>

        {question.type === 'text' ? (
          <>
            <textarea
              className={styles.textInput}
              value={textAnswer}
              onChange={e => setTextAnswer(e.target.value)}
              maxLength={4000}
              placeholder="Ваш ответ..."
            />
            <p className={styles.piiWarning}>
              Ответ обрабатывается ИИ. Не указывайте персональные данные: ФИО, телефоны, документы.
            </p>
          </>
        ) : (
          <div className={styles.options}>
            {(question.options ?? []).map(opt => {
              const isActive = selected.includes(opt.id);
              return (
                <button
                  type="button"
                  key={opt.id}
                  className={`${styles.option} ${isActive ? styles.optionActive : ''}`}
                  onClick={() => toggleOption(opt.id)}
                >
                  <span className={question.type === 'single' ? styles.radio : styles.checkbox}>
                    {isActive && (question.type === 'single' ? <span className={styles.dot} /> : <Check size={14} />)}
                  </span>
                  <span>{opt.text}</span>
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          className={styles.primaryBtn}
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? 'Отправка…' : 'Ответить'}
        </button>
      </div>
    );
  };

  const renderResult = () => {
    const result = current?.result;
    if (!result) return <div className={styles.centered}>Результат недоступен.</div>;
    return (
      <div className={styles.result}>
        <div className={styles.scoreRow}>
          <div className={styles.scoreBox}>
            <span className={styles.scoreValue}>{result.overallScore ?? '—'}</span>
            <span className={styles.scoreLabel}>из 100</span>
          </div>
          <div className={styles.scoreMeta}>
            Покрытие компетенций: {result.coveragePct ?? '—'}%
          </div>
        </div>
        {result.strengths.length > 0 && (
          <div className={styles.resultBlock}>
            <h4 className={styles.resultTitle}>Сильные стороны</h4>
            <ul className={styles.resultList}>{result.strengths.map(s => <li key={s}>{s}</li>)}</ul>
          </div>
        )}
        {result.weaknesses.length > 0 && (
          <div className={styles.resultBlock}>
            <h4 className={styles.resultTitle}>Зоны развития</h4>
            <ul className={styles.resultList}>{result.weaknesses.map(s => <li key={s}>{s}</li>)}</ul>
          </div>
        )}
        {result.recommendations.length > 0 && (
          <div className={styles.resultBlock}>
            <h4 className={styles.resultTitle}>Рекомендации</h4>
            <ul className={styles.resultList}>{result.recommendations.map(s => <li key={s}>{s}</li>)}</ul>
          </div>
        )}
        <button type="button" className={styles.primaryBtn} onClick={onClose}>Закрыть</button>
      </div>
    );
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={overlay.onMouseDown}
      onMouseUp={overlay.onMouseUp}
      onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart}
      onTouchEnd={overlay.onTouchEnd}
    >
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.head}>
          <h2 className={styles.title}>Тестирование</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>
        <div className={styles.body}>{renderBody()}</div>
      </div>
    </div>
  );
};
