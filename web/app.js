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
  $('#f-mfa-wrap').classList.add('hidden');
  $('#f-mfa').value = '';
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
      const mfa_code = $('#f-mfa').value.trim();
      r = await api('POST', '/_api/auth/login', { login, password, ...(mfa_code ? { mfa_code } : {}) });
    }
    setSession(r.token, r.user, r.roles);
    enterApp();
  } catch (err) {
    const code = err.json && err.json.error;
    // The password was right and a second factor is owed — reveal the field and let
    // them finish, rather than reporting it as a failed sign-in.
    if (code === 'mfa_required') {
      $('#f-mfa-wrap').classList.remove('hidden');
      $('#f-mfa').focus();
      errBox.textContent = $('#f-mfa').value ? 'That code was not accepted. Try again.' : 'Enter the code from your authenticator app.';
      errBox.classList.remove('hidden');
      return;
    }
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
      // Only worth screen space when there is something to act on.
      s.missing ? el('span', { class: 'over', title: 'Indexed files whose bytes are no longer on any volume' }, el('b', {}, String(s.missing)), ' missing') : null,
      s.jobs && s.jobs.queued ? el('span', { title: 'Queued background jobs' }, el('b', {}, String(s.jobs.queued)), ' queued') : null,
    );
  } catch { /* ignore */ }
}

