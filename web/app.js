'use strict';
/* Rutba Media Console — a dependency-free SPA over the /_api/ control plane and the
   media data plane (GET/PUT/DELETE /<path>). Vanilla JS: a tiny hash router, fetch
   for JSON, XHR for upload progress. No framework, no build step. */

const S = {
  token: localStorage.getItem('rm_token') || '',
  user: safeParse(localStorage.getItem('rm_user')),
  roles: safeParse(localStorage.getItem('rm_roles')) || [],
  authMode: 'login',
  files: { q: '', type: '', visibility: '', status: 'active', tag: '', limit: 50, offset: 0, total: 0 },
};
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const isAdmin = () => S.roles.includes('admin');
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};

// ── API ────────────────────────────────────────────────────────────────────
async function api(method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  let b = null;
  if (body != null) { headers['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: b });
  let json = null; try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) { const e = new Error((json && json.message) || res.statusText); e.status = res.status; e.json = json; throw e; }
  return json;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}
function fmtDate(s) { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString(); }
function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function encPath(p) { return '/' + String(p).split('/').map(encodeURIComponent).join('/'); }
function kindOf(f) {
  const m = f.mime || '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  return 'file';
}
const ICON = { image: '🖼️', video: '🎬', audio: '🎵', pdf: '📄', file: '📦' };
function toast(msg, kind = '') {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3200);
}

// ── Auth view ────────────────────────────────────────────────────────────────
function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  setAuthMode('login');
}
function setAuthMode(mode) {
  S.authMode = mode;
  const reg = mode === 'register';
  $('#auth-title').textContent = reg ? 'Create account' : 'Sign in';
  $('#auth-sub').textContent = reg ? 'The first account becomes the administrator.' : 'Access the media console.';
  $('#auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('#f-email-wrap').classList.toggle('hidden', !reg);
  $('#f-email').required = reg;
  $('#switch-text').textContent = reg ? 'Already have an account?' : 'First time here?';
  $('#switch-link').textContent = reg ? 'Sign in' : 'Create the admin account';
  $('#f-login').previousSibling; // no-op
  $('#auth-error').classList.add('hidden');
}
$('#switch-link').addEventListener('click', (e) => { e.preventDefault(); setAuthMode(S.authMode === 'login' ? 'register' : 'login'); });
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const login = $('#f-login').value.trim();
  const password = $('#f-password').value;
  const errBox = $('#auth-error');
  errBox.classList.add('hidden');
  try {
    let r;
    if (S.authMode === 'register') {
      r = await api('POST', '/_api/auth/register', { email: $('#f-email').value.trim(), username: login, password });
    } else {
      r = await api('POST', '/_api/auth/login', { login, password });
    }
    setSession(r.token, r.user, r.roles);
    enterApp();
  } catch (err) {
    errBox.textContent = err.status === 503 ? 'The database layer is not enabled on this server.' : (err.message || 'Failed');
    errBox.classList.remove('hidden');
  }
});
function setSession(token, user, roles) {
  S.token = token; S.user = user; S.roles = roles || [];
  localStorage.setItem('rm_token', token);
  localStorage.setItem('rm_user', JSON.stringify(user));
  localStorage.setItem('rm_roles', JSON.stringify(S.roles));
}
function clearSession() {
  S.token = ''; S.user = null; S.roles = [];
  localStorage.removeItem('rm_token'); localStorage.removeItem('rm_user'); localStorage.removeItem('rm_roles');
}

// ── App shell ────────────────────────────────────────────────────────────────
function enterApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who-name').textContent = S.user ? (S.user.display_name || S.user.username) : '';
  $('#who-role').textContent = S.roles.join(', ');
  $$('.nav-admin').forEach((n) => n.classList.toggle('hidden', !isAdmin()));
  refreshStats();
  if (!location.hash) location.hash = '#/files';
  else route();
}
$('#logout').addEventListener('click', async () => {
  try { await api('POST', '/_api/auth/logout'); } catch { /* ignore */ }
  clearSession(); showAuth();
});
$('#menu-btn').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$$('#nav .nav-item').forEach((a) => a.addEventListener('click', () => $('.sidebar').classList.remove('open')));

