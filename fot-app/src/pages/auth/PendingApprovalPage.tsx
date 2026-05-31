import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import styles from './TwoFactor.module.css';

export const PendingApprovalPage: React.FC = () => {
  const navigate = useNavigate();
  const { logout, profile, isApproved, isTwoFactorEnabled, refreshProfile } = useAuth();
  const [loading, setLoading] = useState(false);

  // Когда статус стал «одобрен»: с 2FA — на ввод кода, без 2FA (2FA по
  // умолчанию выключена) — сразу в приложение. Без ветки без-2FA approved-
  // пользователь «залипал» бы здесь в состоянии «Ожидание 2FA».
  useEffect(() => {
    if (!isApproved) return;
    navigate(isTwoFactorEnabled ? '/verify-2fa' : '/', { replace: true });
  }, [isApproved, isTwoFactorEnabled, navigate]);

  // Авто-обновление профиля, пока не одобрено: вкладка/PWA, открытая до
  // одобрения, «отлипает» сама, без ручного «Проверить статус».
  // Поллим часто (5с): pending-пользователь НЕ подключён к Socket.IO (handshake
  // отклоняет неодобренных), поэтому realtime-пуш до него не доходит — опрос
  // /auth/me единственный канал. Запрос лёгкий, pending-пользователей мало.
  // refreshProfile в ref — чтобы интервал не пересоздавался на каждый рендер.
  const refreshRef = useRef(refreshProfile);
  refreshRef.current = refreshProfile;
  useEffect(() => {
    if (isApproved) return;
    const tick = () => { void refreshRef.current(); };
    const id = window.setInterval(tick, 5_000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isApproved]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      await refreshProfile();
      // После обновления профиля useEffect выше проверит и перенаправит если нужно
    } finally {
      setLoading(false);
    }
  };

  // Определяем статус
  const isWaitingApproval = !isApproved;
  const isWaiting2FA = isApproved && !isTwoFactorEnabled;

  return (
    <div className={styles.container}>
      <div className={styles.wrapper}>
        <div className={styles.logo}>
          <div className={styles.logoIcon}>
            <span>F</span>
          </div>
          <div className={styles.logoText}>FOT</div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardHeader}>
            {isWaitingApproval ? (
              <>
                <div className={styles.cardIcon} style={{ background: 'var(--warning-muted)' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--warning)' }}>
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                </div>
                <h1>Ожидание одобрения</h1>
                <p>
                  Ваша заявка отправлена администратору<br/>
                  и находится на рассмотрении
                </p>
              </>
            ) : isWaiting2FA ? (
              <>
                <div className={styles.cardIcon} style={{ background: 'var(--success-muted)' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--success)' }}>
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                <h1>Заявка одобрена!</h1>
                <p>
                  Теперь дождитесь настройки<br/>
                  двухфакторной аутентификации
                </p>
              </>
            ) : null}
          </div>

          <div style={{
            background: 'var(--bg-tertiary)',
            borderRadius: '12px',
            padding: '20px',
            marginBottom: '24px',
            border: '1px solid var(--border)'
          }}>
            {profile?.full_name && (
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>
                  Имя
                </div>
                <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {profile.full_name}
                </div>
              </div>
            )}
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>
                Статус
              </div>
              {isWaitingApproval ? (
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '13px',
                  fontWeight: 500,
                  color: 'var(--warning)',
                  background: 'var(--warning-muted)',
                  padding: '4px 10px',
                  borderRadius: '6px'
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                  На рассмотрении
                </div>
              ) : isWaiting2FA ? (
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '13px',
                  fontWeight: 500,
                  color: 'var(--accent)',
                  background: 'var(--accent-muted)',
                  padding: '4px 10px',
                  borderRadius: '6px'
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                  Ожидание 2FA
                </div>
              ) : null}
            </div>
          </div>

          <div style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            marginBottom: '24px',
            textAlign: 'center'
          }}>
            {isWaitingApproval ? (
              <>
                После одобрения администратор свяжется с вами<br/>
                для настройки двухфакторной аутентификации
              </>
            ) : isWaiting2FA ? (
              <>
                Администратор свяжется с вами для передачи<br/>
                ключа двухфакторной аутентификации
              </>
            ) : null}
          </div>

          <button
            onClick={handleRefresh}
            className={styles.submitBtn}
            disabled={loading}
          >
            {loading ? (
              <div className={styles.spinner} />
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M23 4v6h-6"/>
                  <path d="M1 20v-6h6"/>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                <span>Проверить статус</span>
              </>
            )}
          </button>

          <button onClick={handleLogout} className={styles.backLink}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
            Выйти из аккаунта
          </button>
        </div>

        <div className={styles.footer}>
          <p>Есть вопросы? Свяжитесь с администратором</p>
        </div>
      </div>
    </div>
  );
};