// ── Router ───────────────────────────────────────────────────────────────────
const VIEWS = { files: filesView, upload: uploadView, shares: sharesView, account: accountView, users: usersView, jobs: jobsView, audit: auditView };
const TITLES = { files: 'Files', upload: 'Upload', shares: 'Share links', account: 'Account & security', users: 'Users', jobs: 'Background jobs', audit: 'Audit log' };
const ADMIN_VIEWS = new Set(['users', 'jobs', 'audit']);
function route() {
  if (!S.token) return showAuth();
  let name = (location.hash.replace(/^#\//, '') || 'files').split('/')[0];
  if (!VIEWS[name]) name = 'files';
  if (ADMIN_VIEWS.has(name) && !isAdmin()) name = 'files';
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

// ── Account view ─────────────────────────────────────────────────────────────
// Everything a user can do about their own security in one place: change the
// password, enrol a second factor, and mint the API tokens that scripts and WebDAV
// clients use instead of a password.
async function accountView(root) {
  const pwPanel = el('div', { class: 'panel' },
    el('h3', {}, 'Change password'),
    el('div', { class: 'row' },
      el('label', {}, 'Current password', el('input', { id: 'pw-old', type: 'password', autocomplete: 'current-password' })),
      el('label', {}, 'New password', el('input', { id: 'pw-new', type: 'password', autocomplete: 'new-password' })),
      el('button', { class: 'btn btn-primary', onclick: changePassword }, 'Change'),
    ),
    el('p', { class: 'muted', style: 'font-size:12px;margin:8px 0 0' },
      'Changing your password signs out every other session — this one stays.'),
  );
  const mfaPanel = el('div', { class: 'panel' }, el('h3', {}, 'Two-factor authentication'), el('div', { id: 'mfa-body' }, 'Loading…'));
  const tokPanel = el('div', { class: 'panel' },
    el('h3', {}, 'API tokens'),
    el('p', { class: 'muted', style: 'font-size:12px;margin:0 0 10px' },
      'Long-lived credentials for scripts, CI and WebDAV clients. A token acts as you and can be revoked ' +
      'on its own — and it is the way in for an account with two-factor enabled, since Basic auth has ' +
      'nowhere to put a code.'),
    el('div', { class: 'row' },
      el('label', {}, 'Name', el('input', { id: 'tok-name', placeholder: 'e.g. ci-pipeline' })),
      el('label', {}, 'Expires in (days, optional)', el('input', { id: 'tok-days', type: 'number', min: '1', placeholder: 'never' })),
      el('button', { class: 'btn btn-primary', onclick: createToken }, 'Create token'),
    ),
    el('div', { id: 'tok-table', style: 'margin-top:14px' }, 'Loading…'),
  );
  root.append(pwPanel, mfaPanel, tokPanel);
  loadMfa();
  loadTokens();

  async function changePassword() {
    try {
      await api('POST', '/_api/auth/password', { old_password: $('#pw-old').value, new_password: $('#pw-new').value });
      $('#pw-old').value = ''; $('#pw-new').value = '';
      toast('Password changed; other sessions signed out', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  async function loadMfa() {
    const box = $('#mfa-body');
    try {
      const me = await api('GET', '/_api/auth/me');
      box.innerHTML = '';
      if (!me.mfa || !me.mfa.available) {
        box.append(el('div', { class: 'muted' }, 'Not enabled on this server (set MFA_ENABLED=1).'));
        return;
      }
      if (me.mfa.enabled) {
        box.append(
          el('div', {}, '🔒 ', el('b', {}, 'Enabled'), ` · ${me.mfa.recoveryCodesRemaining} recovery code(s) left`),
          el('div', { class: 'preview-actions', style: 'margin-top:12px' },
            el('button', { class: 'btn', onclick: () => withPassword('New recovery codes — confirm your password:', (password) => api('POST', '/_api/auth/mfa/recovery', { password }).then((r) => showCodes(r.recovery_codes))) }, 'New recovery codes'),
            el('button', { class: 'btn btn-danger', onclick: () => withPassword('Turn off two-factor — confirm your password:', (password) => api('POST', '/_api/auth/mfa/disable', { password }).then(() => { toast('Two-factor disabled', 'ok'); loadMfa(); })) }, 'Turn off'),
          ),
        );
        return;
      }
      box.append(
        el('div', { class: 'muted' }, 'Off. Enrol an authenticator app (Google Authenticator, 1Password, Aegis…).'),
        el('div', { class: 'preview-actions', style: 'margin-top:12px' },
          el('button', { class: 'btn btn-primary', onclick: startEnrol }, 'Set up two-factor')),
      );
    } catch (err) { box.textContent = err.message; }
  }

  async function startEnrol() {
    try {
      const s = await api('POST', '/_api/auth/mfa/setup');
      const box = $('#mfa-body');
      box.innerHTML = '';
      box.append(
        el('p', {}, 'Add this secret to your authenticator app, then enter the 6-digit code it shows.'),
        el('code', { style: 'display:block;padding:10px;border-radius:8px;background:var(--panel-2, #0002);word-break:break-all;margin-bottom:10px' }, s.secret),
        el('p', { class: 'muted', style: 'font-size:12px' }, 'Or open this URI on the device: ', el('code', { style: 'word-break:break-all' }, s.otpauth_url)),
        el('div', { class: 'row' },
          el('label', {}, 'Code', el('input', { id: 'mfa-code', inputmode: 'numeric', placeholder: '123456', maxlength: '6' })),
          el('button', { class: 'btn btn-primary', onclick: finishEnrol }, 'Verify & enable'),
          el('button', { class: 'btn', onclick: loadMfa }, 'Cancel'),
        ),
      );
    } catch (err) { toast(err.message, 'err'); }
  }

  async function finishEnrol() {
    try {
      const r = await api('POST', '/_api/auth/mfa/enable', { code: $('#mfa-code').value.trim() });
      showCodes(r.recovery_codes);
      loadMfa();
    } catch (err) { toast(err.message, 'err'); }
  }

  // Recovery codes exist for exactly one moment; make that moment hard to miss.
  function showCodes(codes) {
    showModal(el('div', { class: 'preview-info' },
      el('h3', {}, 'Recovery codes'),
      el('p', { class: 'muted' }, 'Each works once, if you lose your authenticator. They are not shown again.'),
      el('pre', { style: 'padding:12px;border-radius:8px;background:var(--panel-2, #0002);overflow:auto' }, codes.join('\n')),
      el('div', { class: 'preview-actions' },
        el('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Copied', 'ok')) }, 'Copy'),
      ),
    ));
  }

  async function withPassword(prompt_, fn) {
    const password = prompt(prompt_);
    if (password === null) return;
    try { await fn(password); } catch (err) { toast(err.message, 'err'); }
  }

  async function loadTokens() {
    try {
      const r = await api('GET', '/_api/tokens');
      const box = $('#tok-table');
      box.innerHTML = '';
      if (!r.tokens.length) { box.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🔑'), 'No API tokens yet.')); return; }
      box.append(el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Created'), el('th', {}, 'Last used'), el('th', {}, 'Expires'), el('th', {}, ''))),
        el('tbody', {}, ...r.tokens.map((tk) => el('tr', {},
          el('td', {}, tk.name),
          el('td', {}, fmtDate(tk.created_at)),
          el('td', {}, tk.last_used_at ? fmtDate(tk.last_used_at) : 'never'),
          el('td', {}, tk.expires_at ? (tk.expired ? el('span', { class: 'over' }, 'expired') : fmtDate(tk.expires_at)) : '—'),
          el('td', {}, el('button', { class: 'btn btn-sm btn-danger', onclick: () => revokeToken(tk) }, 'Revoke')),
        ))),
      ));
    } catch (err) { $('#tok-table').textContent = err.message; }
  }

  async function createToken() {
    const name = $('#tok-name').value.trim();
    if (!name) return toast('Give the token a name', 'err');
    const days = $('#tok-days').value.trim();
    try {
      const r = await api('POST', '/_api/tokens', { name, expires_in_days: days ? Number(days) : null });
      $('#tok-name').value = ''; $('#tok-days').value = '';
      showModal(el('div', { class: 'preview-info' },
        el('h3', {}, 'Copy this token now'),
        el('p', { class: 'muted' }, 'It is stored hashed and cannot be shown again.'),
        el('pre', { style: 'padding:12px;border-radius:8px;background:var(--panel-2, #0002);overflow:auto;word-break:break-all' }, r.token),
        el('div', { class: 'preview-actions' },
          el('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(r.token).then(() => toast('Copied', 'ok')) }, 'Copy')),
      ));
      loadTokens();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function revokeToken(tk) {
    if (!confirm(`Revoke "${tk.name}"? Anything using it stops working immediately.`)) return;
    try { await api('DELETE', `/_api/tokens/${tk.id}`); toast('Revoked', 'ok'); loadTokens(); }
    catch (err) { toast(err.message, 'err'); }
  }
}

// ── Jobs view (admin) ────────────────────────────────────────────────────────
// The window onto background work: what the worker is, what is queued, and the one
// button an operator actually needs after mounting an existing master directory —
// "Scan now", which is what makes pre-existing files visible to the whole console.
async function jobsView(root) {
  const status = el('div', { class: 'muted', style: 'font-size:13px' }, 'Loading…');
  const head = el('div', { class: 'panel' },
    el('h3', {}, 'Worker'),
    status,
    el('div', { class: 'preview-actions', style: 'margin-top:12px' },
      el('button', { class: 'btn btn-primary', onclick: () => queueScan(null) }, '🔄 Scan all volumes'),
      el('span', { id: 'scan-vols', style: 'display:flex;gap:8px;flex-wrap:wrap' }),
    ),
    el('p', { class: 'muted', style: 'font-size:12px;margin:10px 0 0' },
      'A scan reconciles the filesystem into the index: files copied or mounted in directly are indexed, ' +
      'drifted sizes are refreshed, and rows whose bytes are gone are marked missing (never deleted). ' +
      'It is rate-limited so it never starves live requests.'),
  );
  const tableWrap = el('div', { class: 'panel' }, el('h3', {}, 'Recent jobs'), el('div', { id: 'jobs-table' }, 'Loading…'));
  root.append(head, tableWrap);

  let timer = null;
  await load();
  // Poll while this view is on screen; the router replaces #view on navigation.
  timer = setInterval(() => { if (!document.body.contains(tableWrap)) return clearInterval(timer); load(); }, 3000);

  async function load() {
    try {
      const r = await api('GET', '/_api/jobs?limit=40');
      const w = r.worker || {};
      status.innerHTML = '';
      status.append(
        el('span', {}, w.running ? '🟢 running' : '⚪ not running in this process', ` · ${w.concurrency} slot(s) · types: ${(w.types || []).join(', ') || 'none'}`),
        el('div', { style: 'margin-top:8px;display:flex;gap:12px;flex-wrap:wrap' },
          ...Object.entries(r.summary || {}).map(([k, v]) => el('span', { class: 'badge' }, `${k}: ${v}`))),
      );
      renderVolumeButtons();
      renderJobs(r.jobs || []);
    } catch (err) {
      status.textContent = err.status === 503 ? 'The job queue is not available (no database).' : err.message;
    }
  }

  async function renderVolumeButtons() {
    const box = $('#scan-vols');
    if (!box || box.childElementCount) return;
    try {
      const s = await api('GET', '/_api/storage');
      if (!s.multi) return;
      for (const v of s.volumes) box.append(el('button', { class: 'btn btn-sm', onclick: () => queueScan(v.id) }, `Scan ${v.id}`));
    } catch { /* volume list is a nicety */ }
  }

  function renderJobs(jobs) {
    const box = $('#jobs-table');
    box.innerHTML = '';
    if (!jobs.length) { box.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '⚙️'), 'No jobs yet.')); return; }
    box.append(el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'ID'), el('th', {}, 'Type'), el('th', {}, 'State'), el('th', {}, 'Detail'), el('th', {}, 'Attempts'), el('th', {}, 'Updated'), el('th', {}, ''))),
      el('tbody', {}, ...jobs.map((j) => el('tr', {},
        el('td', {}, String(j.id)),
        el('td', {}, j.type),
        el('td', {}, el('span', { class: 'badge' }, stateIcon(j.state) + ' ' + j.state)),
        el('td', { style: 'font-size:12px;color:var(--muted);max-width:340px;overflow:hidden;text-overflow:ellipsis' }, jobDetail(j)),
        el('td', {}, `${j.attempts}/${j.max_attempts}`),
        el('td', {}, fmtDate(j.updated_at)),
        el('td', {}, jobActions(j)),
      ))),
    ));
  }

  function jobActions(j) {
    if (j.state === 'queued' || j.state === 'running') {
      return el('button', { class: 'btn btn-sm', onclick: () => act(`/_api/jobs/${j.id}/cancel`, 'Cancelled') }, 'Cancel');
    }
    return el('button', { class: 'btn btn-sm', onclick: () => act(`/_api/jobs/${j.id}/retry`, 'Re-queued') }, 'Retry');
  }

  async function act(path, okMsg) {
    try { await api('POST', path, {}); toast(okMsg, 'ok'); load(); }
    catch (err) { toast(err.message, 'err'); }
  }

  async function queueScan(volumeId) {
    try {
      await api('POST', '/_api/jobs', { type: 'scan', payload: volumeId ? { volumeId } : {} });
      toast(volumeId ? `Scan of ${volumeId} queued` : 'Scan queued', 'ok');
      load();
    } catch (err) { toast(err.message, 'err'); }
  }
}

