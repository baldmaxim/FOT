import { type FC, useEffect, useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { testsService, type ITestResponseDetail, type ITestQuestion } from '../../services/testsService';
import styles from './TestTakingModal.module.css';

interface IProps {
  testId: string;
  responseId: string;
  onClose: () => void;
}

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export const TestResponseViewModal: FC<IProps> = ({ testId, responseId, onClose }) => {
  const { showToast } = useToast();
  const overlay = useOverlayDismiss(onClose);

  const [data, setData] = useState<ITestResponseDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await testsService.getResponseDetail(testId, responseId);
        if (!cancelled) setData(res);
      } catch (err) {
        console.error('test response detail load error:', err);
        showToast('error', 'Не удалось загрузить прохождение');
        onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [testId, responseId, onClose, showToast]);

  // Ответы по question_id для быстрого доступа.
  const answerByQuestion = useMemo(() => {
    const map = new Map<string, { selected: Set<string>; customText: string | null }>();
    for (const a of data?.response.answers ?? []) {
      map.set(a.question_id, { selected: new Set(a.selected_option_ids ?? []), customText: a.custom_text });
    }
    return map;
  }, [data]);

  const renderQuestion = (q: ITestQuestion) => {
    const a = answerByQuestion.get(q.id);
    const selected = a?.selected ?? new Set<string>();
    const customText = a?.customText ?? null;
    // Свой вариант: текст есть, но не привязан к выбранным опциям (для не-text вопросов).
    const hasCustom = q.type !== 'text' && q.allow_custom && !!customText;

    return (
      <div className={styles.question} key={q.id}>
        <h3 className={styles.qText}>{q.text}</h3>

        {q.type === 'text' ? (
          <div className={`${styles.option} ${customText ? styles.optionActive : ''}`}>
            <span>{customText || <em>Без ответа</em>}</span>
          </div>
        ) : (
          <div className={styles.options}>
            {q.options.map(opt => {
              const isSel = selected.has(opt.id);
              return (
                <div key={opt.id} className={`${styles.option} ${isSel ? styles.optionActive : ''}`}>
                  <span className={q.type === 'single' ? styles.radio : styles.checkbox}>
                    {isSel && (q.type === 'single' ? <span className={styles.dot} /> : <Check size={14} />)}
                  </span>
                  <span>{opt.text}</span>
                </div>
              );
            })}
            {hasCustom && (
              <div className={`${styles.option} ${styles.optionActive}`}>
                <span className={q.type === 'single' ? styles.radio : styles.checkbox}>
                  {q.type === 'single' ? <span className={styles.dot} /> : <Check size={14} />}
                </span>
                <span>Свой вариант: {customText}</span>
              </div>
            )}
          </div>
        )}
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
        {loading || !data ? (
          <div className={styles.loading}>Загрузка прохождения…</div>
        ) : (
          <>
            <div className={styles.head}>
              <div className={styles.titleWrap}>
                <h2 className={styles.title}>{data.test.title}</h2>
                <p className={styles.desc}>
                  {data.response.full_name ?? '—'} · {fmtDate(data.response.submitted_at)}
                </p>
              </div>
              <button className={styles.closeBtn} onClick={onClose} aria-label="Закрыть">
                <X size={20} />
              </button>
            </div>

            <div className={styles.body}>
              {data.test.questions.map(renderQuestion)}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
