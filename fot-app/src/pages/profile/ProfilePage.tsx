import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { apiClient } from '../../api/client';
import { ShieldIcon, MailIcon, CalendarIcon, UserIcon } from '../../components/ui/Icons';
import styles from './ProfilePage.module.css';

export const ProfilePage: React.FC = () => {
  const { user, profile, refreshProfile, isTwoFactorEnabled, getRoleLabel } = useAuth();
  const { showToast } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [fullName, setFullName] = useState(profile?.full_name || '');
  const [isSaving, setIsSaving] = useState(false);
  // 2FA setup state
  const [showSetup2FA, setShowSetup2FA] = useState(false);
  const [twoFAData, setTwoFAData] = useState<{ secret: string; qrCode: string; recoveryCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [isEnabling2FA, setIsEnabling2FA] = useState(false);

  useEffect(() => {
    setFullName(profile?.full_name || '');
  }, [profile?.full_name]);

  const handleSaveName = async () => {
    if (!fullName.trim()) {
      showToast('error', 'Введите имя');
      return;
    }

    setIsSaving(true);
    try {
      await apiClient.patch('/auth/profile', { full_name: fullName.trim() });
      await refreshProfile();
      setIsEditing(false);
      showToast('success', 'Имя успешно обновлено');
    } catch {
      showToast('error', 'Ошибка при сохранении');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSetup2FA = async () => {
    try {
      const data = await apiClient.post<{ secret: string; qrCode: string; recoveryCodes: string[] }>('/auth/2fa/setup');
      setTwoFAData(data);
      setShowSetup2FA(true);
    } catch {
      showToast('error', 'Ошибка при настройке 2FA');
    }
  };

  const handleEnable2FA = async () => {
    if (!verifyCode.trim()) {
      showToast('error', 'Введите код подтверждения');
      return;
    }

    setIsEnabling2FA(true);
    try {
      await apiClient.post('/auth/2fa/enable', { code: verifyCode });
      await refreshProfile();
      setShowSetup2FA(false);
      setTwoFAData(null);
      setVerifyCode('');
      showToast('success', 'Двухфакторная аутентификация включена');
    } catch {
      showToast('error', 'Неверный код подтверждения');
    } finally {
      setIsEnabling2FA(false);
    }
  };

  const handleDisable2FA = async () => {
    if (!confirm('Вы уверены, что хотите отключить двухфакторную аутентификацию?')) {
      return;
    }

    try {
      await apiClient.post('/auth/2fa/disable');
      await refreshProfile();
      showToast('success', 'Двухфакторная аутентификация отключена');
    } catch {
      showToast('error', 'Ошибка при отключении 2FA');
    }
  };

  const getInitials = (name: string | null) => {
    if (!name) return '??';
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Личный кабинет</h1>
      </div>

      <div className={styles.profileCard}>
        <div className={styles.avatarSection}>
          <div className={styles.avatar}>
            {getInitials(profile?.full_name || null)}
          </div>
          <div className={styles.avatarInfo}>
            {isEditing ? (
              <div className={styles.editName}>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className={styles.nameInput}
                  placeholder="Введите имя"
                  autoFocus
                />
                <div className={styles.editActions}>
                  <button
                    onClick={handleSaveName}
                    className={styles.saveBtn}
                    disabled={isSaving}
                  >
                    {isSaving ? 'Сохранение...' : 'Сохранить'}
                  </button>
                  <button
                    onClick={() => {
                      setIsEditing(false);
                      setFullName(profile?.full_name || '');
                    }}
                    className={styles.cancelBtn}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h2 className={styles.name}>{profile?.full_name || 'Не указано'}</h2>
                <button onClick={() => setIsEditing(true)} className={styles.editBtn}>
                  Редактировать
                </button>
              </>
            )}
          </div>
        </div>

        <div className={styles.infoSection}>
          <div className={styles.infoItem}>
            <div className={styles.infoIcon}>
              <MailIcon />
            </div>
            <div className={styles.infoContent}>
              <span className={styles.infoLabel}>Email</span>
              <span className={styles.infoValue}>{user?.email || '—'}</span>
            </div>
          </div>

          <div className={styles.infoItem}>
            <div className={styles.infoIcon}>
              <UserIcon />
            </div>
            <div className={styles.infoContent}>
              <span className={styles.infoLabel}>Должность</span>
              <span className={styles.infoValue}>
                {profile?.position_type ? getRoleLabel(profile.position_type) : '—'}
              </span>
            </div>
          </div>

          <div className={styles.infoItem}>
            <div className={styles.infoIcon}>
              <CalendarIcon />
            </div>
            <div className={styles.infoContent}>
              <span className={styles.infoLabel}>Дата регистрации</span>
              <span className={styles.infoValue}>
                {profile?.created_at ? formatDate(profile.created_at) : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.securityCard}>
        <h3 className={styles.sectionTitle}>
          <ShieldIcon className={styles.sectionIcon} />
          Безопасность
        </h3>

        <div className={styles.securityItem}>
          <div className={styles.securityInfo}>
            <span className={styles.securityLabel}>Двухфакторная аутентификация</span>
            <span className={styles.securityStatus}>
              {isTwoFactorEnabled ? (
                <span className={styles.statusEnabled}>Включена</span>
              ) : (
                <span className={styles.statusDisabled}>Отключена</span>
              )}
            </span>
          </div>
          {isTwoFactorEnabled ? (
            <button onClick={handleDisable2FA} className={styles.dangerBtn}>
              Отключить
            </button>
          ) : (
            <button onClick={handleSetup2FA} className={styles.primaryBtn}>
              Включить
            </button>
          )}
        </div>
      </div>

      {/* 2FA Setup Modal */}
      {showSetup2FA && twoFAData && (
        <div className={styles.modalOverlay} onClick={() => setShowSetup2FA(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>Настройка 2FA</h2>
              <button
                className={styles.closeBtn}
                onClick={() => setShowSetup2FA(false)}
              >
                ×
              </button>
            </div>
            <div className={styles.modalContent}>
              <div className={styles.qrSection}>
                <p>Отсканируйте QR-код в приложении аутентификации:</p>
                <img src={twoFAData.qrCode} alt="QR Code" />
              </div>

              <div className={styles.secretSection}>
                <p>Или введите код вручную:</p>
                <code>{twoFAData.secret}</code>
              </div>

              <div className={styles.recoverySection}>
                <p>Сохраните коды восстановления в безопасном месте:</p>
                <div className={styles.recoveryCodes}>
                  {twoFAData.recoveryCodes.map((code, index) => (
                    <code key={index}>{code}</code>
                  ))}
                </div>
              </div>

              <div className={styles.verifySection}>
                <p>Введите код из приложения для подтверждения:</p>
                <input
                  type="text"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  className={styles.verifyInput}
                  placeholder="000000"
                  maxLength={6}
                />
                <button
                  onClick={handleEnable2FA}
                  className={styles.primaryBtn}
                  disabled={isEnabling2FA}
                >
                  {isEnabling2FA ? 'Проверка...' : 'Подтвердить'}
                </button>
              </div>

              <div className={styles.warning}>
                Внимание: после включения 2FA вам потребуется вводить код из приложения при каждом входе.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
