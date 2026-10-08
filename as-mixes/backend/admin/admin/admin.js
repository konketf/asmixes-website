const form = document.querySelector('#project-form');
const status = document.querySelector('#status');
let projects = [], editing = null, busy = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options, credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-AS-Mixes-Request': '1', ...options.headers },
  });
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('Your session may have expired. Reload this page to sign in again.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed. Please try again.');
  return data;
}
const jsonOptions = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button').forEach(button => { button.disabled = value || button.dataset.unavailable === 'true'; });
  form.querySelectorAll('input,select,textarea').forEach(input => { input.disabled = value; });
}
function clearForm() {
  editing = null; form.reset();
  document.querySelector('#editor-heading').textContent = 'New project';
}
function edit(project) {
  editing = { ...project }; form.reset();
  for (const key of ['title', 'artist', 'description', 'credit']) form.elements[key].value = project[key];
  form.elements.published.checked = project.published;
  document.querySelector('#editor-heading').textContent = 'Edit project';
  form.elements.title.focus();
  status.textContent = 'Editing ' + project.title + '. Existing files are kept unless you choose replacements.';
}
function button(label, action, unavailable = false, extraClass = '') {
  const node = document.createElement('button'); node.type = 'button'; node.className = 'secondary ' + extraClass;
  node.textContent = label; node.dataset.unavailable = String(unavailable); node.disabled = busy || unavailable;
  node.addEventListener('click', action); return node;
}
async function operation(action, success) {
  if (busy) return;
  setBusy(true);
  try { await action(); await load(); status.textContent = success; }
  catch (error) { status.textContent = error.message; }
  finally { setBusy(false); }
}
function render() {
  const list = document.querySelector('#projects'); list.replaceChildren();
  if (!projects.length) { const p = document.createElement('p'); p.className = 'form-note'; p.textContent = 'No projects yet. Add your first preview using the form.'; list.append(p); }
  projects.forEach((project, index) => {
    const card = document.createElement('article'); card.className = 'admin-card';
    if (project.artworkUrl) { const img = document.createElement('img'); img.src = project.artworkUrl; img.alt = ''; img.loading = 'lazy'; card.append(img); }
    const state = document.createElement('span'); state.className = 'admin-state'; state.textContent = project.published ? 'PUBLISHED' : 'DRAFT';
    const title = document.createElement('h3'); title.textContent = project.title;
    const artist = document.createElement('p'); artist.textContent = project.artist + ' · ' + project.credit;
    card.append(state, title, artist);
    if (project.description) { const p = document.createElement('p'); p.textContent = project.description; card.append(p); }
    if (project.audioUrl) { const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = project.audioUrl; audio.setAttribute('aria-label', 'Preview ' + project.title); card.append(audio); }
    const actions = document.createElement('div'); actions.className = 'admin-actions';
    actions.append(button('Edit', () => edit(project)));
    actions.append(button(project.published ? 'Unpublish' : 'Publish', () => operation(async () => {
      await api('/api/admin/projects/' + project.id, jsonOptions('PATCH', { title: project.title, artist: project.artist, description: project.description, credit: project.credit, published: !project.published, revision: project.revision }));
      if (editing?.id === project.id) clearForm();
    }, project.published ? 'Project unpublished.' : 'Project published.'), !project.published && (!project.audioUrl || !project.artworkUrl)));
    for (const [label, delta] of [['Move up', -1], ['Move down', 1]]) actions.append(button(label, () => operation(async () => {
      const ids = projects.map(p => p.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      await api('/api/admin/reorder', jsonOptions('POST', { ids }));
    }, 'Project order saved.'), index + delta < 0 || index + delta >= projects.length));
    actions.append(button('Delete', () => {
      if (!confirm('Delete “' + project.title + '” and its audio and artwork? This cannot be undone.')) return;
      operation(async () => {
        await api('/api/admin/projects/' + project.id, jsonOptions('DELETE', { revision: project.revision }));
        if (editing?.id === project.id) clearForm();
      }, 'Project removed. File cleanup will retry automatically if needed.');
    }, false, 'admin-delete'));
    card.append(actions); list.append(card);
  });
}
async function load() {
  const data = await api('/api/admin/projects'); projects = data.projects; render();
  document.querySelector('#usage').textContent = (data.usage.bytes / 1048576).toFixed(1) + ' MiB used / ' + (data.usage.quota / 1048576).toFixed(0) + ' MiB limit (includes pending cleanup).';
}
document.querySelector('#new-project').addEventListener('click', () => { clearForm(); status.textContent = 'Ready for a new project.'; });
form.addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  const audio = form.elements.audio.files[0], artwork = form.elements.artwork.files[0];
  if (audio && audio.size > 30 * 1048576) { status.textContent = 'Audio must be at most 30 MiB.'; return; }
  if (artwork && artwork.size > 5 * 1048576) { status.textContent = 'Artwork must be at most 5 MiB.'; return; }
  const data = { title: form.elements.title.value, artist: form.elements.artist.value, description: form.elements.description.value, credit: form.elements.credit.value, published: form.elements.published.checked };
  operation(async () => {
    let project;
    if (editing) {
      project = await api('/api/admin/projects/' + editing.id, jsonOptions('PATCH', { ...data, published: audio || artwork ? false : data.published, revision: editing.revision }));
    } else project = await api('/api/admin/projects', jsonOptions('POST', { ...data, published: false }));
    editing = { ...project };
    for (const [kind, file] of [['audio', audio], ['artwork', artwork]]) {
      if (!file) continue;
      status.textContent = 'Uploading ' + kind + '…';
      project = await api('/api/admin/projects/' + project.id + '/' + kind, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Project-Revision': String(project.revision) }, body: file });
      editing = { ...project };
    }
    await api('/api/admin/projects/' + project.id, jsonOptions('PATCH', { ...data, revision: project.revision }));
    clearForm();
  }, data.published ? 'Project saved and published. Refresh your public website to see it.' : 'Draft saved. It is only visible here.');
});
async function start() {
  try {
    const session = await api('/api/admin/session'); document.querySelector('#identity').textContent = session.email;
    await load(); document.querySelector('#dashboard').hidden = false; status.textContent = 'Ready.';
  } catch (error) { status.textContent = error.message; }
}
start();
