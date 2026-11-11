// Applies the saved theme before first paint (avoids a flash). Kept as a
// separate file so the Content-Security-Policy can forbid inline scripts.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('dhai.settings.v1') || '{}');
    var t = s.theme || 'system';
    if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    if (s.fontSize) document.documentElement.dataset.fontSize = s.fontSize;
    if (s.sidebarCollapsed) document.documentElement.classList.add('sidebar-collapsed');
  } catch (e) {}
})();
  
