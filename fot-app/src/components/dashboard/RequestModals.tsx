import type { FC } from 'react';
import styles from '../../pages/employee/EmployeeDashboard.module.css';

type RequestType = 'vacation' | 'sick' | 'remote' | 'docs';

interface IRequestModalProps {
  activeModal: RequestType;
  onClose: () => void;
}

export const RequestModal: FC<IRequestModalProps> = ({ activeModal, onClose }) => (
  <div className={styles.modalOverlay} onClick={onClose}>
    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>
          {activeModal === 'vacation' && 'Заявление на отпуск'}
          {activeModal === 'sick' && 'Больничный лист'}
          {activeModal === 'remote' && 'Удалённая работа'}
          {activeModal === 'docs' && 'Запрос справки'}
        </h2>
        <button className={styles.modalClose} onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div className={styles.modalBody}>
        {activeModal === 'vacation' && (
          <>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Тип отпуска <span className={styles.required}>*</span></label>
              <select className={styles.formSelect}><option>Ежегодный оплачиваемый</option><option>За свой счёт</option><option>Учебный</option></select>
            </div>
            <div className={styles.formRow}>
              <div className={styles.formGroup}><label className={styles.formLabel}>Дата начала <span className={styles.required}>*</span></label><input type="date" className={styles.formInput} /></div>
              <div className={styles.formGroup}><label className={styles.formLabel}>Дата окончания <span className={styles.required}>*</span></label><input type="date" className={styles.formInput} /></div>
            </div>
            <div className={styles.formGroup}><label className={styles.formLabel}>Комментарий</label><textarea className={styles.formTextarea} placeholder="Дополнительная информация..." /></div>
          </>
        )}
        {activeModal === 'sick' && (
          <>
            <div className={styles.formRow}>
              <div className={styles.formGroup}><label className={styles.formLabel}>Дата начала <span className={styles.required}>*</span></label><input type="date" className={styles.formInput} /></div>
              <div className={styles.formGroup}><label className={styles.formLabel}>Дата окончания</label><input type="date" className={styles.formInput} /></div>
            </div>
            <div className={styles.formGroup}><label className={styles.formLabel}>Номер больничного листа</label><input type="text" className={styles.formInput} placeholder="Номер ЭЛН" /></div>
            <div className={styles.formGroup}><label className={styles.formLabel}>Комментарий</label><textarea className={styles.formTextarea} placeholder="Дополнительная информация..." /></div>
          </>
        )}
        {activeModal === 'remote' && (
          <>
            <div className={styles.formRow}>
              <div className={styles.formGroup}><label className={styles.formLabel}>Дата <span className={styles.required}>*</span></label><input type="date" className={styles.formInput} /></div>
              <div className={styles.formGroup}><label className={styles.formLabel}>До даты</label><input type="date" className={styles.formInput} /></div>
            </div>
            <div className={styles.formGroup}><label className={styles.formLabel}>Причина <span className={styles.required}>*</span></label><textarea className={styles.formTextarea} placeholder="Укажите причину работы из дома..." /></div>
          </>
        )}
        {activeModal === 'docs' && (
          <>
            <div className={styles.formGroup}><label className={styles.formLabel}>Тип справки <span className={styles.required}>*</span></label><select className={styles.formSelect}><option>2-НДФЛ</option><option>Справка с места работы</option><option>Копия трудовой книжки</option><option>Справка о доходах</option></select></div>
            <div className={styles.formGroup}><label className={styles.formLabel}>Период (для 2-НДФЛ)</label><select className={styles.formSelect}><option>2025 год</option><option>2024 год</option><option>2023 год</option></select></div>
            <div className={styles.formGroup}><label className={styles.formLabel}>Комментарий</label><textarea className={styles.formTextarea} placeholder="Для чего нужна справка..." /></div>
          </>
        )}
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.btnSecondary} onClick={onClose}>Отмена</button>
        <button className={styles.btnPrimary}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          Отправить
        </button>
      </div>
    </div>
  </div>
);

interface ITwoFAModalProps {
  twoFAData: { secret: string; qrCode: string; recoveryCodes: string[] };
  verifyCode: string;
  setVerifyCode: (v: string) => void;
  isEnabling2FA: boolean;
  onEnable: () => void;
  onClose: () => void;
}

export const TwoFAModal: FC<ITwoFAModalProps> = ({ twoFAData, verifyCode, setVerifyCode, isEnabling2FA, onEnable, onClose }) => (
  <div className={styles.modalOverlay} onClick={onClose}>
    <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
      <div className={styles.modalHeader}>
        <h2 className={styles.modalTitle}>Настройка 2FA</h2>
        <button className={styles.modalClose} onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div className={styles.modalBody}>
        <p style={{ marginBottom: 12, fontSize: 13 }}>Отсканируйте QR-код в приложении аутентификации:</p>
        <img src={twoFAData.qrCode} alt="QR" style={{ display: 'block', margin: '0 auto 16px', maxWidth: 200 }} />
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>Или введите вручную:</p>
        <code style={{ display: 'block', padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, fontSize: 12, marginBottom: 16, wordBreak: 'break-all' }}>{twoFAData.secret}</code>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Код из приложения</label>
          <input type="text" className={styles.formInput} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="000000" maxLength={6} />
        </div>
      </div>
      <div className={styles.modalFooter}>
        <button className={styles.btnSecondary} onClick={onClose}>Отмена</button>
        <button className={styles.btnPrimary} onClick={onEnable} disabled={isEnabling2FA}>
          {isEnabling2FA ? 'Проверка...' : 'Подтвердить'}
        </button>
      </div>
    </div>
  </div>
);
