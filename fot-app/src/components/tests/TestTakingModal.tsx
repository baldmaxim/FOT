import { type FC, useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { getAvailableTestsQueryKey } from '../../hooks/usePortalData';
import {
  testsService,
  type ITestFull,
  type ITestQuestion,
  type IAnswerInput,
} from '../../services/testsService';
import styles from './TestTakingModal.module.css';

interface IProps {
  testId: string;
  onClose: () => void;
}

interface IAnswerState {
  options: string[];
  customSelected: boolean;
  customText: string;
}

const emptyAnswer = (): IAnswerState => ({ options: [], customSelected: false, customText: '' });

const isAnswered = (q: ITestQuestion, a: IAnswerState | undefined): boolean => {
  if (!a) return false;
  if (q.type === 'text') return a.customText.trim().length > 0;
  if (a.options.length > 0) return true;
  return q.allow_custom && a.customSelected && a.customText.trim().length > 0;
};

export const TestTakingModal: FC<IProps> = ({ testId, onClose }) => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [test, setTest] = useState<ITestFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [answers, setAnswers] = useState<Record<string, IAnswerState>>({});
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [full, mine] = await Promise.all([
          testsService.take(testId),
          testsService.getMyResponse(testId),
        ]);
        if (cancelled) return;
        setTest(full);
        if (mine?.answers?.length) {
          const init: Record<string, IAnswerState> = {};
          const textQ = new Set(full.questions.filter(q => q.type === 'text').map(q => q.id));
          for (const ans of mine.answers) {
            const isText = textQ.has(ans.question_id);
            init[ans.question_id] = {
              options: ans.selected_option_ids ?? [],
              customSelected: !isText && !!ans.custom_text,
              customText: ans.custom_text ?? '',
            };
          }
          setAnswers(init);
        }
      } catch (err) {
        console.error('test take load error:', err);
        showToast('error', 'Не удалось загрузить тест');
        onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [testId, onClose, showToast]);

  const overlay = useOverlayDismiss(() => handleCancel());

  const total = test?.questions.length ?? 0;
  const answeredCount = useMemo(
    () => (test?.questions ?? []).filter(q => isAnswered(q, answers[q.id])).length,
    [test, answers],
  );

  const setAnswer = (qId: string, patch: Partial<IAnswerState>) => {
    setDirty(true);
    setAnswers(prev => ({ ...prev, [qId]: { ...emptyAnswer(), ...prev[qId], ...patch } }));
  };

  const handleCancel = () => {
    if (dirty && !window.confirm('Закрыть без сохранения? Несохранённые ответы будут потеряны.')) return;
    onClose();
  };

  const buildAnswers = (): IAnswerInput[] => (test?.questions ?? []).map(q => {
    const a = answers[q.id] ?? emptyAnswer();
    if (q.type === 'text') {
      return { question_id: q.id, selected_option_ids: [], custom_text: a.customText.trim() || null };
    }
    return {
      question_id: q.id,
      selected_option_ids: a.options,
      custom_text: q.allow_custom && a.customSelected ? (a.customText.trim() || null) : null,
    };
  });

  const handleSave = async () => {
    if (busy || !test) return;
    setBusy(true);
    try {
      await testsService.saveResponse(test.id, 'draft', buildAnswers());
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: getAvailableTestsQueryKey() });
      showToast('success', 'Черновик сохранён');
    } catch (err) {
      console.error('test save draft error:', err);
      showToast('error', 'Не удалось сохранить черновик');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (busy || !test) return;
    const firstUnanswered = test.questions.findIndex(q => q.is_required && !isAnswered(q, answers[q.id]));
    if (firstUnanswered >= 0) {
      setCurrent(firstUnanswered);
      showToast('error', 'Ответьте на все обязательные вопросы');
      return;
    }
    setBusy(true);
    try {
      await testsService.saveResponse(test.id, 'submitted', buildAnswers());
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: getAvailableTestsQueryKey() });
      showToast('success', 'Тест отправлен');
      onClose();
    } catch (err) {
      console.error('test submit error:', err);
      showToast('error', 'Не удалось отправить тест');
    } finally {
      setBusy(false);
    }
  };

  const renderQuestion = (q: ITestQuestion) => {
    const a = answers[q.id] ?? emptyAnswer();
    const hintText = q.type === 'single'
      ? 'Выберите один ответ'
      : q.type === 'multiple'
        ? 'Можно выбрать несколько ответов'
        : 'Введите ответ текстом';

    return (
      <div className={styles.question}>
        <div className={styles.qHead}>
          <span className={styles.qHint}>{hintText}</span>
          {q.is_required && <span className={styles.required}>обязательный</span>}
        </div>
        <h3 className={styles.qText}>{q.text}</h3>

        {q.type === 'text' ? (
          <textarea
            className={styles.textInput}
            value={a.customText}
            onChange={e => setAnswer(q.id, { customText: e.target.value })}
            placeholder="Ваш ответ..."
          />
        ) : (
          <div className={styles.options}>
            {q.options.map(opt => {
              const selected = a.options.includes(opt.id);
              const toggle = () => {
                if (q.type === 'single') {
                  setAnswer(q.id, { options: [opt.id], customSelected: false });
                } else {
                  const next = selected ? a.options.filter(o => o !== opt.id) : [...a.options, opt.id];
                  setAnswer(q.id, { options: next });
                }
              };
              return (
                <button
                  type="button"
                  key={opt.id}
                  className={`${styles.option} ${selected ? styles.optionActive : ''}`}
                  onClick={toggle}
                >
                  <span className={q.type === 'single' ? styles.radio : styles.checkbox}>
                    {selected && (q.type === 'single' ? <span className={styles.dot} /> : <Check size={14} />)}
                  </span>
                  <span>{opt.text}</span>
                </button>
              );
            })}

            {q.allow_custom && (
              <div className={styles.customWrap}>
                <button
                  type="button"
                  className={`${styles.option} ${a.customSelected ? styles.optionActive : ''}`}
                  onClick={() => {
                    if (q.type === 'single') {
                      setAnswer(q.id, { options: [], customSelected: !a.customSelected });
                    } else {
                      setAnswer(q.id, { customSelected: !a.customSelected });
                    }
                  }}
                >
                  <span className={q.type === 'single' ? styles.radio : styles.checkbox}>
                    {a.customSelected && (q.type === 'single' ? <span className={styles.dot} /> : <Check size={14} />)}
                  </span>
                  <span>Свой вариант</span>
                </button>
                {a.customSelected && (
                  <input
                    className={styles.customInput}
                    value={a.customText}
                    onChange={e => setAnswer(q.id, { customText: e.target.value })}
                    placeholder="Введите свой вариант..."
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const q = test?.questions[current];

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
        {loading || !test ? (
          <div className={styles.loading}>Загрузка теста…</div>
        ) : (
          <>
            <div className={styles.head}>
              <div className={styles.titleWrap}>
                <h2 className={styles.title}>{test.title}</h2>
                {test.description && <p className={styles.desc}>{test.description}</p>}
              </div>
              <button className={styles.closeBtn} onClick={handleCancel} aria-label="Закрыть">
                <X size={20} />
              </button>
            </div>

            <div className={styles.body}>
              <aside className={styles.nav}>
                <div className={styles.counter}>{answeredCount}/{total}</div>
                <div className={styles.navList}>
                  {test.questions.map((qq, i) => {
                    const done = isAnswered(qq, answers[qq.id]);
                    return (
                      <button
                        key={qq.id}
                        type="button"
                        className={`${styles.navItem} ${i === current ? styles.navActive : ''} ${done ? styles.navDone : ''}`}
                        onClick={() => setCurrent(i)}
                      >
                        <span>{i + 1}</span>
                        {done && <Check size={12} className={styles.navCheck} />}
                      </button>
                    );
                  })}
                </div>
              </aside>

              <section className={styles.main}>
                {q && renderQuestion(q)}
                <div className={styles.pager}>
                  <button
                    type="button"
                    className={styles.pagerBtn}
                    disabled={current === 0}
                    onClick={() => setCurrent(c => Math.max(0, c - 1))}
                  >
                    <ChevronLeft size={16} /> Назад
                  </button>
                  <span className={styles.pagerInfo}>Вопрос {current + 1} из {total}</span>
                  <button
                    type="button"
                    className={styles.pagerBtn}
                    disabled={current >= total - 1}
                    onClick={() => setCurrent(c => Math.min(total - 1, c + 1))}
                  >
                    Вперёд <ChevronRight size={16} />
                  </button>
                </div>
              </section>
            </div>

            <div className={styles.footer}>
              <button type="button" className={styles.cancelBtn} onClick={handleCancel} disabled={busy}>
                Отмена
              </button>
              <div className={styles.footerRight}>
                <button type="button" className={styles.saveBtn} onClick={handleSave} disabled={busy}>
                  Сохранить
                </button>
                <button type="button" className={styles.submitBtn} onClick={handleSubmit} disabled={busy}>
                  Отправить
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
