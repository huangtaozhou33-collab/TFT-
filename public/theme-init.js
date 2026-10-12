// Apply the saved palette before CSS paints. No network request is required.
(() => {
  let saved;
  try { saved = localStorage.getItem('tft.atelier.theme.v1'); } catch {}
  const theme = ['light', 'dark'].includes(saved) ? saved : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f4eb' : '#101715');
})();
