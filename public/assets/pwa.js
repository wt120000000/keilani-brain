// PWA tiny helper — keeps SW out of your way during dev
(() => {
  const log = (...a) => console.log("[PWA]", ...a);
  const u = new URL(location.href);
  const noSW = u.searchParams.get("no-sw") === "1";
  if (noSW) { log("Service worker disabled via ?no-sw=1"); return; }
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then(r => log("SW registered", r.scope))
      .catch(err => log("SW register failed", err));
  });
})();
