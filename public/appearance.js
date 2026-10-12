const THEME_STORAGE = 'tft.atelier.theme.v1';
const validTheme = value => ['light', 'dark'].includes(value);

export function initAppearance() {
  const preference = window.matchMedia('(prefers-color-scheme: dark)');
  const controls = [...document.querySelectorAll('[data-theme-choice]')];
  let saved;
  try { saved = localStorage.getItem(THEME_STORAGE); } catch {}
  let manual = validTheme(saved);
  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f4eb' : '#101715');
    controls.forEach(control => control.setAttribute('aria-pressed', String(control.dataset.themeChoice === theme)));
  }
  controls.forEach(control => control.addEventListener('click', () => {
    manual = true;
    apply(control.dataset.themeChoice);
    try { localStorage.setItem(THEME_STORAGE, control.dataset.themeChoice); } catch {}
  }));
  preference.addEventListener('change', event => { if (!manual) apply(event.matches ? 'dark' : 'light'); });
  window.addEventListener('storage', event => {
    if (event.key !== THEME_STORAGE && event.key !== null) return;
    manual = validTheme(event.newValue);
    apply(manual ? event.newValue : preference.matches ? 'dark' : 'light');
  });
  document.addEventListener('click', event => {
    const details=document.querySelector('.version-details[open]');
    if(details && !details.contains(event.target))details.removeAttribute('open');
  });
  document.addEventListener('keydown', event => {
    if(event.key==='Escape')document.querySelector('.version-details[open]')?.removeAttribute('open');
  });
  apply(validTheme(document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : preference.matches ? 'dark' : 'light');
}

const patch = value => typeof value === 'string' && /^\d+\.\d+[a-z]?$/i.test(value.trim()) ? value.trim() : null;
export function versionContext({catalog = {}, health = {}, library = {}} = {}) {
  const context = catalog.context || {};
  const appVersion = typeof health?.version === 'string' && /^\d+\.\d+\.\d+$/.test(health.version) ? health.version : '4.0.0';
  const season = context.set ?? context.setNumber ?? context.setName ?? context.set_name ?? null;
  const rulePatch = library?.status === 'ready' ? patch(library.rulesSource?.sourcePatch) : null;
  return {
    appVersion, season, rulePatch,
    gamePatch: patch(context.gamePatch ?? context.game_patch),
    statPatch: patch(context.statPatch ?? context.stat_patch ?? context.source_patch),
    assetVersion: patch(context.assetVersion ?? context.asset_version)
  };
}
