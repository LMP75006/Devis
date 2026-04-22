// Vasco Service Worker — mise à jour automatique
// Incrémenter APP_VERSION à chaque déploiement
const APP_VERSION = '1.0.0';
const CACHE = `vasco-${APP_VERSION}`;
const FILES = ['./la-maison-propre-devis.html'];

// Installation — mise en cache de la nouvelle version
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(FILES))
      .then(() => self.skipWaiting()) // Prend le contrôle immédiatement
  );
});

// Activation — supprime les anciens caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // Prend le contrôle de tous les onglets
      .then(() => {
        // Notifier tous les clients qu'une mise à jour a été appliquée
        self.clients.matchAll().then(clients => {
          clients.forEach(client => client.postMessage({ type: 'UPDATE_APPLIED', version: APP_VERSION }));
        });
      })
  );
});

// Fetch — réseau d'abord, cache en fallback
self.addEventListener('fetch', e => {
  // Ne gérer que les requêtes GET de même origine
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Mettre en cache la nouvelle version
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Hors ligne → servir depuis le cache
        return caches.match(e.request)
          .then(r => r || caches.match('./la-maison-propre-devis.html'));
      })
  );
});

// Message depuis l'app pour forcer la mise à jour
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
