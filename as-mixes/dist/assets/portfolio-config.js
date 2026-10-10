// Public URLs only. Never put credentials, Access tokens, or secrets here.
// Deployed HTTPS Worker origins; portfolio media stays on the public Worker.
window.AS_MIXES_PORTFOLIO = Object.freeze({
  apiOrigin: 'https://as-mixes-portfolio.aleksandr-sinitson.workers.dev',
  adminOrigin: 'https://as-mixes-admin.aleksandr-sinitson.workers.dev',
  // Public site key only. Set after creating the Turnstile widget; never put its secret here.
  turnstileSiteKey: '0x4AAAAAAFTIxAyb1vI8nf5M',
});
