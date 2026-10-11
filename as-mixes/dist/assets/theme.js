/* Deliberately parser-blocking, before styles: apply the saved theme before paint.
   This file is loaded only by the public website, never the admin pages. */
(() => {
  'use strict';
  const key = 'asmixes-theme';
  const system = matchMedia('(prefers-color-scheme: light)');
  const valid = value => ['system', 'light', 'dark'].includes(value);
  let preference = 'system', theme;
  try { const saved = localStorage.getItem(key); if (valid(saved)) preference = saved; } catch { /* Private mode/storage restrictions: use System. */ }

  function apply() {
    const next = preference === 'system' ? (system.matches ? 'light' : 'dark') : preference;
    const changed = theme !== next;
    theme = next;
    document.documentElement.dataset.theme = theme;
    const color = theme === 'light' ? '#f5f2eb' : '#171817';
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
      meta.content = color;
      meta.removeAttribute('media');
    });
    document.querySelectorAll('#theme-switch input[name="theme"]').forEach(input => {
      input.checked = input.value === preference;
    });
    if (changed) document.dispatchEvent(new CustomEvent('asmixes:themechange', { detail: { theme } }));
  }

  window.AS_MIXES_THEME = Object.freeze({
    get theme() { return theme; },
    get preference() { return preference; },
    setPreference(value) {
      if (!valid(value)) return;
      preference = value;
      try { localStorage.setItem(key, value); } catch { /* The in-memory choice still works. */ }
      apply();
    },
  });
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue) ? event.newValue : 'system';
      apply();
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.querySelector('#theme-switch');
    if (!control) return;
    control.disabled = false;
    apply();
    control.addEventListener('change', event => {
      if (event.target.name === 'theme' && event.target.checked) window.AS_MIXES_THEME.setPreference(event.target.value);
    });
  });
  apply();
})();