// Theme
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); localStorage.setItem('rm_theme', t); }
(function initTheme() { const t = localStorage.getItem('rm_theme'); if (t) document.documentElement.setAttribute('data-theme', t); })();
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

async function refreshStats() {
  if (!isAdmin()) { $('#stat-strip').innerHTML = ''; return; }
  try {
    const s = await api('GET', '/_api/stats');
    $('#stat-strip').innerHTML = '';
    $('#stat-strip').append(
      el('span', {}, el('b', {}, String(s.files)), ' files'),
      el('span', {}, el('b', {}, fmtBytes(s.storageBytes)), ' stored'),
      el('span', {}, el('b', {}, String(s.users)), ' users'),
      el('span', {}, el('b', {}, String(s.trashed)), ' trashed'),
    );
  } catch { /* ignore */ }
}

// ── Router ───────────────────────────────────────────────────────────────────
const VIEWS = { files: filesView, upload: uploadView, shares: sharesView, users: usersView, audit: auditView };
const TITLES = { files: 'Files', upload: 'Upload', shares: 'Share links', users: 'Users', audit: 'Audit log' };
function route() {
  if (!S.token) return showAuth();
  let name = (location.hash.replace(/^#\//, '') || 'files').split('/')[0];
  if (!VIEWS[name]) name = 'files';
  if ((name === 'users' || name === 'audit') && !isAdmin()) name = 'files';
  $$('#nav .nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  $('#view-title').textContent = TITLES[name];
  $('#view').innerHTML = '';
  VIEWS[name]($('#view'));
}
window.addEventListener('hashchange', route);

// ── Files view ───────────────────────────────────────────────────────────────
async function filesView(root) {
  const f = S.files;
  const toolbar = el('div', { class: 'toolbar' },
    el('input', { class: 'search', placeholder: '🔍  Search name or path…', value: f.q,
      onkeydown: (e) => { if (e.key === 'Enter') { f.q = e.target.value; f.offset = 0; loadFiles(); } } }),
    selectFilter('Type', f.type, [['', 'All types'], ['image/', 'Images'], ['video/', 'Video'], ['audio/', 'Audio'], ['application/pdf', 'PDF']], (v) => { f.type = v; f.offset = 0; loadFiles(); }),
    selectFilter('Visibility', f.visibility, [['', 'All'], ['public', 'Public'], ['private', 'Private']], (v) => { f.visibility = v; f.offset = 0; loadFiles(); }),
    selectFilter('Status', f.status, [['active', 'Active'], ['trashed', 'Trashed'], ['all', 'All']], (v) => { f.status = v; f.offset = 0; loadFiles(); }),
    el('input', { style: 'width:130px', placeholder: '# tag', value: f.tag, list: 'tag-list',
      onchange: (e) => { f.tag = e.target.value.trim(); f.offset = 0; loadFiles(); } }),
    tagDatalist(),
    el('button', { class: 'btn', onclick: loadFiles }, '↻ Refresh'),
    el('button', { class: 'btn', onclick: () => showDuplicates(gridWrap) }, '🔎 Duplicates'),
    f.status === 'trashed' && isAdmin()
      ? el('button', { class: 'btn btn-danger', onclick: emptyTrash }, '🗑 Empty trash') : null,
  );
  const gridWrap = el('div', {}, el('div', { class: 'empty' }, 'Loading…'));
  root.append(toolbar, gridWrap);

  async function loadFiles() {
    const qs = new URLSearchParams();
    if (f.q) qs.set('q', f.q);
    if (f.type) qs.set('type', f.type);
    if (f.visibility) qs.set('visibility', f.visibility);
    if (f.tag) qs.set('tag', f.tag);
    qs.set('status', f.status); qs.set('limit', f.limit); qs.set('offset', f.offset);
    gridWrap.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const r = await api('GET', '/_api/files?' + qs.toString());
      f.total = r.total;
      renderGrid(gridWrap, r.files);
      if (r.total > f.limit) gridWrap.append(pager(f, loadFiles));
    } catch (err) {
      gridWrap.innerHTML = '';
      gridWrap.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '⚠️'), err.message || 'Failed to load'));
    }
  }
  async function emptyTrash() {
    if (!confirm('Permanently delete ALL trashed files? This cannot be undone.')) return;
    try { const r = await api('POST', '/_api/trash/empty'); toast(`Purged ${r.purged} file(s)`, 'ok'); refreshStats(); loadFiles(); }
    catch (err) { toast(err.message, 'err'); }
  }
  loadFiles();
}
function selectFilter(label, value, opts, onChange) {
  const sel = el('select', { title: label, onchange: (e) => onChange(e.target.value) },
    ...opts.map(([v, t]) => el('option', { value: v, ...(v === value ? { selected: '' } : {}) }, t)));
  return sel;
}
// A <datalist> of existing tag names, populated async, for the tag filter/inputs.
function tagDatalist() {
  const dl = el('datalist', { id: 'tag-list' });
  api('GET', '/_api/tags').then((r) => { for (const t of r.tags) dl.append(el('option', { value: t.name })); }).catch(() => {});
  return dl;
}
function renderGrid(wrap, files) {
  wrap.innerHTML = '';
  if (!files.length) { wrap.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🗃️'), 'No files match.')); return; }
  const grid = el('div', { class: 'grid' });
  for (const file of files) grid.append(fileCard(file));
  wrap.append(grid);
}
function fileCard(file) {
  const kind = kindOf(file);
  const thumb = el('div', { class: 'thumb' });
  const iconFallback = () => { thumb.innerHTML = ''; thumb.append(el('div', { class: 'icon' }, ICON[kind])); };
  if (kind === 'image' && file.status !== 'trashed') {
    thumb.append(el('img', { loading: 'lazy', alt: file.name, src: encPath(file.path) + '?w=300&h=300&fit=cover&fm=webp', onerror: iconFallback }));
  } else if (kind === 'video' && file.status !== 'trashed') {
    // Video poster frame (ffmpeg). Falls back to the icon if posters aren't available.
    const img = el('img', { loading: 'lazy', alt: file.name, src: encPath(file.path) + '?poster&w=300&h=300&fm=webp', onerror: iconFallback });
    thumb.append(img, el('div', { class: 'play-badge' }, '▶'));
  } else {
    thumb.append(el('div', { class: 'icon' }, ICON[kind]));
  }
  return el('div', { class: 'card', onclick: () => openPreview(file) },
    thumb,
    el('div', { class: 'card-meta' },
      el('div', { class: 'card-name', title: file.path }, file.name),
      el('div', { class: 'card-sub' },
        el('span', {}, fmtBytes(file.size_bytes)),
        file.visibility === 'private' ? el('span', { class: 'badge private' }, 'private') : null,
        file.status === 'trashed' ? el('span', { class: 'badge trashed' }, 'trashed') : null,
      ),
    ),
  );
}
function pager(f, reload) {
  const from = f.offset + 1, to = Math.min(f.offset + f.limit, f.total);
  return el('div', { class: 'pager' },
    el('button', { class: 'btn btn-sm', ...(f.offset === 0 ? { disabled: '' } : {}), onclick: () => { f.offset = Math.max(0, f.offset - f.limit); reload(); } }, '← Prev'),
    el('span', {}, `${from}–${to} of ${f.total}`),
    el('button', { class: 'btn btn-sm', ...(to >= f.total ? { disabled: '' } : {}), onclick: () => { f.offset += f.limit; reload(); } }, 'Next →'),
  );
}

// ── Preview modal ────────────────────────────────────────────────────────────
function openPreview(file) {
  const kind = kindOf(file);
  const url = encPath(file.path);
  let media;
  if (kind === 'image') media = el('img', { src: url, alt: file.name });
  else if (kind === 'video') media = el('video', { src: url, controls: '' });
  else if (kind === 'audio') media = el('audio', { src: url, controls: '', style: 'width:90%' });
  else if (kind === 'pdf') media = el('iframe', { src: url, style: 'width:100%;height:60vh;border:0' });
  else media = el('div', { class: 'icon' }, ICON[kind]);

  const tagsBox = file.status === 'trashed' ? null : el('div', { class: 'tags-box' }, el('span', { class: 'muted', style: 'font-size:12px' }, 'Loading tags…'));
  const metaBox = file.status === 'trashed' ? null : el('div', {});
  const info = el('div', { class: 'preview-info' },
    el('h3', {}, file.name),
    el('div', { class: 'muted', style: 'font-size:12px' }, file.path),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Type'), el('dd', {}, file.mime || file.ext || '—'),
      el('dt', {}, 'Size'), el('dd', {}, fmtBytes(file.size_bytes)),
      el('dt', {}, 'Dimensions'), el('dd', {}, file.width ? `${file.width} × ${file.height}` : '—'),
      el('dt', {}, 'Visibility'), el('dd', {}, file.visibility),
      el('dt', {}, 'Status'), el('dd', {}, file.status),
      el('dt', {}, 'Updated'), el('dd', {}, fmtDate(file.updated_at)),
    ),
    tagsBox,
    metaBox,
    file.status === 'trashed'
      ? el('div', { class: 'preview-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => restoreFile(file) }, '♻️ Restore'),
          el('button', { class: 'btn btn-danger', onclick: () => purgeFile(file) }, '🗑 Delete forever'),
        )
      : el('div', { class: 'preview-actions' },
          el('a', { class: 'btn', href: url, target: '_blank' }, '↗ Open'),
          el('a', { class: 'btn', href: url, download: file.name }, '⬇ Download'),
          el('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(location.origin + url).then(() => toast('URL copied', 'ok')); } }, '🔗 Copy URL'),
          el('button', { class: 'btn btn-primary', onclick: () => shareDialog(file) }, '🔗 Share link'),
          el('button', { class: 'btn btn-danger', onclick: () => deleteFile(file) }, '🗑 Delete'),
        ),
  );
  showModal(el('div', {}, el('div', { class: 'preview-media' }, media), info));
  if (tagsBox) loadTags(tagsBox, file);
  if (metaBox) loadMeta(metaBox, file);
}

// Render an editable tag chip set into `box` for a file.
async function loadTags(box, file) {
  let tags = [];
  try { tags = (await api('GET', '/_api/files/tags?path=' + encodeURIComponent(file.path))).tags; } catch { /* ignore */ }
  const canEdit = S.roles.includes('editor') || isAdmin();
  function render() {
    box.innerHTML = '';
    const chips = el('div', { class: 'chips' },
      ...tags.map((t) => el('span', { class: 'chip' }, '#' + t,
        canEdit ? el('button', { class: 'chip-x', title: 'Remove', onclick: () => save(tags.filter((x) => x !== t)) }, '×') : null)),
      tags.length ? null : el('span', { class: 'muted', style: 'font-size:12px' }, 'No tags'),
    );
    box.append(el('div', { class: 'section-label' }, '🏷️ Tags'), chips);
    if (canEdit) {
      const input = el('input', { placeholder: 'add tag + Enter', list: 'tag-list', style: 'margin-top:8px',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value.trim().toLowerCase(); if (v && !tags.includes(v)) save([...tags, v]); } } });
      box.append(input);
    }
  }
  async function save(next) {
    try { const r = await api('PUT', '/_api/files/tags', { path: file.path, tags: next }); tags = r.tags; render(); toast('Tags updated', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  }
  render();
}

// Render extracted EXIF/media metadata (if any) into `box`.
async function loadMeta(box, file) {
  let m = null;
  try { m = (await api('GET', '/_api/files/metadata?path=' + encodeURIComponent(file.path))).metadata; } catch { /* ignore */ }
  if (!m) return;
  const rows = [];
  const add = (k, v) => { if (v != null && v !== '') rows.push([k, v]); };
  add('Camera', [m.camera_make, m.camera_model].filter(Boolean).join(' ') || null);
  add('Lens', m.lens);
  add('Taken', m.taken_at ? fmtDate(m.taken_at) : null);
  add('Exposure', m.exposure);
  add('Aperture', m.f_number ? 'ƒ/' + m.f_number : null);
  add('Focal length', m.focal_length ? m.focal_length + ' mm' : null);
  add('ISO', m.iso);
  add('Color', m.color_space);
  // Video/audio specifics live in the raw blob (no dedicated columns).
  const raw = m.raw && typeof m.raw === 'object' ? m.raw : null;
  if (raw) {
    if (raw.durationSec != null) add('Duration', fmtDuration(raw.durationSec));
    add('Video codec', raw.videoCodec);
    add('Audio codec', raw.audioCodec);
    if (raw.fps) add('Frame rate', raw.fps + ' fps');
    if (raw.bitRate) add('Bitrate', Math.round(raw.bitRate / 1000) + ' kbps');
  }
  if (m.gps_lat != null && m.gps_lng != null) rows.push(['GPS', el('a', { href: `https://www.openstreetmap.org/?mlat=${m.gps_lat}&mlon=${m.gps_lng}#map=15/${m.gps_lat}/${m.gps_lng}`, target: '_blank' }, `${m.gps_lat}, ${m.gps_lng}`)]);
  if (!rows.length) return;
  box.append(el('div', { class: 'section-label' }, '📷 Metadata'),
    el('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
}

async function deleteFile(file) {
  if (!confirm(`Move "${file.name}" to trash?`)) return;
  try {
    const res = await fetch(encPath(file.path), { method: 'DELETE', headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok && res.status !== 204) throw new Error('HTTP ' + res.status);
    toast('Moved to trash', 'ok'); closeModal(); refreshStats(); route();
  } catch (err) { toast('Delete failed: ' + err.message, 'err'); }
}
async function restoreFile(file) {
  try { await api('POST', '/_api/files/restore', { path: file.path }); toast('Restored', 'ok'); closeModal(); refreshStats(); route(); }
  catch (err) { toast('Restore failed: ' + err.message, 'err'); }
}
async function purgeFile(file) {
  if (!confirm(`Permanently delete "${file.name}"? This cannot be undone.`)) return;
  try { await api('POST', '/_api/files/purge', { path: file.path }); toast('Permanently deleted', 'ok'); closeModal(); refreshStats(); route(); }
  catch (err) { toast('Delete failed: ' + err.message, 'err'); }
}
function showModal(body) { const m = $('#modal'); $('#modal-body').innerHTML = ''; $('#modal-body').append(body); m.classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ── Share dialog ─────────────────────────────────────────────────────────────
function shareDialog(file) {
  const permission = el('select', {}, el('option', { value: 'view' }, 'View (inline)'), el('option', { value: 'download' }, 'Force download'));
  const pw = el('input', { type: 'password', placeholder: 'Optional password' });
  const days = el('input', { type: 'number', min: '0', placeholder: 'e.g. 7' });
  const maxdl = el('input', { type: 'number', min: '0', placeholder: 'Unlimited' });
  const out = el('div', {});
  const form = el('div', { class: 'preview-info' },
    el('h3', {}, 'Create share link'),
    el('div', { class: 'muted', style: 'font-size:12px' }, file.path),
    el('div', { style: 'display:grid;gap:12px;margin:16px 0' },
      el('label', {}, 'Permission', permission),
      el('label', {}, 'Password (optional)', pw),
      el('label', {}, 'Expires in (days, optional)', days),
      el('label', {}, 'Max downloads (optional)', maxdl),
    ),
    el('div', { class: 'preview-actions' },
      el('button', { class: 'btn btn-primary', onclick: create }, '🔗 Create link'),
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    ),
    out,
  );
  showModal(form);

  async function create() {
    try {
      const r = await api('POST', '/_api/shares', {
        path: file.path, permission: permission.value,
        password: pw.value || undefined,
        expires_in_days: days.value ? Number(days.value) : undefined,
        max_downloads: maxdl.value ? Number(maxdl.value) : undefined,
      });
      out.innerHTML = '';
      const link = r.url;
      out.append(el('div', { class: 'panel', style: 'margin-top:14px' },
        el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' }, 'Shareable link' + (r.share.protected ? ' (password-protected)' : '')),
        el('div', { style: 'display:flex;gap:8px' },
          el('input', { value: link, readonly: '', onclick: (e) => e.target.select() }),
          el('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(link).then(() => toast('Link copied', 'ok')) }, 'Copy'),
        ),
      ));
      toast('Share created', 'ok');
    } catch (err) { toast(err.message || 'Failed', 'err'); }
  }
}

// ── Shares view ──────────────────────────────────────────────────────────────
async function sharesView(root) {
  const wrap = el('div', { class: 'panel' }, el('h3', {}, 'Active share links'), el('div', { id: 'shares-table' }, 'Loading…'));
  root.append(wrap);
  try {
    const r = await api('GET', '/_api/shares');
    if (!r.shares.length) { $('#shares-table').innerHTML = ''; $('#shares-table').append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🔗'), 'No share links yet. Create one from a file preview.')); return; }
    const t = el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'File'), el('th', {}, 'Link'), el('th', {}, 'Access'), el('th', {}, 'Expires'), el('th', {}, 'Downloads'), el('th', {}, ''))),
      el('tbody', {}, ...r.shares.map((s) => el('tr', {},
        el('td', { title: s.file_path || '' }, s.file_name || s.file_path || '—'),
        el('td', {}, el('a', { href: s.url, target: '_blank' }, '↗ open'), ' ',
          el('button', { class: 'btn btn-sm', onclick: () => navigator.clipboard.writeText(s.url).then(() => toast('Copied', 'ok')) }, 'copy')),
        el('td', {}, (s.permission === 'download' ? '⬇ download' : '👁 view') + (s.protected ? ' · 🔒' : '')),
        el('td', {}, s.expires_at ? fmtDate(s.expires_at) : '—'),
        el('td', {}, String(s.download_count) + (s.max_downloads ? ' / ' + s.max_downloads : '')),
        el('td', {}, el('button', { class: 'btn btn-sm btn-danger', onclick: () => revokeShare(s.id) }, 'Revoke')),
      ))),
    );
    $('#shares-table').innerHTML = ''; $('#shares-table').append(t);
  } catch (err) { $('#shares-table').textContent = err.message; }
  async function revokeShare(id) {
    if (!confirm('Revoke this link? It will stop working immediately.')) return;
    try { await api('DELETE', '/_api/shares/' + id); toast('Revoked', 'ok'); sharesView(root.replaceChildren() || root); } catch (e) { toast(e.message, 'err'); }
  }
}

// ── Duplicates ───────────────────────────────────────────────────────────────
async function showDuplicates(wrap) {
  wrap.innerHTML = '<div class="empty">Scanning for duplicates…</div>';
  try {
    const r = await api('GET', '/_api/files/duplicates');
    wrap.innerHTML = '';
    wrap.append(el('div', { class: 'toolbar' },
      el('div', {}, el('b', {}, String(r.groups.length)), ' duplicate group(s) · ', el('b', {}, fmtBytes(r.wastedBytes)), ' reclaimable'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: () => route() }, '← Back to files'),
    ));
    if (!r.groups.length) { wrap.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '✨'), 'No duplicate files found.')); return; }
    for (const g of r.groups) {
      wrap.append(el('div', { class: 'panel' },
        el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' },
          `${g.count} copies · ${fmtBytes(g.size_bytes)} each · sha256 ${g.checksum.slice(0, 16)}…`),
        el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
          ...g.paths.map((p) => el('div', { style: 'display:flex;gap:8px;align-items:center' },
            el('a', { href: encPath(p), target: '_blank', style: 'font-size:13px' }, p)))),
      ));
    }
  } catch (err) { wrap.innerHTML = ''; wrap.append(el('div', { class: 'empty' }, err.message || 'Failed')); }
}

