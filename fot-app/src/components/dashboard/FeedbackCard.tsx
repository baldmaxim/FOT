import { type FC, useState } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { feedbackService, type FeedbackKind } from '../../services/feedbackService';
import styles from './FeedbackCard.module.css';

const MAX_LEN = 5000;

export const FeedbackCard: FC = () => {
  const { showToast } = useToast();
  const [kind, setKind] = useState<FeedbackKind>('suggestion');
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [sending, setSending] = useState(false);

  const trimmed = text.trim();
  const canSend = !sending && trimmed.length > 0;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await feedbackService.submit({ kind, content: trimmed, is_anonymous: anonymous });
      setText('');
      setAnonymous(false);
      showToast('success', kind === 'suggestion' ? 'Предложение отправлено' : 'Жалоба отправлена');
    } catch (err) {
      console.error('feedback submit error:', err);
      showToast('error', 'Не удалось отправить обращение');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <h3 className={styles.title}>Обратная связь</h3>
      </div>

      <select
        className={styles.select}
        value={kind}
        onChange={e => setKind(e.target.value as FeedbackKind)}
      >
        <option value="suggestion">Предложения по улучшению</option>
        <option value="complaint">Жалобы</option>
      </select>

      <textarea
        className={styles.textarea}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={kind === 'suggestion'
          ? 'Опишите, что можно улучшить...'
          : 'Опишите проблему или жалобу...'}
        maxLength={MAX_LEN}
      />

      <label className={styles.anonRow}>
        <input
          type="checkbox"
          checked={anonymous}
          onChange={e => setAnonymous(e.target.checked)}
        />
        <span>Анонимно</span>
      </label>
      <p className={styles.hint}>
        {anonymous
          ? 'Ваше имя не будет показано в списке обращений.'
          : 'Обращение будет подписано вашим именем.'}
      </p>

      <div className={styles.footer}>
        <button className={styles.sendBtn} onClick={handleSend} disabled={!canSend}>
          {sending ? 'Отправка...' : 'Отправить'}
        </button>
      </div>
    </div>
  );
};
