(() => {
  const form = document.querySelector('#contact-form');
  const status = document.querySelector('#form-status');
  const button = form.querySelector('button[type="submit"]');
  const config = window.AS_MIXES_PORTFOLIO || {};
  let widget, token = '', sending = false;
  button.disabled = true;
  const message = text => { status.textContent = text; };
  const ready = () => { button.disabled = sending || !token; };
  const reset = () => {
    token = '';
    if (widget !== undefined && window.turnstile) window.turnstile.reset(widget);
    ready();
  };
  let endpoint;
  try {
    const origin = new URL(config.apiOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== config.apiOrigin || !/^[A-Za-z0-9_-]{10,100}$/.test(config.turnstileSiteKey || '')) throw new Error();
    endpoint = new URL('/api/contact', origin).href;
  } catch {
    message('The contact form is not available yet. Please email contact@asmixes.com directly.');
    form.addEventListener('submit', event => event.preventDefault());
    return;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !form.reportValidity()) return;
    if (!token) { message('Please complete the verification before sending.'); return; }
    const data = new FormData(form);
    const payload = { name: data.get('name'), email: data.get('email'), service: data.get('service'),
      trackCount: data.get('trackCount') ? Number(data.get('trackCount')) : null, message: data.get('message'), token };
    sending = true; ready(); message('Sending your message…');
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok || result.accepted !== true) {
        message(typeof result.error === 'string' ? result.error : 'Your message could not be sent. Please try again or email contact@asmixes.com.');
        return;
      }
      message("Thanks — your message has been accepted. I'll get back to you by email.");
      form.reset();
    } catch {
      message('We could not confirm whether your message was sent. Your text is still here. Please try again or email contact@asmixes.com.');
    } finally { sending = false; reset(); }
  });

  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.addEventListener('load', () => {
    try {
      widget = window.turnstile.render('#contact-verification', {
        sitekey: config.turnstileSiteKey, action: 'contact', theme: 'dark', size: 'flexible',
        callback: value => { token = value; ready(); },
        'expired-callback': () => { token = ''; ready(); },
        'error-callback': () => { token = ''; ready(); message('Verification is unavailable. Please retry or email contact@asmixes.com.'); },
      });
    } catch { message('Verification is unavailable. Please reload or email contact@asmixes.com.'); }
  });
  script.addEventListener('error', () => message('Verification could not load. Please reload or email contact@asmixes.com.'));
  document.head.append(script);
})();
