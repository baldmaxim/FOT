import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiClient, ApiError } from '../../api/client';
import styles from './TwoFactor.module.css';

export const ResetPasswordPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const hasMinLength = password.length >= 8;
  const passwordsMatch = password === confirmPassword && confirmPassword.length > 0;
  const isValid = hasMinLength && passwordsMatch;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError('Отсутствует токен сброса пароля. Запросите новую ссылку.');
      return;
    }

    if (!hasMinLength) {
      setError('Пароль должен содержать минимум 8 символов');
      return;
    }

    if (!passwordsMatch) {
      setError('Пароли не совпадают');
      return;
    }

    setLoading(true);

    try {
      await apiClient.post('/auth/reset-password', { token, password }, { skipAuth: true });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Произошла ошибка. Попробуйте позже.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
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
              <div className={styles.cardIcon} style={{ background: 'var(--error-muted)' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--error)' }}>
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" y1="9" x2="9" y2="15"/>
                  <line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
              </div>
              <h1>Недействительная ссылка</h1>
              <p>Ссылка для сброса пароля некорректна<br/>или не содержит необходимых данных</p>
            </div>

            <Link to="/forgot-password" className={styles.submitBtn} style={{ textDecoration: 'none' }}>
              <span>Запросить новую ссылку</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </Link>

            <Link to="/login" className={styles.backLink}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="19" y1="12" x2="5" y2="12"/>
                <polyline points="12 19 5 12 12 5"/>
              </svg>
              Вернуться к входу
            </Link>
          </div>
        </div>
      </div>
    );
  }

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
            <div className={styles.cardIcon} style={success ? { background: 'var(--success-muted)' } : undefined}>
              {success ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--success)' }}>
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              )}
            </div>
            <h1>{success ? 'Пароль изменён' : 'Новый пароль'}</h1>
            <p>
              {success
                ? <>Пароль успешно обновлён.<br/>Теперь вы можете войти в систему.</>
                : <>Придумайте новый надёжный пароль<br/>для вашего аккаунта</>
              }
            </p>
          </div>

          {!success && (
            <>
              {error && (
                <div className={styles.errorMessage}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Новый пароль</label>
                  <div className={styles.inputWrapper}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className={styles.formInput}
                      placeholder="Минимум 8 символов"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setError(''); }}
                      required
                      disabled={loading}
                      autoFocus
                      autoComplete="new-password"
                    />
                    <div
                      className={styles.inputIcon}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                          <line x1="1" y1="1" x2="23" y2="23"/>
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                          <circle cx="12" cy="12" r="3"/>
                        </svg>
                      )}
                    </div>
                  </div>
                  <div className={styles.passwordRequirements}>
                    <div className={`${styles.requirement} ${hasMinLength ? styles.met : ''}`}>
                      {hasMinLength ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10"/>
                        </svg>
                      )}
                      <span>Минимум 8 символов</span>
                    </div>
                  </div>
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Подтверждение пароля</label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className={`${styles.formInput} ${confirmPassword && !passwordsMatch ? styles.error : ''}`}
                    placeholder="Повторите пароль"
                    value={confirmPassword}
                    onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                    required
                    disabled={loading}
                    autoComplete="new-password"
                  />
                  {confirmPassword && (
                    <div className={styles.passwordRequirements}>
                      <div className={`${styles.requirement} ${passwordsMatch ? styles.met : ''}`}>
                        {passwordsMatch ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="15" y1="9" x2="9" y2="15"/>
                            <line x1="9" y1="9" x2="15" y2="15"/>
                          </svg>
                        )}
                        <span>{passwordsMatch ? 'Пароли совпадают' : 'Пароли не совпадают'}</span>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className={styles.submitBtn}
                  disabled={loading || !isValid}
                >
                  {loading ? (
                    <div className={styles.spinner} />
                  ) : (
                    <>
                      <span>Сохранить пароль</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                      </svg>
                    </>
                  )}
                </button>
              </form>
            </>
          )}

          {success && (
            <Link to="/login" className={styles.submitBtn} style={{ textDecoration: 'none' }}>
              <span>Перейти к входу</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
            </Link>
          )}

          {!success && (
            <Link to="/login" className={styles.backLink}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="19" y1="12" x2="5" y2="12"/>
                <polyline points="12 19 5 12 12 5"/>
              </svg>
              Вернуться к входу
            </Link>
          )}
        </div>

        <div className={styles.footer}>
          <p>Есть вопросы? Свяжитесь с администратором</p>
        </div>
      </div>
    </div>
  );
};
