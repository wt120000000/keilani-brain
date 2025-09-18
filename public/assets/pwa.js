// BUILD TAG: PWA.JS 2025-09-18T08:55-0700
(function () {
  const log = (...a) => console.log('[PWA]', ...a);

  // Gate SW by query ?no-sw=1 to make debugging easy
  const params = new URLSearchParams(location.search);
  if (params.has('no-sw') && params.get('no-sw') !== '0') {
    log('Service worker disabled via ?no-sw=1');
    // proactively unregister any existing SW and clear caches
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
    }
    if ('caches' in window) {
      caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
    }
    return;
  }

  // If you don't want SW at all while debugging, just return here.
  // return;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Only try to register if sw.js exists; swallow failures
      navigator.serviceWorker.register('/sw.js')
        .then(reg => log('registered', reg.scope))
        .catch(err => console.warn('[PWA] register failed', err));
    });
  }
})();
