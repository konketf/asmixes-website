import { HttpError, verifyAdmin, requireSameOrigin } from './auth.mjs';
import { validId, metadata, readJSON, readLimited, inspectFile, AUDIO_LIMIT, ARTWORK_LIMIT, PROJECT_LIMIT } from './validation.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (status, message) => { throw new HttpError(status, message); };
const statement = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const changes = result => result.meta?.changes || 0;
const active = 'deleted_at IS NULL';

async function findProject(env, id) {
  const project = await statement(env, `SELECT * FROM projects WHERE id = ? AND ${active}`, id).first();
  if (!project) fail(404, 'Project not found.');
  return project;
}
function expose(row, admin = false) {
  const value = {
    id: row.id, title: row.title, artist: row.artist, description: row.description, credit: row.credit,
    audioUrl: row.audio_id ? `/media/${row.audio_id}` : null,
    artworkUrl: row.artwork_id ? `/media/${row.artwork_id}` : null,
  };
  if (admin) Object.assign(value, { published: Boolean(row.published), revision: row.revision, position: row.position });
  return value;
}
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";
function protect(response, corsOrigin) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', csp);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Strict-Transport-Security', 'max-age=31536000');
  // Recheck publication on every request, including range requests. No CDN cache.
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'Origin');
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD');
    headers.set('Access-Control-Allow-Headers', 'Range');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  }
  return new Response(response.body, { status: response.status, headers });
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) fail(416, 'Invalid byte range.');
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) fail(416, 'Invalid byte range.'); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) fail(416, 'Invalid byte range.');
  return { offset: start, length: end - start + 1 };
}

async function media(request, env, id, admin) {
  if (!validId(id)) fail(404, 'Media not found.');
  const asset = await statement(env, `SELECT a.* FROM assets a JOIN projects p ON p.id = a.project_id
    WHERE a.id = ? AND a.state = 'ready' AND p.deleted_at IS NULL
    AND (p.audio_id = a.id OR p.artwork_id = a.id) ${admin ? '' : 'AND p.published = 1'}`, id).first();
  if (!asset) fail(404, 'Media not found.');
  const head = await env.MEDIA.head(asset.object_key);
  if (!head) fail(404, 'Media not found.');
  let range;
  try { range = parseRange(request.headers.get('Range'), head.size); }
  catch (error) { if (error.status === 416) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } }); throw error; }
  const headers = new Headers({ 'Content-Type': asset.content_type, 'Accept-Ranges': 'bytes', 'Content-Length': String(range?.length ?? head.size), 'Content-Disposition': 'inline' });
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const object = await env.MEDIA.get(asset.object_key, range ? { range } : undefined);
  if (!object) fail(404, 'Media not found.');
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function readUsage(env) {
  return await statement(env, 'SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM assets').first();
}
function quota(env) {
  const value = Number(env.STORAGE_QUOTA_BYTES || 1073741824);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1073741824) fail(503, 'Storage quota is not configured.');
  return value;
}
async function createProject(request, env) {
  const data = metadata(await readJSON(request));
  if (data.published) fail(400, 'Upload audio and artwork before publishing.');
  const id = crypto.randomUUID();
  const result = await statement(env, `INSERT INTO projects (id,title,artist,description,credit,position,created_at)
    SELECT ?,?,?,?,?, COALESCE((SELECT MAX(position) + 1 FROM projects WHERE ${active}),0),?
    WHERE (SELECT COUNT(*) FROM projects WHERE ${active}) < ?`, id, data.title, data.artist, data.description, data.credit, Date.now(), PROJECT_LIMIT).run();
  if (!changes(result)) fail(409, 'Portfolio is limited to 100 projects.');
  return json(expose(await findProject(env, id), true), 201);
}

async function editProject(request, env, id) {
  const data = metadata(await readJSON(request));
  if (!data.revision) fail(400, 'Project revision is required.');
  const current = await findProject(env, id);
  if (data.published) {
    if (!current.audio_id || !current.artwork_id) fail(400, 'Upload both audio and artwork before publishing.');
    const count = await statement(env, "SELECT COUNT(*) AS count FROM assets WHERE id IN (?,?) AND state = 'ready'", current.audio_id, current.artwork_id).first();
    if (count.count !== 2) fail(409, 'The uploads are not ready.');
  }
  const result = await statement(env, `UPDATE projects SET title=?,artist=?,description=?,credit=?,published=?,revision=revision+1 WHERE id=? AND revision=? AND ${active}`, data.title, data.artist, data.description, data.credit, Number(data.published), id, data.revision).run();
  if (!changes(result)) fail(409, 'This project changed. Refresh before editing again.');
  return json(expose(await findProject(env, id), true));
}