// ── Upload view ──────────────────────────────────────────────────────────────
function uploadView(root) {
  const panel = el('div', { class: 'panel' },
    el('h3', {}, 'Upload masters'),
    el('div', { class: 'row' },
      el('label', {}, 'Folder / path prefix', el('input', { id: 'up-prefix', placeholder: 'e.g. uploads/2026', value: 'uploads' })),
      el('label', {}, 'Visibility', el('select', { id: 'up-vis' }, el('option', { value: 'public' }, 'Public'), el('option', { value: 'private' }, 'Private'))),
    ),
  );
  const dz = el('div', { class: 'dropzone' },
    el('div', { class: 'big' }, '⬆️'),
    el('div', {}, el('b', {}, 'Drop files here'), ' or click to browse'),
    el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, 'Multiple files supported (bulk upload)'),
  );
  const picker = el('input', { type: 'file', multiple: '', class: 'hidden' });
  const list = el('div', { class: 'uplist' });
  root.append(panel, dz, picker, list);

  dz.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => { queueUploads([...picker.files], list); picker.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { queueUploads([...e.dataTransfer.files], list); });
}
function queueUploads(files, list) {
  const prefix = ($('#up-prefix').value || '').replace(/^\/+|\/+$/g, '');
  const vis = $('#up-vis').value;
  for (const file of files) uploadOne(file, prefix, vis, list);
}
function uploadOne(file, prefix, visibility, list) {
  const rel = [prefix, file.name].filter(Boolean).join('/');
  const bar = el('span', {});
  const status = el('div', { class: 'up-status' }, '0%');
  const row = el('div', { class: 'uprow' },
    el('div', { class: 'name', title: rel }, rel),
    el('div', { class: 'muted', style: 'font-size:12px' }, fmtBytes(file.size)),
    el('div', { class: 'progress' }, bar),
    status,
  );
  list.prepend(row);

  const xhr = new XMLHttpRequest();
  xhr.open('PUT', encPath(rel));
  xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
  if (file.type) xhr.setRequestHeader('Content-Type', file.type);
  if (visibility === 'private') xhr.setRequestHeader('X-Visibility', 'private');
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    bar.style.width = pct + '%'; status.textContent = pct + '%';
  });
  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) { bar.style.width = '100%'; status.textContent = '✓ done'; status.className = 'up-status ok'; refreshStats(); }
    else {
      const msg = xhr.status === 413 ? (/quota/i.test(xhr.responseText || '') ? 'over quota' : 'too large') : 'error ' + xhr.status;
      status.textContent = msg; status.className = 'up-status err';
      if (xhr.status === 413) toast('Upload rejected: ' + (xhr.responseText || 'limit'), 'err');
    }
  });
  xhr.addEventListener('error', () => { status.textContent = 'failed'; status.className = 'up-status err'; });
  xhr.send(file);
}

