const adminOrigin = window.AS_MIXES_PORTFOLIO?.adminOrigin;
if (adminOrigin) {
  try {
    const url = new URL(adminOrigin);
    if (url.protocol !== 'https:' || url.origin !== adminOrigin) throw new Error('Invalid admin URL.');
    const link = document.querySelector('#admin-link');
    link.href = new URL('/admin/', url).href; link.className = 'button'; link.removeAttribute('hidden');
    document.querySelector('#admin-status').textContent = 'Use the link below to sign in. Only the configured owner can manage projects.';
  } catch { document.querySelector('#admin-status').textContent = 'The dashboard URL needs to be configured.'; }
}