async function collectGarbage(env) {
  // Failed request termination can leave a reservation. Reclaim only after an hour.
  await statement(env, `UPDATE assets SET state='garbage' WHERE state='pending' AND created_at < ?
    AND NOT EXISTS (SELECT 1 FROM projects WHERE deleted_at IS NULL AND (audio_id=assets.id OR artwork_id=assets.id))`, Date.now() - 3600000).run();
  const { results } = await statement(env, `SELECT a.* FROM assets a WHERE a.state='garbage'
    AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.deleted_at IS NULL AND (p.audio_id=a.id OR p.artwork_id=a.id)) LIMIT 50`).all();
  for (const asset of results) {
    // Keys come only from the database, never from a submitted object path.
    await env.MEDIA.delete(asset.object_key);
    await statement(env, "DELETE FROM assets WHERE id=? AND state='garbage'", asset.id).run();
  }
  await statement(env, 'DELETE FROM projects WHERE deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets WHERE project_id=projects.id)').run();
}

async function upload(request, env, id, kind) {
  const revision = Number(request.headers.get('X-Project-Revision'));
  if (!Number.isSafeInteger(revision) || revision < 1) fail(400, 'Project revision is required.');
  const project = await findProject(env, id);
  if (project.revision !== revision) fail(409, 'This project changed. Refresh before uploading again.');
  const bytes = await readLimited(request, kind === 'audio' ? AUDIO_LIMIT : ARTWORK_LIMIT);
  const file = inspectFile(bytes, kind);
  const assetId = crypto.randomUUID();
  const key = `projects/${id}/${assetId}.${file.extension}`;
  const reserved = await statement(env, `INSERT INTO assets (id,project_id,kind,object_key,byte_size,content_type,state,created_at)
    SELECT ?,?,?,?,?,?,'pending',? WHERE COALESCE((SELECT SUM(byte_size) FROM assets),0) + ? <= ?
    AND EXISTS(SELECT 1 FROM projects WHERE id=? AND revision=? AND ${active})`, assetId, id, kind, key, bytes.length, file.type, Date.now(), bytes.length, quota(env), id, revision).run();
  if (!changes(reserved)) fail(409, 'Storage quota reached or project changed. Refresh and try again.');
  const column = kind === 'audio' ? 'audio_id' : 'artwork_id';
  let linked = false;
  try {
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: file.type } });
    const results = await env.DB.batch([
      statement(env, `UPDATE projects SET ${column}=?,revision=revision+1 WHERE id=? AND revision=? AND ${active}`, assetId, id, revision),
      statement(env, `UPDATE assets SET state='ready' WHERE id=? AND EXISTS (SELECT 1 FROM projects WHERE id=? AND ${column}=? AND ${active})`, assetId, id, assetId),
      statement(env, `UPDATE assets SET state='garbage' WHERE project_id=? AND kind=? AND state='ready' AND NOT EXISTS (SELECT 1 FROM projects WHERE ${active} AND (audio_id=assets.id OR artwork_id=assets.id))`, id, kind),
    ]);
    linked = changes(results[0]) === 1;
    if (!linked) fail(409, 'This project changed. Refresh before uploading again.');
    return json(expose(await findProject(env, id), true));
  } finally {
    if (!linked) {
      // An uncertain DB commit must not cause deletion of a successfully linked file.
      await statement(env, `UPDATE assets SET state='garbage' WHERE id=? AND NOT EXISTS (SELECT 1 FROM projects WHERE ${active} AND (audio_id=assets.id OR artwork_id=assets.id))`, assetId).run();
    }
  }
}

async function removeProject(request, env, id) {
  const data = await readJSON(request);
  if (!data || Object.keys(data).some(key => key !== 'revision') || !Number.isSafeInteger(data.revision)) fail(400, 'Project revision is required.');
  await findProject(env, id);
  const results = await env.DB.batch([
    statement(env, `UPDATE projects SET published=0,deleted_at=?,revision=revision+1 WHERE id=? AND revision=? AND ${active}`, Date.now(), id, data.revision),
    statement(env, "UPDATE assets SET state='garbage' WHERE project_id=? AND state='ready' AND EXISTS (SELECT 1 FROM projects WHERE id=? AND deleted_at IS NOT NULL)", id, id),
  ]);
  if (!changes(results[0])) fail(409, 'This project changed. Refresh before deleting.');
  return json({ deleted: true });
}

async function reorder(request, env) {
  const data = await readJSON(request);
  if (!data || Object.keys(data).some(key => key !== 'ids') || !Array.isArray(data.ids) || data.ids.length > PROJECT_LIMIT || data.ids.some(id => !validId(id)) || new Set(data.ids).size !== data.ids.length) fail(400, 'Invalid project order.');
  const { results } = await statement(env, `SELECT id FROM projects WHERE ${active}`).all();
  if (results.length !== data.ids.length || results.some(row => !data.ids.includes(row.id))) fail(409, 'The project list changed. Refresh before reordering.');
  if (data.ids.length) {
    // One statement is atomic and avoids the Free-plan 50-query per request limit.
    const ids = JSON.stringify(data.ids);
    await statement(env, `UPDATE projects SET position=(SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value=projects.id)
      WHERE ${active} AND id IN (SELECT value FROM json_each(?))`, ids, ids).run();
  }
  return json({ reordered: true });
}