// ── Users view (admin) ───────────────────────────────────────────────────────
async function usersView(root) {
  const create = el('div', { class: 'panel' },
    el('h3', {}, 'Create user'),
    el('div', { class: 'row' },
      el('label', {}, 'Email', el('input', { id: 'nu-email', type: 'email' })),
      el('label', {}, 'Username', el('input', { id: 'nu-username' })),
      el('label', {}, 'Password', el('input', { id: 'nu-password', type: 'password' })),
      el('label', {}, 'Role', el('select', { id: 'nu-role' }, el('option', { value: 'editor' }, 'Editor'), el('option', { value: 'viewer' }, 'Viewer'), el('option', { value: 'admin' }, 'Admin'))),
      el('label', {}, 'Quota (MB, optional)', el('input', { id: 'nu-quota', type: 'number', min: '0', placeholder: 'unlimited' })),
      el('button', { class: 'btn btn-primary', onclick: createUser }, 'Create'),
    ),
  );
  const tableWrap = el('div', { class: 'panel' }, el('h3', {}, 'Users'), el('div', { id: 'users-table' }, 'Loading…'));
  const storageWrap = el('div', { class: 'panel' }, el('h3', {}, 'Storage volumes'), el('div', { id: 'storage-table' }, 'Loading…'));
  root.append(storageWrap, create, tableWrap);
  loadStorage();
  loadUsers();

  async function loadStorage() {
    try {
      const r = await api('GET', '/_api/storage');
      const rows = r.volumes.map((v) => {
        const used = v.totalBytes != null ? v.totalBytes - v.freeBytes : null;
        const pct = v.totalBytes ? Math.round((used / v.totalBytes) * 100) : null;
        const bar = el('div', { class: 'progress', style: 'width:140px' }, el('span', { style: `width:${pct || 0}%;${pct >= 90 ? 'background:var(--danger)' : ''}` }));
        return el('tr', {},
          el('td', {}, el('b', {}, v.id), v.readOnly ? el('span', { class: 'badge', style: 'margin-left:6px' }, 'read-only') : null),
          el('td', { title: v.dir, style: 'font-size:12px;color:var(--muted)' }, v.dir),
          el('td', {}, v.freeBytes != null ? fmtBytes(v.freeBytes) + ' free' : '—'),
          el('td', {}, v.totalBytes != null ? fmtBytes(v.totalBytes) : '—'),
          el('td', {}, pct != null ? el('div', { style: 'display:flex;gap:8px;align-items:center' }, bar, el('span', {}, pct + '%')) : '—'),
        );
      });
      const t = el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Volume'), el('th', {}, 'Path'), el('th', {}, 'Free'), el('th', {}, 'Total'), el('th', {}, 'Used'))),
        el('tbody', {}, ...rows));
      $('#storage-table').innerHTML = '';
      $('#storage-table').append(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, `Placement policy: ${r.placement}${r.multi ? '' : ' · single volume'}`), t);
    } catch (err) { $('#storage-table').textContent = err.message; }
  }

  async function loadUsers() {
    try {
      const r = await api('GET', '/_api/users');
      const t = el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'ID'), el('th', {}, 'Username'), el('th', {}, 'Email'), el('th', {}, 'Roles'), el('th', {}, 'Storage'), el('th', {}, 'Status'), el('th', {}, ''))),
        el('tbody', {}, ...r.users.map((u) => el('tr', {},
          el('td', {}, String(u.id)),
          el('td', {}, u.username),
          el('td', {}, u.email),
          el('td', {}, (u.roles || []).join(', ')),
          el('td', {}, storageCell(u)),
          el('td', {}, u.status),
          el('td', {}, el('button', { class: 'btn btn-sm', onclick: () => setQuota(u) }, 'Quota')),
        ))),
      );
      $('#users-table').innerHTML = ''; $('#users-table').append(t);
    } catch (err) { $('#users-table').textContent = err.message; }
  }
  function storageCell(u) {
    const used = fmtBytes(u.used_bytes || 0);
    if (u.storage_quota_bytes == null) return used + ' / ∞';
    const pct = u.storage_quota_bytes > 0 ? Math.min(100, Math.round((u.used_bytes / u.storage_quota_bytes) * 100)) : 0;
    return el('span', { class: pct >= 90 ? 'over' : '' }, `${used} / ${fmtBytes(u.storage_quota_bytes)} (${pct}%)`);
  }
  async function setQuota(u) {
    const cur = u.storage_quota_bytes == null ? '' : Math.round(u.storage_quota_bytes / 1048576);
    const input = prompt(`Storage quota for ${u.username} in MB (blank = unlimited):`, cur);
    if (input === null) return;
    const bytes = input.trim() === '' ? null : Math.round(Number(input) * 1048576);
    try { await api('POST', `/_api/users/${u.id}/quota`, { bytes }); toast('Quota updated', 'ok'); loadUsers(); }
    catch (err) { toast(err.message, 'err'); }
  }
  async function createUser() {
    try {
      const quotaMb = $('#nu-quota').value.trim();
      await api('POST', '/_api/users', {
        email: $('#nu-email').value.trim(), username: $('#nu-username').value.trim(),
        password: $('#nu-password').value, role: $('#nu-role').value,
        storage_quota_bytes: quotaMb === '' ? undefined : Math.round(Number(quotaMb) * 1048576),
      });
      toast('User created', 'ok');
      $('#nu-email').value = ''; $('#nu-username').value = ''; $('#nu-password').value = ''; $('#nu-quota').value = '';
      loadUsers(); refreshStats();
    } catch (err) { toast(err.message, 'err'); }
  }
}

// ── Audit view (admin) ───────────────────────────────────────────────────────
async function auditView(root) {
  const wrap = el('div', { class: 'panel' }, el('h3', {}, 'Recent activity'), el('div', { id: 'audit-table' }, 'Loading…'));
  root.append(wrap);
  try {
    const r = await api('GET', '/_api/audit?limit=200');
    const t = el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Action'), el('th', {}, 'User'), el('th', {}, 'Target'), el('th', {}, 'IP'))),
      el('tbody', {}, ...r.events.map((e) => el('tr', {},
        el('td', {}, fmtDate(e.created_at)),
        el('td', {}, el('span', { class: 'badge' }, e.action)),
        el('td', {}, e.user_id != null ? '#' + e.user_id : '—'),
        el('td', { title: e.target_path || '' }, e.target_path || '—'),
        el('td', {}, e.ip || '—'),
      ))),
    );
    $('#audit-table').innerHTML = ''; $('#audit-table').append(t);
  } catch (err) { $('#audit-table').textContent = err.message; }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
if (S.token) enterApp(); else showAuth();
