(() => {
  const section = document.querySelector('#work');
  const grid = section.querySelector('.work-grid');
  const status = section.querySelector('#portfolio-status');
  const retry = section.querySelector('#portfolio-retry');
  let loading = false;

  function artwork(url, title) {
    const cover = document.createElement('div'); cover.className = 'cover portfolio-cover';
    const img = document.createElement('img');
    img.alt = 'Cover artwork for ' + title; img.loading = 'lazy'; img.decoding = 'async';
    const fallback = document.createElement('div'); fallback.className = 'artwork-status'; fallback.hidden = true;
    const message = document.createElement('p'); message.textContent = 'Artwork could not be loaded.';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button';
    button.textContent = 'Retry artwork'; button.setAttribute('aria-label', 'Retry artwork for ' + title);
    fallback.append(message, button); cover.append(img, fallback);
    let automaticRetryUsed = false, timer;
    function retryImage() {
      if (!cover.isConnected || button.disabled) return;
      // Disabling the focused button can send keyboard focus back to the page.
      if (document.activeElement === button) {
        cover.setAttribute('tabindex', '-1'); cover.focus();
      }
      button.disabled = true;
      // A failed lazy image must be eligible to load again, even behind the fallback.
      img.hidden = false; img.loading = 'eager'; img.src = url;
    }
    img.addEventListener('error', () => {
      if (!cover.isConnected) return;
      img.hidden = true; fallback.hidden = false; button.disabled = false;
      if (!automaticRetryUsed) {
        automaticRetryUsed = true; button.disabled = true;
        // Image errors expose no HTTP status. Retry just once, without cache-busting
        // or metadata reloads; persistent failures require an explicit user retry.
        timer = setTimeout(() => { button.disabled = false; retryImage(); }, 1500);
      }
    });
    img.addEventListener('load', () => {
      clearTimeout(timer); img.hidden = false;
      fallback.hidden = true;
    });
    button.addEventListener('click', retryImage);
    // Attach handlers and lazy/decoding hints before starting the request.
    img.src = url;
    return cover;
  }

  async function load() {
    if (loading) return;
    loading = true;
    retry.disabled = true;
    grid.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading audio previews...';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const config = window.AS_MIXES_PORTFOLIO;
      if (!config?.apiOrigin) throw new Error('Missing API origin.');
      const base = new URL(config.apiOrigin);
      if (base.protocol !== 'https:' || base.origin !== config.apiOrigin) throw new Error('Invalid API origin.');
      const response = await fetch(new URL('/api/projects', base), { credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Portfolio unavailable.');
      const data = await response.json();
      if (!Array.isArray(data.projects) || data.projects.length > 100) throw new Error('Invalid portfolio.');
      const mediaUrl = value => {
        if (typeof value !== 'string' || !/^\/media\/[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid media URL.');
        return new URL(value, base).href;
      };
      const cards = data.projects.map(project => {
        if (['title', 'artist', 'credit', 'description'].some(key => typeof project[key] !== 'string')) throw new Error('Invalid project.');
        const card = document.createElement('article');
        const cover = artwork(mediaUrl(project.artworkUrl), project.title);
        const info = document.createElement('div'); info.className = 'work-info';
        const title = document.createElement('h3'); title.textContent = project.title;
        const credit = document.createElement('span'); credit.textContent = project.credit; info.append(title, credit);
        const artist = document.createElement('p'); artist.className = 'portfolio-artist'; artist.textContent = project.artist;
        card.append(cover, info, artist);
        if (project.description) { const description = document.createElement('p'); description.className = 'portfolio-description'; description.textContent = project.description; card.append(description); }
        const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = mediaUrl(project.audioUrl); audio.setAttribute('aria-label', 'Listen to ' + project.title + ' by ' + project.artist);
        audio.addEventListener('play', () => { grid.querySelectorAll('audio').forEach(player => { if (player !== audio) player.pause(); }); });
        card.append(audio); return card;
      });
      grid.replaceChildren(...cards);
      status.textContent = cards.length
        ? 'Published audio previews loaded.'
        : 'No audio previews are published yet. Please check back soon.';
      // Keep keyboard focus in the portfolio when its retry control disappears.
      if (document.activeElement === retry) status.focus();
      retry.hidden = true;
    } catch {
      grid.replaceChildren();
      status.textContent = 'Audio previews could not be loaded. Please try again.';
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      grid.setAttribute('aria-busy', 'false');
      retry.disabled = false;
      loading = false;
    }
  }

  retry.addEventListener('click', load);
  return load();
})();
