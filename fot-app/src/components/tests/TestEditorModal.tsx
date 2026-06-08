import { type FC, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useStructureTree } from '../../hooks/useStructure';
import { buildSu10DepartmentTree } from '../../utils/departmentUtils';
import { DepartmentTreeMultiSelect } from '../staff/DepartmentTreeMultiSelect';
import { testsService, type QuestionType } from '../../services/testsService';
import styles from './TestManagement.module.css';

interface IProps {
  testId: string | null; // null = создание
  onClose: () => void;
  onSaved: () => void;
}

interface IOptionDraft { text: string }
interface IQuestionDraft {
  text: string;
  type: QuestionType;
  allow_custom: boolean;
  is_required: boolean;
  options: IOptionDraft[];
}

const emptyQuestion = (): IQuestionDraft => ({
  text: '', type: 'single', allow_custom: false, is_required: true, options: [{ text: '' }, { text: '' }],
});

// ISO → значение для <input type="datetime-local">
const isoToLocal = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localToIso = (local: string): string | null => (local ? new Date(local).toISOString() : null);

export const TestEditorModal: FC<IProps> = ({ testId, onClose, onSaved }) => {
  const { showToast } = useToast();
  const structure = useStructureTree();
  const su10Tree = useMemo(
    () => buildSu10DepartmentTree(structure.data?.departments ?? []),
    [structure.data],
  );

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [activeFrom, setActiveFrom] = useState('');
  const [activeTo, setActiveTo] = useState('');
  const [departmentIds, setDepartmentIds] = useState<Set<string>>(new Set());
  const [questions, setQuestions] = useState<IQuestionDraft[]>([emptyQuestion()]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!testId);

  useEffect(() => {
    if (!testId) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await testsService.getFull(testId);
        if (cancelled) return;
        setTitle(t.title);
        setDescription(t.description ?? '');
        setActiveFrom(isoToLocal(t.active_from));
        setActiveTo(isoToLocal(t.active_to));
        setDepartmentIds(new Set(t.department_ids ?? []));
        setQuestions(t.questions.length ? t.questions.map(q => ({
          text: q.text, type: q.type, allow_custom: q.allow_custom, is_required: q.is_required,
          options: q.options.length ? q.options.map(o => ({ text: o.text })) : [{ text: '' }],
        })) : [emptyQuestion()]);
      } catch (err) {
        console.error('test editor load error:', err);
        showToast('error', 'Не удалось загрузить тест');
        onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [testId, onClose, showToast]);

  const overlay = useOverlayDismiss(onClose);

  const patchQuestion = (i: number, patch: Partial<IQuestionDraft>) =>
    setQuestions(prev => prev.map((q, idx) => idx === i ? { ...q, ...patch } : q));

  const handleSave = async () => {
    if (!title.trim()) { showToast('error', 'Укажите название теста'); return; }
    if (!questions.length) { showToast('error', 'Добавьте хотя бы один вопрос'); return; }
    for (const q of questions) {
      if (!q.text.trim()) { showToast('error', 'У каждого вопроса должен быть текст'); return; }
      if (q.type !== 'text' && q.options.filter(o => o.text.trim()).length < 1) {
        showToast('error', 'У вопроса с вариантами нужен хотя бы один вариант'); return;
      }
    }

    setBusy(true);
    try {
      const input = {
        title: title.trim(),
        description: description.trim() || null,
        active_from: localToIso(activeFrom),
        active_to: localToIso(activeTo),
        questions: questions.map(q => ({
          text: q.text.trim(),
          type: q.type,
          allow_custom: q.allow_custom,
          is_required: q.is_required,
          options: q.type === 'text' ? [] : q.options.filter(o => o.text.trim()).map(o => ({ text: o.text.trim() })),
        })),
      };
      const id = testId ?? (await testsService.create(input)).id;
      if (testId) await testsService.update(testId, input);
      await testsService.setAssignments(id, [...departmentIds]);
      showToast('success', testId ? 'Тест обновлён' : 'Тест создан');
      onSaved();
      onClose();
    } catch (err) {
      console.error('test save error:', err);
      showToast('error', 'Не удалось сохранить тест');
    } finally {
      setBusy(false);
    }
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
          <h2 className={styles.title}>{testId ? 'Редактирование теста' : 'Новый тест'}</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        </div>

        {loading ? <div className={styles.empty}>Загрузка…</div> : (
          <div className={styles.body}>
            <label className={styles.field}>
              <span className={styles.label}>Название</span>
              <input className={styles.input} value={title} onChange={e => setTitle(e.target.value)} placeholder="Например: Опрос удовлетворённости" />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Описание</span>
              <textarea className={styles.textarea} value={description} onChange={e => setDescription(e.target.value)} />
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.label}>Активен с</span>
                <input className={styles.input} type="datetime-local" value={activeFrom} onChange={e => setActiveFrom(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Активен по</span>
                <input className={styles.input} type="datetime-local" value={activeTo} onChange={e => setActiveTo(e.target.value)} />
              </label>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Назначить отделам</span>
              <DepartmentTreeMultiSelect
                nodes={su10Tree}
                value={[...departmentIds]}
                onChange={ids => setDepartmentIds(new Set(ids))}
                isLoading={structure.isPending}
                placeholder="Выберите отделы (можно «ООО СУ-10» целиком)…"
              />
            </div>

            <div className={styles.questions}>
              <div className={styles.qHeader}>
                <span className={styles.label}>Вопросы ({questions.length})</span>
                <button className={styles.addBtn} onClick={() => setQuestions(p => [...p, emptyQuestion()])}>
                  <Plus size={14} /> Вопрос
                </button>
              </div>

              {questions.map((q, qi) => (
                <div key={qi} className={styles.questionCard}>
                  <div className={styles.qTop}>
                    <span className={styles.qNum}>#{qi + 1}</span>
                    <button className={styles.iconBtn} onClick={() => setQuestions(p => p.filter((_, i) => i !== qi))} aria-label="Удалить вопрос">
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <input className={styles.input} value={q.text} onChange={e => patchQuestion(qi, { text: e.target.value })} placeholder="Текст вопроса" />

                  <div className={styles.qControls}>
                    <select className={styles.select} value={q.type} onChange={e => patchQuestion(qi, { type: e.target.value as QuestionType })}>
                      <option value="single">Один ответ (○)</option>
                      <option value="multiple">Несколько ответов (☐)</option>
                      <option value="text">Текстовый ответ</option>
                    </select>
                    <label className={styles.checkLabel}>
                      <input type="checkbox" checked={q.is_required} onChange={e => patchQuestion(qi, { is_required: e.target.checked })} />
                      обязательный
                    </label>
                    {q.type !== 'text' && (
                      <label className={styles.checkLabel}>
                        <input type="checkbox" checked={q.allow_custom} onChange={e => patchQuestion(qi, { allow_custom: e.target.checked })} />
                        свой вариант
                      </label>
                    )}
                  </div>

                  {q.type !== 'text' && (
                    <div className={styles.options}>
                      {q.options.map((o, oi) => (
                        <div key={oi} className={styles.optionRow}>
                          <input
                            className={styles.input}
                            value={o.text}
                            onChange={e => patchQuestion(qi, { options: q.options.map((oo, idx) => idx === oi ? { text: e.target.value } : oo) })}
                            placeholder={`Вариант ${oi + 1}`}
                          />
                          <button className={styles.iconBtn} onClick={() => patchQuestion(qi, { options: q.options.filter((_, idx) => idx !== oi) })} aria-label="Удалить вариант">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      <button className={styles.addBtn} onClick={() => patchQuestion(qi, { options: [...q.options, { text: '' }] })}>
                        <Plus size={14} /> Вариант
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose} disabled={busy}>Отмена</button>
          <button className={styles.saveBtn} onClick={handleSave} disabled={busy || loading}>
            {busy ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};
