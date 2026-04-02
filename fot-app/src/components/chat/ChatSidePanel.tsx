import React, { useState, useRef, useEffect, type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useChatContext } from '../../contexts/ChatContext';
import { chatService, type IChatUser } from '../../services/chatService';
import styles from './ChatSidePanel.module.css';

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
  }, [isOpen]);

  useEffect(() => {
    if (!searchOpen) return;
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

  const handleStartChat = async (user: IChatUser) => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    await startConversation(user.id);
    setMobileShowChat(true);
  };

  const handleSelectConversation = async (convId: string) => {
    await selectConversation(convId);
    setMobileShowChat(true);
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
        {/* Left pane: conversation list */}
        <div className={`${styles.listPane} ${mobileShowChat ? styles.hidden : ''}`}>
          <div className={styles.listPaneHeader}>
            <h3 className={styles.listPaneTitle}>Чаты</h3>
            <button className={styles.iconBtn} onClick={() => setSearchOpen(!searchOpen)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>
            <button className={styles.iconBtn} onClick={closeChat}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {searchOpen && (
            <div className={styles.searchSection}>
              <input
                type="text"
                placeholder="Поиск..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className={styles.searchInput}
                autoFocus
              />
              <div className={styles.searchResults}>
                {searchResults.length === 0 ? (
                  <div className={styles.emptyList}>Не найдено</div>
                ) : (
                  searchResults.map(user => (
                    <div key={user.id} className={styles.searchItem} onClick={() => handleStartChat(user)}>
                      <div className={styles.avatarSmall}>{getInitials(user.full_name || '??')}</div>
                      <span>{user.full_name}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

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
        </div>

        {/* Right pane: chat */}
        <div className={`${styles.chatPane} ${!mobileShowChat ? styles.hidden : ''}`}>
          {!activeConversationId ? (
            <div className={styles.chatPlaceholder}>Выберите диалог</div>
          ) : (
            <>
              <div className={styles.chatPaneHeader}>
                {/* Back button only on mobile */}
                <button
                  className={styles.iconBtn}
                  onClick={() => setMobileShowChat(false)}
                  style={{ display: 'none' }}
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
