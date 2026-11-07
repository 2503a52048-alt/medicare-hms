// Runs in <head> before first paint so the saved light/dark theme is applied without a flash.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('medicare-theme'); } catch (e) { /* storage blocked */ }
  var theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-bs-theme', theme);
})();