export function createWorker(authenticate = verifyAdmin) {
  return {
    async fetch(request, env, ctx = { waitUntil() {} }) {
      let corsOrigin;
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'https:') fail(400, 'HTTPS is required.');
        if (!['admin', 'public'].includes(env.APP_MODE)) fail(503, 'Application is not configured.');
        if (env.APP_MODE === 'public') {
          const origin = request.headers.get('Origin');
          if (!/^https:\/\//.test(env.PUBLIC_ORIGIN || '') || new URL(env.PUBLIC_ORIGIN).origin !== env.PUBLIC_ORIGIN) fail(503, 'Public origin is not configured.');
          if (origin && origin !== env.PUBLIC_ORIGIN) fail(403, 'Origin is not allowed.');
          corsOrigin = origin || undefined;
          if (request.method === 'OPTIONS') {
            const headers = request.headers.get('Access-Control-Request-Headers') || '';
            if (!['GET', 'HEAD'].includes(request.headers.get('Access-Control-Request-Method')) || (headers && headers.toLowerCase() !== 'range')) fail(403, 'Request is not allowed.');
            return protect(new Response(null, { status: 204 }), corsOrigin);
          }
          if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Read-only endpoint.');
          let response;
          if (url.pathname === '/api/projects') {
            const { results } = await statement(env, `SELECT * FROM projects WHERE published=1 AND ${active} ORDER BY position,created_at,id LIMIT 100`).all();
            response = json({ projects: results.map(row => expose(row)) });
          } else {
            const match = /^\/media\/([^/]+)$/.exec(url.pathname);
            if (!match) fail(404, 'Not found.');
            response = await media(request, env, match[1], false);
          }
          if (request.method === 'HEAD') response = new Response(null, { status: response.status, headers: response.headers });
          return protect(response, corsOrigin);
        }
        // All admin paths, including HTML/CSS/JS/media, are checked at the Worker.
        if (!env.ADMIN_ORIGIN || url.origin !== env.ADMIN_ORIGIN) fail(403, 'Admin hostname is not allowed.');
        if (request.method === 'OPTIONS') fail(403, 'Cross-origin admin access is not allowed.');
        const email = await authenticate(request, env);
        if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request, env);
        let response;
        const projectMatch = /^\/api\/admin\/projects\/([^/]+)(?:\/(audio|artwork))?$/.exec(url.pathname);
        const mediaMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
        if (request.method === 'GET' && url.pathname === '/api/admin/session') response = json({ email });
        else if (request.method === 'GET' && url.pathname === '/api/admin/projects') {
          const { results } = await statement(env, `SELECT * FROM projects WHERE ${active} ORDER BY position,created_at,id`).all();
          response = json({ projects: results.map(row => expose(row, true)), usage: { bytes: (await readUsage(env)).bytes, quota: quota(env) } });
        } else if (request.method === 'POST' && url.pathname === '/api/admin/projects') response = await createProject(request, env);
        else if (request.method === 'POST' && url.pathname === '/api/admin/reorder') response = await reorder(request, env);
        else if (projectMatch && validId(projectMatch[1])) {
          if (request.method === 'PUT' && projectMatch[2]) response = await upload(request, env, projectMatch[1], projectMatch[2]);
          else if (request.method === 'PATCH' && !projectMatch[2]) response = await editProject(request, env, projectMatch[1]);
          else if (request.method === 'DELETE' && !projectMatch[2]) response = await removeProject(request, env, projectMatch[1]);
          else fail(405, 'Method not allowed.');
        } else if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) response = await media(request, env, mediaMatch[1], true);
        else if (['GET', 'HEAD'].includes(request.method)) {
          const files = new Map([['/', '/admin/index.html'], ['/admin', '/admin/index.html'], ['/admin/', '/admin/index.html'], ['/admin/index.html', '/admin/index.html'], ['/admin/admin.css', '/admin/admin.css'], ['/admin/admin.js', '/admin/admin.js'], ['/assets/site.css', '/assets/site.css']]);
          const path = files.get(url.pathname);
          if (!path || !env.ASSETS) fail(404, 'Not found.');
          const assetUrl = new URL(request.url); assetUrl.pathname = path;
          response = await env.ASSETS.fetch(new Request(assetUrl, request));
        } else fail(404, 'Not found.');
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) ctx.waitUntil(collectGarbage(env).catch(() => console.error('Portfolio cleanup needs retry.')));
        return protect(response);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error('Portfolio request failed.');
        return protect(json({ error: status === 500 ? 'The request could not be completed. Try again.' : error.message }, status), corsOrigin);
      }
    },
    async scheduled(controller, env, ctx) {
      if (env.APP_MODE === 'admin') ctx.waitUntil(collectGarbage(env));
    },
  };
}
export default createWorker();
