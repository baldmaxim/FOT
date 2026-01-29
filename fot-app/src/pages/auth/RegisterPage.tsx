import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ApiError } from '../../api/client';
import styles from './Register.module.css';

export const RegisterPage: React.FC = () => {
  const { register } = useAuth();

  // Form fields
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Form state
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  // Validations
  const isEmailValid = useMemo(() => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }, [email]);

  const isFullNameValid = fullName.trim().length >= 2;
  const passwordsMatch = password === confirmPassword;
  const isFormValid = isFullNameValid && isEmailValid && password.length >= 8 && passwordsMatch;

  const passwordStrength = useMemo(() => {
    if (!password) return 0;
    let strength = 0;
    if (password.length >= 8) strength++;
    if (password.match(/[a-z]/) && password.match(/[A-Z]/)) strength++;
    if (password.match(/\d/)) strength++;
    if (password.match(/[^a-zA-Z\d]/)) strength++;
    return strength;
  }, [password]);

  const strengthLabel = useMemo(() => {
    if (passwordStrength <= 1) return { text: 'Слабый пароль', class: styles.weak };
    if (passwordStrength <= 2) return { text: 'Средний пароль', class: styles.medium };
    return { text: 'Надёжный пароль', class: styles.strong };
  }, [passwordStrength]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!isFormValid) {
      if (!isFullNameValid) {
        setError('Введите ФИО (минимум 2 символа)');
      } else if (!isEmailValid) {
        setError('Введите корректный email');
      } else if (password.length < 8) {
        setError('Пароль должен содержать минимум 8 символов');
      } else if (!passwordsMatch) {
        setError('Пароли не совпадают');
      }
      return;
    }

    setLoading(true);

    try {
      await register({
        email,
        password,
        full_name: fullName.trim(),
      });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Произошла ошибка при регистрации');
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className={styles.container}>
        <div className={styles.wrapper}>
          <div className={styles.logo}>
            <div className={styles.logoIcon}>
              <span>F</span>
            </div>
            <div className={styles.logoText}>FOT<span>by SU_10</span></div>
          </div>

          <div className={styles.card}>
            <div className={styles.successContainer}>
              <div className={styles.successIcon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
              </div>
              <h2 className={styles.successTitle}>Заявка отправлена</h2>

              <p className={styles.successText}>
                Ваша заявка на регистрацию отправлена администратору системы.<br/>
                После одобрения вы сможете войти в портал используя указанный email.
              </p>
              <Link to="/login" className={styles.successBtn}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="19" y1="12" x2="5" y2="12"/>
                  <polyline points="12 19 5 12 12 5"/>
                </svg>
                Вернуться на страницу входа
              </Link>
            </div>
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
          <div className={styles.logoText}>FOT<span>by SU_10</span></div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardIcon}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="8.5" cy="7" r="4"/>
                <line x1="20" y1="8" x2="20" y2="14"/>
                <line x1="23" y1="11" x2="17" y2="11"/>
              </svg>
            </div>
            <h1>Регистрация</h1>
            <p>Заполните форму для создания аккаунта</p>
          </div>

          <form className={styles.form} onSubmit={handleSubmit}>
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

            {/* Full Name */}
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                ФИО<span className={styles.required}>*</span>
              </label>
              <div className={styles.inputWrapper}>
                <input
                  type="text"
                  className={`${styles.formInput} ${fullName && (isFullNameValid ? styles.success : styles.error)}`}
                  placeholder="Иванов Иван Иванович"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  disabled={loading}
                  autoFocus
                  autoComplete="name"
                />
                {fullName && isFullNameValid && (
                  <div className={`${styles.inputIcon} ${styles.success}`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                      <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                  </div>
                )}
              </div>
            </div>

            {/* Email */}
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                Email<span className={styles.required}>*</span>
              </label>
              <div className={styles.inputWrapper}>
                <input
                  type="email"
                  className={`${styles.formInput} ${styles.withIcon} ${email && (isEmailValid ? styles.success : styles.error)}`}
                  placeholder="ivanov@company.ru"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="email"
                />
                {email && isEmailValid && (
                  <div className={`${styles.inputIcon} ${styles.success}`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                      <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                  </div>
                )}
              </div>
            </div>

            {/* Password */}
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                Пароль<span className={styles.required}>*</span>
              </label>
              <div className={styles.inputWrapper}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  className={`${styles.formInput} ${styles.withIcon}`}
                  placeholder="Минимум 8 символов"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  minLength={8}
                  autoComplete="new-password"
                />
                <div className={styles.inputIcon} onClick={() => setShowPassword(!showPassword)}>
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
              {password && (
                <div className={styles.passwordStrength}>
                  <div className={styles.strengthBar}>
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={`${styles.strengthSegment} ${i <= passwordStrength ? `${styles.active} ${strengthLabel.class}` : ''}`}
                      />
                    ))}
                  </div>
                  <div className={`${styles.strengthText} ${strengthLabel.class}`}>
                    {strengthLabel.text}
                  </div>
                </div>
              )}
            </div>

            {/* Confirm Password */}
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                Подтверждение пароля<span className={styles.required}>*</span>
              </label>
              <div className={styles.inputWrapper}>
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  className={`${styles.formInput} ${styles.withIcon} ${confirmPassword && !passwordsMatch ? styles.error : ''}`}
                  placeholder="Повторите пароль"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="new-password"
                />
                <div className={styles.inputIcon} onClick={() => setShowConfirmPassword(!showConfirmPassword)}>
                  {showConfirmPassword ? (
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
              {confirmPassword && !passwordsMatch && (
                <div className={`${styles.formHint} ${styles.error}`}>Пароли не совпадают</div>
              )}
            </div>

            <button
              type="submit"
              className={styles.submitBtn}
              disabled={loading || !isFormValid}
            >
              {loading ? (
                <div className={styles.spinner} />
              ) : (
                <>
                  <span>Отправить заявку</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="12 5 19 12 12 19"/>
                  </svg>
                </>
              )}
            </button>

            <Link to="/login" className={styles.backLink}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="19" y1="12" x2="5" y2="12"/>
                <polyline points="12 19 5 12 12 5"/>
              </svg>
              Уже есть аккаунт? Войти
            </Link>
          </form>
        </div>

        <div className={styles.footer}>
          <p>Нужна помощь? <a href="#">Обратитесь в поддержку</a></p>
        </div>
      </div>
    </div>
  );
};
