import React, { useState, useRef, useEffect } from 'react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useSocket } from '../../hooks/useSocket';
import { useChat } from '../../hooks/useChat';
import { chatService, type IChatUser } from '../../services/chatService';
import styles from './ChatPage.module.css';

export const ChatPage: React.FC = () => {
  const { profile, token, getRoleLabel } = useAuth();
  const toast = useToast();
  const ws = useSocket(token);
  const {
    conversations,
    activeConversationId,
    messages,
    loading,
    selectConversation,
    sendMessage,
    startConversation,
    createRequest,
  } = useChat(ws);

  const [inputValue, setInputValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<IChatUser[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Search users for new conversation
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
    if (!inputValue.trim() || !activeConversation?.is_writable) return;
    const text = inputValue;
    setInputValue('');
    try {
      await sendMessage(text);
    } catch (error) {
      setInputValue(text);
      toast.error(error instanceof Error ? error.message : 'Не удалось отправить сообщение');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStartChat = async (user: IChatUser) => {
    try {
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      if (user.availability === 'direct') {
        await startConversation(user.id);
        setMobileShowChat(true);
        return;
      }
      await createRequest(user.id);
      toast.success('Запрос на контакт отправлен');
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Не удалось выполнить действие';
      toast.error(message);
    }
  };

  const handleSelectConversation = async (convId: string) => {
    await selectConversation(convId);
    setMobileShowChat(true);
  };

  // Get the other participant's name
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

  const activeConversation = conversations.find(c => c.id === activeConversationId);

  return (
    <div className={styles.chatLayout}>
      {/* Sidebar — conversation list */}
      <div className={`${styles.sidebar} ${mobileShowChat ? styles.hiddenMobile : ''}`}>
        <div className={styles.sidebarHeader}>
          <h2>Сообщения</h2>
          <button className={styles.newChatBtn} onClick={() => setSearchOpen(!searchOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
        </div>

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
                  <div
                    key={user.id}
                    className={styles.searchItem}
                  >
                    <div className={styles.avatar}>{getInitials(user.full_name || '??')}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>{user.full_name}</div>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        {getRoleLabel(user.position_type)} · {user.availability_reason}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleStartChat(user)}
                      style={{
                        border: '1px solid var(--border)',
                        background: 'var(--bg-secondary, #12121a)',
                        color: 'var(--text-primary, #e0e0e0)',
                        borderRadius: 999,
                        padding: '6px 10px',
                        cursor: 'pointer',
                      }}
                    >
                      {user.availability === 'direct'
                        ? 'Написать'
                        : user.request_status === 'outgoing_pending'
                          ? 'Ожидает'
                          : 'Запросить'}
                    </button>
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
                  <div className={styles.avatar}>{getInitials(otherName)}</div>
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

      {/* Chat area */}
      <div className={`${styles.chatArea} ${!mobileShowChat ? styles.hiddenMobile : ''}`}>
        {!activeConversationId ? (
          <div className={styles.chatPlaceholder}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <p>Выберите диалог или начните новый</p>
          </div>
        ) : (
          <>
            <div className={styles.chatHeader}>
              <button className={styles.backBtn} onClick={() => setMobileShowChat(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                  <path d="M15 18l-6-6 6-6"/>
                </svg>
              </button>
              <div className={styles.avatar}>
                {getInitials(activeConversation ? getOtherName(activeConversation.participants) : '??')}
              </div>
              <span className={styles.chatHeaderName}>
                {activeConversation ? getOtherName(activeConversation.participants) : ''}
              </span>
              {!activeConversation?.is_writable && activeConversation?.write_lock_reason && (
                <span style={{ fontSize: 12, opacity: 0.7 }}>{activeConversation.write_lock_reason}</span>
              )}
            </div>

            <div className={styles.messagesContainer}>
              {loading ? (
                <div className={styles.chatPlaceholder}>Загрузка...</div>
              ) : messages.length === 0 ? (
                <div className={styles.chatPlaceholder}>Начните диалог</div>
              ) : (
                messages.map(msg => {
                  const isMine = msg.sender_id === profile?.id;
                  return (
                    <div
                      key={msg.id}
                      className={`${styles.message} ${isMine ? styles.mine : styles.theirs}`}
                    >
                      <div className={styles.messageBubble}>
                        <div className={styles.messageText}>{msg.content}</div>
                        <div className={styles.messageTime}>{formatTime(msg.created_at)}</div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className={styles.inputArea}>
              <textarea
                className={styles.messageInput}
                placeholder={activeConversation?.is_writable ? 'Напишите сообщение...' : 'Отправка недоступна'}
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                disabled={!activeConversation?.is_writable}
              />
              <button
                className={styles.sendBtn}
                onClick={handleSend}
                disabled={!inputValue.trim() || !activeConversation?.is_writable}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
