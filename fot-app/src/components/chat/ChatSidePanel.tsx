import React, { useState, useRef, useEffect, type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useChatContext } from '../../contexts/ChatContext';
import { chatService, type IChatUser } from '../../services/chatService';
import styles from './ChatSidePanel.module.css';

const CheckIcon: FC<{ double?: boolean; className?: string }> = ({ double, className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14">
    {double ? (
      <>
        <polyline points="1 13 5 17 12 6" />
        <polyline points="7 13 11 17 18 6" />
      </>
    ) : (
      <polyline points="4 13 8 17 16 6" />
    )}
  </svg>
);

export const ChatSidePanel: FC = () => {
  const { profile, isAuthenticated, isApproved } = useAuth();
  const {
    isOpen,
    closeChat,
    conversations,
    activeConversationId,
    messages,
    loading,
    selectConversation,
    sendMessage,
    startConversation,
  } = useChatContext();

  const [inputValue, setInputValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<IChatUser[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!isOpen) {
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      setMobileShowChat(false);
    }
    // Блокируем скролл основной страницы при открытом чате
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  useEffect(() => {
    if (!searchOpen) { setSearchResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const results = await chatService.searchUsers(searchQuery);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchQuery, searchOpen]);

  const handleSend = async () => {
    if (!inputValue.trim()) return;
    const text = inputValue;
    setInputValue('');
    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStartChat = (user: IChatUser) => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setMobileShowChat(true);
    startConversation(user.id);
  };

  const handleSelectConversation = (convId: string) => {
    setMobileShowChat(true);
    selectConversation(convId);
  };

  const handleToggleSearch = () => {
    setSearchOpen(prev => {
      if (prev) { setSearchQuery(''); setSearchResults([]); }
      return !prev;
    });
  };

  const getOtherName = (participants: { user_id: string; full_name: string | null }[]) => {
    const other = participants.find(p => p.user_id !== profile?.id);
    return other?.full_name || 'Неизвестный';
  };

  const getInitials = (name: string) => {
    const parts = name.split(' ');
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) +
      ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  };

  const formatDateLabel = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Сегодня';
    if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const activeConversation = conversations.find(c => c.id === activeConversationId);

  if (!isAuthenticated || !isApproved) return null;

  return (
    <>
      {isOpen && <div className={styles.overlay} onClick={closeChat} />}
      <div className={`${styles.panel} ${isOpen ? styles.open : ''}`}>
        {/* Left pane */}
        <div className={`${styles.listPane} ${mobileShowChat ? styles.hidden : ''}`}>
          <div className={styles.listPaneHeader}>
            <h3 className={styles.listPaneTitle}>{searchOpen ? 'Новый чат' : 'Чаты'}</h3>
            {/* + / отмена поиска — только на десктопе */}
            <button className={`${styles.iconBtn} ${styles.desktopOnly} ${searchOpen ? styles.iconBtnActive : ''}`} onClick={handleToggleSearch}>
              {searchOpen ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              )}
            </button>
            {/* Мобильные: + новый чат */}
            <button className={`${styles.iconBtn} ${styles.mobileOnly}`} onClick={handleToggleSearch}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                {searchOpen
                  ? <path d="M18 6L6 18M6 6l12 12"/>
                  : <path d="M12 5v14M5 12h14"/>
                }
              </svg>
            </button>
            {/* Мобильные: закрыть чат */}
            <button className={`${styles.iconBtn} ${styles.mobileOnly}`} onClick={closeChat}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {searchOpen ? (
            /* Режим поиска: другой фон, только результаты */
            <div className={styles.searchPane}>
              <div className={styles.searchSection}>
                <input
                  type="text"
                  placeholder="Имя сотрудника..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                  autoFocus
                />
              </div>
              <div className={styles.searchResultsList}>
                {searchResults.length === 0 ? (
                  <div className={styles.emptyList}>{searchQuery ? 'Не найдено' : 'Введите имя'}</div>
                ) : (
                  searchResults.map(user => (
                    <div key={user.id} className={styles.searchItem} onClick={() => handleStartChat(user)}>
                      <div className={styles.avatarSmall}>{getInitials(user.full_name || '??')}</div>
                      <div className={styles.searchItemInfo}>
                        <span className={styles.searchItemName}>{user.full_name}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Обычный режим: список диалогов */
            <div className={styles.conversationList}>
              {conversations.length === 0 ? (
                <div className={styles.emptyList}>Нет диалогов</div>
              ) : (
                conversations.map(conv => {
                  const otherName = getOtherName(conv.participants);
                  return (
                    <div
                      key={conv.id}
                      className={`${styles.conversationItem} ${activeConversationId === conv.id ? styles.active : ''}`}
                      onClick={() => handleSelectConversation(conv.id)}
                    >
                      <div className={styles.avatarSmall}>{getInitials(otherName)}</div>
                      <div className={styles.convInfo}>
                        <div className={styles.convName}>{otherName}</div>
                        <div className={styles.convPreview}>
                          {conv.last_message?.content?.slice(0, 30) || 'Нет сообщений'}
                        </div>
                      </div>
                      <div className={styles.convMeta}>
                        {conv.last_message && (
                          <span className={styles.convTime}>{formatTime(conv.last_message.created_at)}</span>
                        )}
                        {conv.unread_count > 0 && (
                          <span className={styles.unreadBadge}>{conv.unread_count}</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Right pane: chat */}
        <div className={`${styles.chatPane} ${!mobileShowChat ? styles.hidden : ''}`}>
          {!activeConversationId ? (
            <div className={styles.chatPlaceholder}>
              <button className={styles.iconBtn} onClick={closeChat} style={{ position: 'absolute', top: 12, right: 12 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
              Выберите диалог
            </div>
          ) : (
            <>
              <div className={styles.chatPaneHeader}>
                <button
                  className={`${styles.iconBtn} ${styles.backBtn}`}
                  onClick={() => setMobileShowChat(false)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M15 18l-6-6 6-6"/>
                  </svg>
                </button>
                <div className={styles.avatar}>
                  {getInitials(activeConversation ? getOtherName(activeConversation.participants) : '??')}
                </div>
                <span className={styles.headerName}>
                  {activeConversation ? getOtherName(activeConversation.participants) : ''}
                </span>
                <button className={styles.iconBtn} onClick={closeChat} style={{ marginLeft: 'auto' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>

              <div className={styles.messagesContainer}>
                {loading ? (
                  <div className={styles.chatPlaceholder}>Загрузка...</div>
                ) : messages.length === 0 ? (
                  <div className={styles.chatPlaceholder}>Начните диалог</div>
                ) : (
                  messages.map((msg, idx) => {
                    const isMine = msg.sender_id === profile?.id;
                    const msgDate = new Date(msg.created_at).toDateString();
                    const prevDate = idx > 0 ? new Date(messages[idx - 1].created_at).toDateString() : null;
                    const showDate = idx === 0 || msgDate !== prevDate;

                    return (
                      <React.Fragment key={msg.id}>
                        {showDate && (
                          <div className={styles.dateSeparator}>
                            <span className={styles.dateLabel}>{formatDateLabel(msg.created_at)}</span>
                          </div>
                        )}
                        <div className={`${styles.message} ${isMine ? styles.mine : styles.theirs}`}>
                          <div className={styles.messageBubble}>
                            <div className={styles.messageText}>{msg.content}</div>
                            <span className={styles.messageTime}>
                              {new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                              {isMine && (
                                <CheckIcon double={msg.is_read} className={`${styles.readCheck} ${msg.is_read ? styles.readCheckRead : ''}`} />
                              )}
                            </span>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className={styles.inputArea}>
                <textarea
                  className={styles.messageInput}
                  placeholder="Сообщение..."
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
                <button className={styles.sendBtn} onClick={handleSend} disabled={!inputValue.trim()}>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
};
