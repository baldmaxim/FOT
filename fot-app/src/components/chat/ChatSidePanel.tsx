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
  const [showChat, setShowChat] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Reset view when panel closes
  useEffect(() => {
    if (!isOpen) {
      setShowChat(false);
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
    }
  }, [isOpen]);

  // Search users
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
    setShowChat(true);
  };

  const handleSelectConversation = async (convId: string) => {
    await selectConversation(convId);
    setShowChat(true);
  };

  const handleBack = () => {
    setShowChat(false);
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
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
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
        {/* Header */}
        <div className={styles.panelHeader}>
          {showChat && activeConversation ? (
            <>
              <button className={styles.backBtn} onClick={handleBack}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                  <path d="M15 18l-6-6 6-6"/>
                </svg>
              </button>
              <div className={styles.avatar}>
                {getInitials(getOtherName(activeConversation.participants))}
              </div>
              <span className={styles.headerName}>
                {getOtherName(activeConversation.participants)}
              </span>
            </>
          ) : (
            <>
              <h3 className={styles.headerTitle}>Сообщения</h3>
              <button className={styles.newChatBtn} onClick={() => setSearchOpen(!searchOpen)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </button>
            </>
          )}
          <button className={styles.closeBtn} onClick={closeChat}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Content */}
        {showChat && activeConversationId ? (
          /* Chat view */
          <div className={styles.chatView}>
            <div className={styles.messagesContainer}>
              {loading ? (
                <div className={styles.placeholder}>Загрузка...</div>
              ) : messages.length === 0 ? (
                <div className={styles.placeholder}>Начните диалог</div>
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
                          <div className={styles.messageTime}>{formatTime(msg.created_at)}</div>
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
                placeholder="Напишите сообщение..."
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
              />
              <button className={styles.sendBtn} onClick={handleSend} disabled={!inputValue.trim()}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            </div>
          </div>
        ) : (
          /* Conversation list view */
          <div className={styles.listView}>
            {searchOpen && (
              <div className={styles.searchSection}>
                <input
                  type="text"
                  placeholder="Поиск по имени..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                  autoFocus
                />
                <div className={styles.searchResults}>
                  {searchResults.length === 0 ? (
                    <div className={styles.emptyList}>Пользователи не найдены</div>
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
                          {conv.last_message?.content?.slice(0, 40) || 'Нет сообщений'}
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
        )}
      </div>
    </>
  );
};
