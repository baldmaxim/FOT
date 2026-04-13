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
      const targetPath = event.notification.data?.path || '/';
      // Если окно уже открыто — фокусируем его
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) {
            await client.navigate(targetPath);
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
