(async () => {
  const config = window.AS_MIXES_PORTFOLIO;
  if (!config?.apiOrigin) return; // Preserve the current static portfolio until configured.
  const section = document.querySelector('#work');
  const grid = section.querySelector('.work-grid');
  const note = section.querySelector('.demo-note');
  try {
    const base = new URL(config.apiOrigin);
    if (base.protocol !== 'https:' || base.origin !== config.apiOrigin) throw new Error('Invalid API origin.');
    const response = await fetch(new URL('/api/projects', base), { credentials: 'omit', cache: 'no-store' });
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
      const cover = document.createElement('div'); cover.className = 'cover portfolio-cover';
      const img = document.createElement('img'); img.src = mediaUrl(project.artworkUrl); img.alt = 'Cover artwork for ' + project.title; img.loading = 'lazy'; cover.append(img);
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
    note.textContent = cards.length ? '' : 'No audio previews are published yet.';
    note.hidden = cards.length > 0;
  } catch {
    // Retain the clearly labelled static examples if the API is unavailable.
    note.hidden = false;
    note.textContent = 'Audio previews are temporarily unavailable. The projects below are layout examples.';
  }
})();
