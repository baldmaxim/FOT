import React, { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useChatContext } from '../../contexts/ChatContext';
import { useToast } from '../../contexts/ToastContext';
import { useOnlinePresence } from '../../contexts/OnlinePresenceContext';
import { chatService, type IChatContactRequest, type IChatUser } from '../../services/chatService';
import { usePushNotifications, type PushSubscribeResult } from '../../hooks/usePushNotifications';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { OnlineDot } from '../ui/OnlineDot';
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

type PanelTab = 'chats' | 'requests';
type RequestBox = 'inbox' | 'outbox';

const getRequestButtonLabel = (user: IChatUser): string => {
  if (user.request_status === 'outgoing_pending') return 'Ожидает';
  if (user.request_status === 'incoming_pending') return 'Входящий';
  return user.availability === 'direct' ? 'Написать' : 'Запросить';
};

export const ChatSidePanel: FC = () => {
  const { profile, isAuthenticated, isApproved, getRoleLabel } = useAuth();
  const { isUserOnline } = useOnlinePresence();
  const toast = useToast();
  const {
    isOpen,
    closeChat,
    conversations,
    activeConversationId,
    messages,
    incomingRequests,
    outgoingRequests,
    loading,
    selectConversation,
    sendMessage,
    startConversation,
    createRequest,
    approveRequest,
    rejectRequest,
  } = useChatContext();

  const { isSupported: pushSupported, permission, isSubscribed, subscribe, unsubscribe } = usePushNotifications();
  const showPushBanner = pushSupported && permission !== 'denied' && !isSubscribed;
  const overlayHandlers = useOverlayDismiss(closeChat);

  const notifySubscribeResult = (result: PushSubscribeResult): void => {
    switch (result) {
      case 'subscribed':
        toast.success('Уведомления включены');
        break;
      case 'denied':
        toast.warning('Разрешите уведомления для сайта в настройках браузера');
        break;
      case 'dismissed':
        toast.info('Запрос на уведомления закрыт — нажмите ещё раз и выберите «Разрешить»');
        break;
      case 'unsupported':
        toast.warning('Браузер не поддерживает push-уведомления');
        break;
      case 'error':
        toast.error('Не удалось включить уведомления, попробуйте позже');
        break;
    }
  };

  const handleEnablePush = async (): Promise<void> => {
    notifySubscribeResult(await subscribe());
  };

  const handleTogglePush = async (): Promise<void> => {
    if (isSubscribed) {
      const result = await unsubscribe();
      if (result === 'unsubscribed') toast.success('Уведомления отключены');
      else toast.error('Не удалось отключить уведомления');
      return;
    }
    notifySubscribeResult(await subscribe());
  };

  const [activeTab, setActiveTab] = useState<PanelTab>('chats');
  const [requestBox, setRequestBox] = useState<RequestBox>('inbox');
  const [inputValue, setInputValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<IChatUser[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requestActionId, setRequestActionId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  const requests = requestBox === 'inbox' ? incomingRequests : outgoingRequests;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!isOpen) {
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      setMobileShowChat(false);
      setActiveTab('chats');
      setRequestBox('inbox');
    }

    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const panelNode = panelRef.current;

    const update = () => {
      if (!panelNode) return;
      panelNode.style.height = `${viewport.height}px`;
      panelNode.style.top = `${viewport.offsetTop}px`;
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);

    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      if (panelNode) {
        panelNode.style.height = '';
        panelNode.style.top = '';
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!searchOpen || activeTab !== 'chats') {
      setSearchResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        const results = await chatService.searchUsers(searchQuery);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [searchOpen, searchQuery, activeTab]);

  const activeConversation = useMemo(
    () => conversations.find(conversation => conversation.id === activeConversationId) || null,
    [conversations, activeConversationId],
  );

  const handleTouchStart = (event: React.TouchEvent) => {
    touchStartX.current = event.touches[0].clientX;
    touchStartY.current = event.touches[0].clientY;
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    const deltaX = event.touches[0].clientX - touchStartX.current;
    const deltaY = Math.abs(event.touches[0].clientY - touchStartY.current);
    if (deltaX > 10 && deltaX > deltaY && panelRef.current) {
      panelRef.current.style.transform = `translateX(${deltaX}px)`;
      panelRef.current.style.transition = 'none';
    }
  };

  const handleTouchEnd = (event: React.TouchEvent) => {
    const deltaX = event.changedTouches[0].clientX - touchStartX.current;
    if (panelRef.current) {
      panelRef.current.style.transform = '';
      panelRef.current.style.transition = '';
    }
    if (deltaX > 80) closeChat();
  };

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

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const handleStartChat = async (user: IChatUser) => {
    try {
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      await startConversation(user.id);
      setActiveTab('chats');
      setMobileShowChat(true);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Не удалось открыть чат';
      toast.error(message);
    }
  };

  const handleCreateRequest = async (user: IChatUser) => {
    try {
      setRequestActionId(user.id);
      await createRequest(user.id);
      toast.success('Запрос на контакт отправлен');
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Не удалось отправить запрос';
      toast.error(message);
    } finally {
      setRequestActionId(null);
    }
  };

  const handleRequestAction = async (request: IChatContactRequest, action: 'approve' | 'reject') => {
    try {
      setRequestActionId(request.id);
      if (action === 'approve') {
        const result = await approveRequest(request.id);
        setActiveTab('chats');
        setMobileShowChat(true);
        await selectConversation(result.conversation_id);
        toast.success('Запрос одобрен');
      } else {
        await rejectRequest(request.id);
        toast.info('Запрос отклонён');
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Не удалось обработать запрос';
      toast.error(message);
    } finally {
      setRequestActionId(null);
    }
  };

  const handleSelectConversation = async (conversationId: string) => {
    try {
      await selectConversation(conversationId);
      setMobileShowChat(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось открыть диалог');
    }
  };

  const handleToggleSearch = () => {
    setActiveTab('chats');
    setSearchOpen(prev => {
      if (prev) {
        setSearchQuery('');
        setSearchResults([]);
      }
      return !prev;
    });
  };

  const handleSwitchTab = (tab: PanelTab) => {
    setActiveTab(tab);
    if (tab !== 'chats') {
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      setMobileShowChat(false);
    }
  };

  const getOtherName = (participants: { user_id: string; full_name: string | null }[]) => {
    const other = participants.find(participant => participant.user_id !== profile?.id);
    return other?.full_name || 'Неизвестный';
  };

  const getOtherUserId = (participants: { user_id: string; full_name: string | null }[]) => {
    return participants.find(participant => participant.user_id !== profile?.id)?.user_id ?? null;
  };

  const getInitials = (name: string) => {
    const parts = name.split(' ').filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  };

  const formatDateLabel = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === now.toDateString()) return 'Сегодня';
    if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  if (!isAuthenticated || !isApproved) return null;

  return (
    <>
      {isOpen && <div className={styles.overlay} {...overlayHandlers} />}
      <div
        ref={panelRef}
        className={`${styles.panel} ${isOpen ? styles.open : ''}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className={`${styles.listPane} ${mobileShowChat && activeTab === 'chats' ? styles.hidden : ''}`}>
          <div className={styles.listPaneHeader}>
            <button className={`${styles.iconBtn} ${styles.mobileOnly}`} onClick={closeChat}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <h3 className={styles.listPaneTitle}>{activeTab === 'chats' ? (searchOpen ? 'Новый чат' : 'Чаты') : 'Запросы'}</h3>
            <div className={styles.headerActions}>
              <button
                className={`${styles.iconBtn} ${settingsOpen ? styles.iconBtnActive : ''}`}
                onClick={() => setSettingsOpen(prev => !prev)}
                aria-label="Настройки чата"
                aria-expanded={settingsOpen}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              <button
                className={`${styles.iconBtn} ${activeTab === 'chats' && searchOpen ? styles.iconBtnActive : ''}`}
                onClick={activeTab === 'chats' ? handleToggleSearch : () => handleSwitchTab('chats')}
              >
                {activeTab === 'chats' ? (
                  searchOpen ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  )
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M3 12h18" />
                    <path d="M3 6h18" />
                    <path d="M3 18h18" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {settingsOpen && (
            <div className={styles.settingsPanel}>
              {pushSupported ? (
                <>
                  <div className={styles.settingsRow}>
                    <span className={styles.settingsLabel}>Уведомления о сообщениях</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isSubscribed}
                      aria-label="Уведомления о сообщениях"
                      className={`${styles.switch} ${isSubscribed ? styles.switchOn : ''}`}
                      disabled={permission === 'denied'}
                      onClick={() => { void handleTogglePush(); }}
                    >
                      <span className={styles.switchThumb} />
                    </button>
                  </div>
                  {permission === 'denied' && (
                    <p className={styles.settingsHint}>
                      Разрешите уведомления в настройках браузера
                    </p>
                  )}
                </>
              ) : (
                <p className={styles.settingsHint}>
                  Браузер не поддерживает push-уведомления
                </p>
              )}
            </div>
          )}

          <div className={styles.panelTabs}>
            <button
              className={`${styles.panelTab} ${activeTab === 'chats' ? styles.panelTabActive : ''}`}
              onClick={() => handleSwitchTab('chats')}
            >
              Чаты
            </button>
            <button
              className={`${styles.panelTab} ${activeTab === 'requests' ? styles.panelTabActive : ''}`}
              onClick={() => handleSwitchTab('requests')}
            >
              Запросы
              {incomingRequests.filter(request => request.status === 'pending').length > 0 && (
                <span className={styles.panelTabBadge}>
                  {incomingRequests.filter(request => request.status === 'pending').length}
                </span>
              )}
            </button>
          </div>

          {showPushBanner && activeTab === 'chats' && (
            <div className={styles.pushBanner}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ flexShrink: 0 }}>
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span>Уведомления</span>
              <button className={styles.pushBannerBtn} onClick={() => { void handleEnablePush(); }}>
                Включить
              </button>
            </div>
          )}

          {activeTab === 'chats' && searchOpen ? (
            <div className={styles.searchPane}>
              <div className={styles.searchSection}>
                <input
                  type="text"
                  placeholder="Имя сотрудника..."
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
                  className={styles.searchInput}
                  autoFocus
                />
              </div>
              <div className={styles.searchResultsList}>
                {searchResults.length === 0 ? (
                  <div className={styles.emptyList}>{searchQuery ? 'Ничего не найдено' : 'Введите имя сотрудника'}</div>
                ) : (
                  searchResults.map(user => (
                    <div key={user.id} className={styles.searchItem}>
                      <div className={styles.avatarSmall}>{getInitials(user.full_name || '??')}</div>
                      <div className={styles.searchItemInfo}>
                        <span className={styles.searchItemName}>
                          <OnlineDot online={isUserOnline(user.id)} /> {user.full_name || 'Без имени'}
                        </span>
                        <span className={styles.searchItemMeta}>
                          {getRoleLabel(user.position_type)} · {user.availability_reason}
                        </span>
                      </div>
                      <button
                        className={`${styles.searchActionBtn} ${user.availability === 'request' ? styles.searchActionRequest : ''}`}
                        disabled={requestActionId === user.id || user.request_status !== null}
                        onClick={() => {
                          if (user.availability === 'direct') {
                            void handleStartChat(user);
                          } else {
                            void handleCreateRequest(user);
                          }
                        }}
                      >
                        {requestActionId === user.id ? '...' : getRequestButtonLabel(user)}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : activeTab === 'chats' ? (
            <div className={styles.conversationList}>
              {conversations.length === 0 ? (
                <div className={styles.emptyList}>Нет диалогов</div>
              ) : (
                conversations.map(conversation => {
                  const otherName = getOtherName(conversation.participants);
                  const otherId = getOtherUserId(conversation.participants);
                  return (
                    <div
                      key={conversation.id}
                      className={`${styles.conversationItem} ${activeConversationId === conversation.id ? styles.active : ''}`}
                      onClick={() => void handleSelectConversation(conversation.id)}
                    >
                      <div className={styles.avatarSmall}>{getInitials(otherName)}</div>
                      <div className={styles.convInfo}>
                        <div className={styles.convNameRow}>
                          <OnlineDot online={isUserOnline(otherId)} />
                          <div className={styles.convName}>{otherName}</div>
                          {!conversation.is_writable && <span className={styles.lockBadge}>Только чтение</span>}
                        </div>
                        <div className={styles.convPreview}>
                          {conversation.last_message?.content?.slice(0, 30) || 'Нет сообщений'}
                        </div>
                      </div>
                      <div className={styles.convMeta}>
                        {conversation.last_message && (
                          <span className={styles.convTime}>{formatTime(conversation.last_message.created_at)}</span>
                        )}
                        {conversation.unread_count > 0 && (
                          <span className={styles.unreadBadge}>{conversation.unread_count}</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className={styles.requestsPane}>
              <div className={styles.requestTabs}>
                <button
                  className={`${styles.requestTab} ${requestBox === 'inbox' ? styles.requestTabActive : ''}`}
                  onClick={() => setRequestBox('inbox')}
                >
                  Входящие
                </button>
                <button
                  className={`${styles.requestTab} ${requestBox === 'outbox' ? styles.requestTabActive : ''}`}
                  onClick={() => setRequestBox('outbox')}
                >
                  Исходящие
                </button>
              </div>
              <div className={styles.requestsList}>
                {requests.length === 0 ? (
                  <div className={styles.emptyList}>Запросов пока нет</div>
                ) : (
                  requests.map(request => {
                    const counterpartName = requestBox === 'inbox'
                      ? (request.requester_name || 'Без имени')
                      : (request.target_name || 'Без имени');
                    const counterpartId = requestBox === 'inbox' ? request.requester_id : request.target_user_id;
                    const isPendingInbox = requestBox === 'inbox' && request.status === 'pending';

                    return (
                      <div key={request.id} className={styles.requestCard}>
                        <div className={styles.requestCardTop}>
                          <div className={styles.avatarSmall}>{getInitials(counterpartName)}</div>
                          <div className={styles.requestCardInfo}>
                            <div className={styles.requestCardName}>
                              <OnlineDot online={isUserOnline(counterpartId)} /> {counterpartName}
                            </div>
                            <div className={styles.requestCardMeta}>{formatTime(request.created_at)}</div>
                          </div>
                          <span className={`${styles.requestStatus} ${styles[`status${request.status}`]}`}>
                            {request.status === 'pending' ? 'В ожидании' : request.status === 'approved' ? 'Одобрен' : 'Отклонён'}
                          </span>
                        </div>
                        <div className={styles.requestCardBody}>
                          {request.message?.trim() || 'Без комментария'}
                        </div>
                        {isPendingInbox && (
                          <div className={styles.requestActions}>
                            <button
                              className={styles.requestApproveBtn}
                              disabled={requestActionId === request.id}
                              onClick={() => void handleRequestAction(request, 'approve')}
                            >
                              Одобрить
                            </button>
                            <button
                              className={styles.requestRejectBtn}
                              disabled={requestActionId === request.id}
                              onClick={() => void handleRequestAction(request, 'reject')}
                            >
                              Отклонить
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <div className={`${styles.chatPane} ${activeTab !== 'chats' || !mobileShowChat ? styles.hidden : ''}`}>
          {activeTab !== 'chats' ? (
            <div className={styles.chatPlaceholder}>Запросы обрабатываются в левом столбце</div>
          ) : !activeConversationId ? (
            <div className={styles.chatPlaceholder}>
              <button className={styles.iconBtn} onClick={closeChat} style={{ position: 'absolute', top: 12, right: 12 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              Выберите диалог
            </div>
          ) : (
            <>
              <div className={styles.chatPaneHeader}>
                <button className={`${styles.iconBtn} ${styles.backBtn}`} onClick={() => setMobileShowChat(false)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                <div className={styles.avatar}>
                  {getInitials(activeConversation ? getOtherName(activeConversation.participants) : '??')}
                </div>
                <div className={styles.headerBlock}>
                  <span className={styles.headerName}>
                    {activeConversation && <OnlineDot online={isUserOnline(getOtherUserId(activeConversation.participants))} />}
                    {' '}{activeConversation ? getOtherName(activeConversation.participants) : ''}
                  </span>
                  {!activeConversation?.is_writable && activeConversation?.write_lock_reason && (
                    <span className={styles.headerLock}>{activeConversation.write_lock_reason}</span>
                  )}
                </div>
                <button className={styles.iconBtn} onClick={closeChat} style={{ marginLeft: 'auto' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className={styles.messagesContainer}>
                {loading ? (
                  <div className={styles.chatPlaceholder}>Загрузка...</div>
                ) : messages.length === 0 ? (
                  <div className={styles.chatPlaceholder}>Начните диалог</div>
                ) : (
                  messages.map((message, index) => {
                    const isMine = message.sender_id === profile?.id;
                    const messageDate = new Date(message.created_at).toDateString();
                    const previousDate = index > 0 ? new Date(messages[index - 1].created_at).toDateString() : null;
                    const showDate = index === 0 || messageDate !== previousDate;

                    return (
                      <React.Fragment key={message.id}>
                        {showDate && (
                          <div className={styles.dateSeparator}>
                            <span className={styles.dateLabel}>{formatDateLabel(message.created_at)}</span>
                          </div>
                        )}
                        <div className={`${styles.message} ${isMine ? styles.mine : styles.theirs}`}>
                          <div className={styles.messageBubble}>
                            <div className={styles.messageText}>{message.content}</div>
                            <span className={styles.messageTime}>
                              {new Date(message.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                              {isMine && (
                                <CheckIcon double={message.is_read} className={`${styles.readCheck} ${message.is_read ? styles.readCheckRead : ''}`} />
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

              {!activeConversation?.is_writable && activeConversation?.write_lock_reason && (
                <div className={styles.readOnlyNotice}>
                  {activeConversation.write_lock_reason}
                </div>
              )}

              <div className={styles.inputArea}>
                <textarea
                  className={styles.messageInput}
                  placeholder={activeConversation?.is_writable ? 'Сообщение...' : 'Отправка недоступна'}
                  value={inputValue}
                  onChange={event => setInputValue(event.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={!activeConversation?.is_writable}
                />
                <button
                  className={styles.sendBtn}
                  onClick={() => void handleSend()}
                  disabled={!inputValue.trim() || !activeConversation?.is_writable}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
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
