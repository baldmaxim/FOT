import type { ReactElement } from 'react';

interface IErrorFallbackProps {
  resetError: () => void;
}

export const ErrorFallback = ({ resetError }: IErrorFallbackProps): ReactElement => {
  return (
    <div
      role="alert"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        textAlign: 'center',
        gap: '12px',
        background: 'var(--bg-primary, #0f1115)',
        color: 'var(--text-primary, #e6e8eb)',
      }}
    >
      <h1 style={{ margin: 0, fontSize: '20px' }}>Что-то пошло не так</h1>
      <p style={{ margin: 0, opacity: 0.7, maxWidth: '420px' }}>
        Ошибка отправлена в систему мониторинга. Попробуйте перезагрузить страницу.
      </p>
      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        <button
          onClick={() => {
            resetError();
            window.location.reload();
          }}
          style={{
            padding: '8px 16px',
            borderRadius: '6px',
            border: '1px solid var(--border-primary, #2a2f36)',
            background: 'var(--accent-primary, #3b82f6)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Перезагрузить
        </button>
        <button
          onClick={resetError}
          style={{
            padding: '8px 16px',
            borderRadius: '6px',
            border: '1px solid var(--border-primary, #2a2f36)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          Попробовать снова
        </button>
      </div>
    </div>
  );
};
