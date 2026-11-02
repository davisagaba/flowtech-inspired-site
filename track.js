// Lightweight pageview beacon — fires once per page load, fire-and-forget.
(function () {
  try {
    var payload = JSON.stringify({ path: location.pathname + location.search, referrer: document.referrer });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
    }
  } catch (e) { /* tracking must never break the page */ }
})();
