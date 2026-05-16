// Активируем новый SW сразу, не дожидаясь закрытия всех вкладок —
// иначе push может прийти раньше, чем SW станет активным, и потеряться.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();

  const options = {
    body: data.body,
    icon: '/fot-favicon-32.svg',
    badge: '/fot-favicon-32.svg',
    tag: data.tag || (data.conversationId ? `chat-${data.conversationId}` : 'fot-notification'),
    renotify: true,
    data: {
      conversationId: data.conversationId,
      path: data.path || '/',
    },
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      const convId = event.notification.data?.conversationId;
      const targetPath = convId
        ? `/?openChat=${convId}`
        : (event.notification.data?.path || '/');
      // Если окно уже открыто — фокусируем и просим открыть переписку без перезагрузки
      for (const client of clientList) {
        if ('focus' in client) {
          if (convId && 'postMessage' in client) {
            client.postMessage({ type: 'OPEN_CHAT', conversationId: convId });
          }
          return client.focus();
        }
      }
      // Иначе открываем новое
      if (clients.openWindow) {
        return clients.openWindow(targetPath);
      }
    })
  );
});
