import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';

interface INotFoundPageProps {
  title?: string;
  message?: string;
}

export const NotFoundPage: FC<INotFoundPageProps> = ({
  title = 'Тут ничего нет, только ветер 🍃',
  message,
}) => {
  const navigate = useNavigate();
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: '40px 24px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ margin: 0 }}>{title}</h1>
      {message && <p style={{ margin: 0, lineHeight: 1.5, maxWidth: 480 }}>{message}</p>}
      <button
        type="button"
        onClick={() => navigate('/')}
        style={{
          minHeight: 44,
          padding: '10px 24px',
          fontSize: 16,
          cursor: 'pointer',
          border: '1px solid currentColor',
          background: 'transparent',
          color: 'inherit',
          borderRadius: 8,
        }}
      >
        Вернуться
      </button>
    </div>
  );
};
