// ВРЕМЕННЫЙ компонент для проверки Sentry. Удалить после успешного теста:
//   1. этот файл
//   2. импорт + <SentryTestButton /> в App.tsx
import { useState } from 'react';
import * as Sentry from '@sentry/react';

export const SentryTestButton = () => {
  const [status, setStatus] = useState<string>('');

  const fireUnhandled = () => {
    setStatus('throwing unhandled…');
    setTimeout(() => {
      throw new Error('FOT Sentry test (unhandled, fromButton)');
    }, 0);
  };

  const fireCaptured = () => {
    const eventId = Sentry.captureException(new Error('FOT Sentry test (captured, fromButton)'));
    setStatus(`captureException → eventId=${eventId}`);
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        zIndex: 999999,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 10,
        background: 'rgba(0,0,0,0.85)',
        border: '1px solid #ef4444',
        borderRadius: 8,
        color: '#fff',
        fontSize: 12,
        fontFamily: 'monospace',
      }}
    >
      <div style={{ color: '#fca5a5', fontWeight: 600 }}>SENTRY TEST (temp)</div>
      <button onClick={fireCaptured} style={{ padding: '4px 8px', cursor: 'pointer' }}>
        captureException
      </button>
      <button onClick={fireUnhandled} style={{ padding: '4px 8px', cursor: 'pointer' }}>
        throw unhandled
      </button>
      {status && <div style={{ maxWidth: 220, wordBreak: 'break-all' }}>{status}</div>}
    </div>
  );
};