function stateIcon(s) {
  return { queued: '⏳', running: '⚙️', done: '✅', failed: '❌', cancelled: '🚫' }[s] || '•';
}
function jobDetail(j) {
  if (j.error) return j.error.split('\n')[0].slice(0, 200);
  const r = j.result || {};
  if (j.type === 'scan' && r.seen != null) return `${r.seen} files · +${r.created} new · ~${r.updated} updated · ${r.missing} missing`;
  if (j.type === 'extract' && r.path) return r.missing ? `${r.path} (bytes not found)` : r.path;
  const p = j.payload || {};
  return p.path || (p.volumeId ? `volume ${p.volumeId}` : '');
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
          el('td', {}, rolesCell(u)),
          el('td', {}, storageCell(u)),
          el('td', {}, el('span', { class: u.status === 'disabled' ? 'over' : '' }, u.status), u.mfa_enabled ? ' 🔒' : ''),
          el('td', {}, el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
            el('button', { class: 'btn btn-sm', onclick: () => setQuota(u) }, 'Quota'),
            el('button', { class: 'btn btn-sm', onclick: () => grantRole(u) }, '+ Role'),
            el('button', { class: 'btn btn-sm', onclick: () => resetPassword(u) }, 'Reset password'),
            u.mfa_enabled ? el('button', { class: 'btn btn-sm', onclick: () => resetMfa(u) }, 'Reset 2FA') : null,
            el('button', { class: 'btn btn-sm', onclick: () => toggleStatus(u) }, u.status === 'disabled' ? 'Enable' : 'Disable'),
            el('button', { class: 'btn btn-sm btn-danger', onclick: () => removeUser(u) }, 'Delete'),
          )),
        ))),
      );
      $('#users-table').innerHTML = ''; $('#users-table').append(t);
      S.userList = r.users;
    } catch (err) { $('#users-table').textContent = err.message; }
  }

  // Each role is a chip with its own revoke affordance — the route table could grant
  // roles and never take one back, so a mis-click promoting someone was permanent.
  function rolesCell(u) {
    const wrap = el('span', { style: 'display:flex;gap:4px;flex-wrap:wrap' });
    for (const r of u.roles || []) {
      wrap.append(el('span', { class: 'badge' }, r, ' ',
        el('a', { href: '#', title: `Revoke ${r}`, onclick: (e) => { e.preventDefault(); revokeRole(u, r); } }, '×')));
    }
    return wrap;
  }

  async function revokeRole(u, role) {
    if (!confirm(`Revoke "${role}" from ${u.username}? Their sessions are signed out.`)) return;
    try { await api('DELETE', `/_api/users/${u.id}/roles/${role}`); toast('Role revoked', 'ok'); loadUsers(); }
    catch (err) { toast(err.message, 'err'); }
  }

  async function grantRole(u) {
    const role = prompt(`Grant which role to ${u.username}? (admin / editor / viewer)`);
    if (!role) return;
    try { await api('POST', `/_api/users/${u.id}/roles`, { role: role.trim().toLowerCase() }); toast('Role granted', 'ok'); loadUsers(); }
    catch (err) { toast(err.message, 'err'); }
  }

  async function toggleStatus(u) {
    const next = u.status === 'disabled' ? 'active' : 'disabled';
    if (next === 'disabled' && !confirm(`Disable ${u.username}? Their sessions end immediately.`)) return;
    try { await api('POST', `/_api/users/${u.id}/status`, { status: next }); toast(`Account ${next}`, 'ok'); loadUsers(); }
    catch (err) { toast(err.message, 'err'); }
  }

  async function resetPassword(u) {
    const pw = prompt(`New password for ${u.username} (they will be signed out everywhere):`);
    if (!pw) return;
    try { await api('POST', `/_api/users/${u.id}/password`, { new_password: pw }); toast('Password reset', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  }

  async function resetMfa(u) {
    if (!confirm(`Turn off two-factor for ${u.username}? Use this when they have lost both their authenticator and their recovery codes.`)) return;
    try { await api('POST', `/_api/users/${u.id}/mfa/reset`, {}); toast('Two-factor reset', 'ok'); loadUsers(); }
    catch (err) { toast(err.message, 'err'); }
  }

  // Deleting an account is not a way to delete data: the masters are never touched,
  // and the operator chooses explicitly what happens to the rows that point at them.
  async function removeUser(u) {
    const choice = prompt(
      `Delete ${u.username}?\n\nTheir files are NOT deleted. Type:\n` +
      `  orphan   — keep the files with no owner (default)\n` +
      `  <username> — transfer ownership to that user\n\nOr Cancel.`, 'orphan');
    if (choice === null) return;
    let query = '?files=orphan';
    const target = choice.trim();
    if (target && target !== 'orphan') {
      const to = (S.userList || []).find((x) => x.username === target);
      if (!to) return toast(`No user "${target}"`, 'err');
      query = `?files=reassign&to=${to.id}`;
    }
    try { await api('DELETE', `/_api/users/${u.id}${query}`); toast('User deleted', 'ok'); loadUsers(); }
    catch (err) { toast(err.message, 'err'); }
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
