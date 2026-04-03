self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();

  const options = {
    body: data.body,
    icon: '/fot-favicon-32.svg',
    badge: '/fot-favicon-32.svg',
    tag: `chat-${data.conversationId}`,
    renotify: true,
    data: { conversationId: data.conversationId },
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Если окно уже открыто — фокусируем его
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      // Иначе открываем новое
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
