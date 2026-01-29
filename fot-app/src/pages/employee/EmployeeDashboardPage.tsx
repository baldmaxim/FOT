import React, { useState } from 'react';
import styles from './EmployeeDashboard.module.css';

// Quick action types
type RequestType = 'vacation' | 'sick' | 'remote' | 'docs';

interface Request {
  id: string;
  type: 'vacation' | 'sick' | 'remote' | 'overtime';
  title: string;
  dates: string;
  status: 'pending' | 'approved' | 'rejected' | 'draft';
}

// Mock data
const mockRequests: Request[] = [
  { id: '1', type: 'vacation', title: 'Ежегодный отпуск', dates: '15 фев – 28 фев · 14 дней', status: 'pending' },
  { id: '2', type: 'remote', title: 'Удалённая работа', dates: '30 янв · 1 день', status: 'approved' },
  { id: '3', type: 'overtime', title: 'Сверхурочные', dates: '25 янв · 4 часа', status: 'approved' },
  { id: '4', type: 'sick', title: 'Больничный лист', dates: '10 янв – 14 янв · 5 дней', status: 'approved' },
];

export const EmployeeDashboardPage: React.FC = () => {
  const [activeModal, setActiveModal] = useState<RequestType | null>(null);

  const getStatusLabel = (status: Request['status']) => {
    switch (status) {
      case 'pending': return 'На согласовании';
      case 'approved': return 'Одобрено';
      case 'rejected': return 'Отклонено';
      case 'draft': return 'Черновик';
    }
  };

  const today = new Date();
  const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const currentDay = today.getDay() === 0 ? 6 : today.getDay() - 1;

  // Generate week dates
  const getWeekDates = () => {
    const dates = [];
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - currentDay);

    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfWeek);
      date.setDate(startOfWeek.getDate() + i);
      dates.push(date.getDate());
    }
    return dates;
  };

  const weekDates = getWeekDates();

  return (
    <div className={styles.content}>
      {/* Quick Actions */}
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Подать заявление</h2>
      </div>
      <div className={styles.quickActionsGrid}>
        <div className={styles.quickActionCard} onClick={() => setActiveModal('vacation')}>
          <div className={`${styles.quickActionIcon} ${styles.vacation}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <div className={styles.quickActionTitle}>Отпуск</div>
          <div className={styles.quickActionDesc}>Ежегодный оплачиваемый</div>
        </div>
        <div className={styles.quickActionCard} onClick={() => setActiveModal('sick')}>
          <div className={`${styles.quickActionIcon} ${styles.sick}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
            </svg>
          </div>
          <div className={styles.quickActionTitle}>Больничный</div>
          <div className={styles.quickActionDesc}>Листок нетрудоспособности</div>
        </div>
        <div className={styles.quickActionCard} onClick={() => setActiveModal('remote')}>
          <div className={`${styles.quickActionIcon} ${styles.remote}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </div>
          <div className={styles.quickActionTitle}>Удалёнка</div>
          <div className={styles.quickActionDesc}>Работа из дома</div>
        </div>
        <div className={styles.quickActionCard} onClick={() => setActiveModal('docs')}>
          <div className={`${styles.quickActionIcon} ${styles.docs}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
          </div>
          <div className={styles.quickActionTitle}>Справка</div>
          <div className={styles.quickActionDesc}>Запросить документ</div>
        </div>
      </div>

      {/* Content Grid */}
      <div className={styles.contentGrid}>
        {/* Requests List */}
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Мои заявления</h2>
            <span className={styles.sectionAction}>Все заявления →</span>
          </div>
          <div className={styles.requestsList}>
            {mockRequests.map((request) => (
              <div key={request.id} className={styles.requestItem}>
                <div className={`${styles.requestIcon} ${styles[request.type]}`}>
                  {request.type === 'vacation' && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M12 6v6l4 2"/>
                    </svg>
                  )}
                  {request.type === 'remote' && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                      <polyline points="9 22 9 12 15 12 15 22"/>
                    </svg>
                  )}
                  {request.type === 'sick' && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                    </svg>
                  )}
                  {request.type === 'overtime' && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                  )}
                </div>
                <div className={styles.requestContent}>
                  <div className={styles.requestTitle}>{request.title}</div>
                  <div className={styles.requestMeta}>{request.dates}</div>
                </div>
                <div className={`${styles.requestStatus} ${styles[request.status]}`}>
                  {getStatusLabel(request.status)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Column */}
        <div className={styles.infoCards}>
          {/* Vacation Balance */}
          <div className={styles.infoCard}>
            <div className={styles.infoCardHeader}>
              <div className={`${styles.infoCardIcon} ${styles.vacation}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 6v6l4 2"/>
                </svg>
              </div>
              <div className={styles.infoCardTitle}>Баланс отпуска</div>
            </div>
            <div className={styles.vacationBalance}>
              <span className={styles.vacationBalanceValue}>18</span>
              <span className={styles.vacationBalanceLabel}>дней доступно</span>
            </div>
            <div className={styles.vacationDetails}>
              <div className={styles.vacationDetail}>
                <span className={styles.vacationDetailLabel}>Начислено за год</span>
                <span className={styles.vacationDetailValue}>28 дней</span>
              </div>
              <div className={styles.vacationDetail}>
                <span className={styles.vacationDetailLabel}>Использовано</span>
                <span className={styles.vacationDetailValue}>10 дней</span>
              </div>
              <div className={styles.vacationDetail}>
                <span className={styles.vacationDetailLabel}>Запланировано</span>
                <span className={styles.vacationDetailValue}>14 дней</span>
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div className={styles.infoCard}>
            <div className={styles.infoCardHeader}>
              <div className={`${styles.infoCardIcon} ${styles.schedule}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
              </div>
              <div className={styles.infoCardTitle}>График работы</div>
            </div>
            <div className={styles.scheduleToday}>
              <span className={styles.scheduleTodayLabel}>Сегодня</span>
              <span className={styles.scheduleTodayValue}>09:00 – 18:00</span>
            </div>
            <div className={styles.scheduleWeek}>
              {weekDays.map((day, index) => (
                <div
                  key={day}
                  className={`${styles.scheduleDay} ${index === currentDay ? styles.today : ''} ${index >= 5 ? styles.weekend : ''}`}
                >
                  <div className={styles.scheduleDayName}>{day}</div>
                  <div className={styles.scheduleDayNum}>{weekDates[index]}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Notifications */}
          <div className={styles.notificationsCard}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Уведомления</h2>
              <span className={styles.sectionAction}>Все →</span>
            </div>
            <div className={styles.notificationItem}>
              <div className={styles.notificationDot}></div>
              <div className={styles.notificationContent}>
                <div className={styles.notificationText}>
                  <strong>Иванов И.С.</strong> согласовал вашу заявку на удалёнку
                </div>
                <div className={styles.notificationTime}>2 часа назад</div>
              </div>
            </div>
            <div className={styles.notificationItem}>
              <div className={`${styles.notificationDot} ${styles.read}`}></div>
              <div className={styles.notificationContent}>
                <div className={styles.notificationText}>
                  Расчётный листок за <strong>январь</strong> доступен
                </div>
                <div className={styles.notificationTime}>Вчера</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modal */}
      {activeModal && (
        <div className={styles.modalOverlay} onClick={() => setActiveModal(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>
                {activeModal === 'vacation' && 'Заявление на отпуск'}
                {activeModal === 'sick' && 'Больничный лист'}
                {activeModal === 'remote' && 'Удалённая работа'}
                {activeModal === 'docs' && 'Запрос справки'}
              </h2>
              <button className={styles.modalClose} onClick={() => setActiveModal(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <div className={styles.modalBody}>
              {activeModal === 'vacation' && (
                <>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Тип отпуска <span className={styles.required}>*</span>
                    </label>
                    <select className={styles.formSelect}>
                      <option>Ежегодный оплачиваемый</option>
                      <option>За свой счёт</option>
                      <option>Учебный</option>
                    </select>
                  </div>
                  <div className={styles.formRow}>
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>
                        Дата начала <span className={styles.required}>*</span>
                      </label>
                      <input type="date" className={styles.formInput} />
                    </div>
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>
                        Дата окончания <span className={styles.required}>*</span>
                      </label>
                      <input type="date" className={styles.formInput} />
                    </div>
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Комментарий</label>
                    <textarea className={styles.formTextarea} placeholder="Дополнительная информация..." />
                  </div>
                </>
              )}
              {activeModal === 'sick' && (
                <>
                  <div className={styles.formRow}>
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>
                        Дата начала <span className={styles.required}>*</span>
                      </label>
                      <input type="date" className={styles.formInput} />
                    </div>
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>Дата окончания</label>
                      <input type="date" className={styles.formInput} />
                    </div>
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Номер больничного листа</label>
                    <input type="text" className={styles.formInput} placeholder="Номер ЭЛН" />
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Комментарий</label>
                    <textarea className={styles.formTextarea} placeholder="Дополнительная информация..." />
                  </div>
                </>
              )}
              {activeModal === 'remote' && (
                <>
                  <div className={styles.formRow}>
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>
                        Дата <span className={styles.required}>*</span>
                      </label>
                      <input type="date" className={styles.formInput} />
                    </div>
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>
                        До даты
                      </label>
                      <input type="date" className={styles.formInput} />
                    </div>
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Причина <span className={styles.required}>*</span>
                    </label>
                    <textarea className={styles.formTextarea} placeholder="Укажите причину работы из дома..." />
                  </div>
                </>
              )}
              {activeModal === 'docs' && (
                <>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Тип справки <span className={styles.required}>*</span>
                    </label>
                    <select className={styles.formSelect}>
                      <option>2-НДФЛ</option>
                      <option>Справка с места работы</option>
                      <option>Копия трудовой книжки</option>
                      <option>Справка о доходах</option>
                    </select>
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Период (для 2-НДФЛ)</label>
                    <select className={styles.formSelect}>
                      <option>2025 год</option>
                      <option>2024 год</option>
                      <option>2023 год</option>
                    </select>
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Комментарий</label>
                    <textarea className={styles.formTextarea} placeholder="Для чего нужна справка..." />
                  </div>
                </>
              )}
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.btnSecondary} onClick={() => setActiveModal(null)}>
                Отмена
              </button>
              <button className={styles.btnPrimary}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                Отправить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
