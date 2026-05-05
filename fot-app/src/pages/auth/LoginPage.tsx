import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ApiError } from '../../api/client';
import styles from './Auth.module.css';

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { requires2FA } = await login({ email, password });

      if (requires2FA) {
        // Не сбрасываем loading, чтобы избежать мерцания UI
        navigate('/verify-2fa', { replace: true });
        return;
      } else {
        navigate('/', { replace: true });
        return;
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'PENDING_APPROVAL') {
          navigate('/pending-approval', { replace: true });
          return;
        }
        setError(err.message);
      } else {
        setError('Произошла ошибка при входе');
      }
      setLoading(false);
    }
  };

  return (
    <div className={styles.loginContainer}>
      {/* Левая панель — брендинг */}
      <div className={styles.brandPanel}>
        <div className={styles.brandContent}>
          <div className={styles.logo}>
            <div className={styles.logoIcon}>
              <span>F</span>
            </div>
            <div className={styles.logoText}>FOT</div>
          </div>

          <div className={styles.brandHeadline}>
            <h1>Управление персоналом <span>без сложностей</span></h1>
            <p>Единая платформа для учёта рабочего времени, контроля доступа и расчёта заработной платы.</p>

            <div className={styles.features}>
              <div className={styles.feature}>
                <div className={styles.featureIcon}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                </div>
                <span className={styles.featureText}>Управление сотрудниками и структурой</span>
              </div>
              <div className={styles.feature}>
                <div className={styles.featureIcon}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </div>
                <span className={styles.featureText}>Интеграция со СКУД-системами</span>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.brandFooter}>
          <span className={styles.version}>v2.4.0</span>
          <div className={styles.brandFooterLinks}>
            <a href="#">Документация</a>
            <a href="#">Поддержка</a>
            <a href="#">Политика</a>
          </div>
        </div>
      </div>

      {/* Правая панель — форма */}
      <div className={styles.authPanel}>
        {/* Мобильный логотип (скрыт на десктопе) */}
        <div className={styles.mobileLogo}>
          <div className={styles.logoIcon}><span>F</span></div>
          <div className={styles.logoText}>FOT</div>
        </div>
        <div className={styles.authContainer}>
          <div className={styles.authHeader}>
            <h2>Вход в систему</h2>
            <p>Введите данные для доступа к порталу</p>
          </div>

          <form className={styles.authForm} onSubmit={handleSubmit}>
            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Логин или email</label>
              <input
                type="email"
                className={styles.formInput}
                placeholder="ivanov@company.ru"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                autoComplete="email"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Пароль</label>
              <div className={styles.inputWrapper}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  className={styles.formInput}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="current-password"
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
            </div>

            <div className={styles.formRow}>
              <div
                className={styles.checkboxWrapper}
                onClick={() => setRememberMe(!rememberMe)}
              >
                <div className={`${styles.checkbox} ${rememberMe ? styles.checked : ''}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <span className={styles.checkboxLabel}>Запомнить меня</span>
              </div>
              <Link to="/forgot-password" className={styles.forgotLink}>Забыли пароль?</Link>
            </div>

            <button type="submit" className={styles.submitBtn} disabled={loading}>
              {loading ? 'Вход...' : 'Войти'}
              {!loading && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              )}
            </button>
          </form>

          <div className={styles.authFooterLogin}>
            <p>Нет аккаунта? <Link to="/register">Зарегистрироваться</Link></p>
          </div>
        </div>
      </div>
    </div>
  );
};
