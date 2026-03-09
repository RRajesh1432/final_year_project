/**
 * PFT-AST Frontend · Unified App Script
 * Works on all 4 pages. PAGE variable set per-page.
 * Connects to BACKEND_URL (Railway) via Socket.IO + REST.
 */
'use strict';

// ── Config ─────────────────────────────────────────────────────
// Set BACKEND_URL in Vercel env vars → window.BACKEND_URL
// Falls back to same origin for local dev
const API = window.BACKEND_URL || '';

const THREATS = ['gunshot','explosion','glass','scream','siren'];
const TAU = 0.75;

// ── State ──────────────────────────────────────────────────────
let _chart = null, _socket = null, _swReg = null;
let _mediaRec = null, _chunks = [], _blob = null;
let _timerInt = null, _recSecs = 0;
let _actx = null, _analyser = null, _raf = null;
let _feedCt = 0, _alertCt = 0, _subbed = false;
let _deferredInstall = null;

// ═══════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════
function initPage() {
  highlightNav();
  connectSocket();
  registerSW();
  fetchStats();

  const P = window.PAGE;
  if (P === 'dashboard')     initDash();
  if (P === 'analyze')       initAnalyze();
  if (P === 'history')       initHistory();
  if (P === 'alerts')        initAlerts();
}

// ═══════════════════════════════════════════════════════════════
//  NAV
// ═══════════════════════════════════════════════════════════════
function highlightNav() {
  const P = window.PAGE;
  document.querySelectorAll('.nav-a').forEach(a => a.classList.toggle('on', a.dataset.p === P));
  document.querySelectorAll('.bn').forEach(a => a.classList.toggle('on', a.dataset.p === P));
}
function openNav() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('overlay').classList.add('on');
}
function closeNav() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('overlay')?.classList.remove('on');
}

// ═══════════════════════════════════════════════════════════════
//  SERVICE WORKER + PWA INSTALL
// ═══════════════════════════════════════════════════════════════
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(r => {
    _swReg = r;
    checkSub();
  }).catch(e => console.warn('[SW]', e));

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredInstall = e;
    const btn = document.getElementById('btnInstall');
    const st  = document.getElementById('installSt');
    if (btn) btn.style.display = 'block';
    if (st)  st.textContent = 'App can be installed — tap button above';
  });
  window.addEventListener('appinstalled', () => {
    const st = document.getElementById('installSt');
    if (st) st.textContent = '✓ App installed successfully!';
    const btn = document.getElementById('btnInstall');
    if (btn) btn.style.display = 'none';
  });
}

function doInstall() {
  if (!_deferredInstall) return;
  _deferredInstall.prompt();
}

// ═══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
async function checkSub() {
  if (!_swReg) return;
  try {
    const s = await _swReg.pushManager.getSubscription();
    _subbed = !!s;
    updateSubUI();
  } catch(_) {}
}

async function togglePush() {
  _subbed ? await unsubscribePush() : await subscribePush();
}

async function subscribePush() {
  if (!_swReg) return;
  try {
    const res = await apiFetch('/api/vapid-key');
    if (!res.key) { setPushStatus('Push not configured on server.'); return; }

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setPushStatus('Permission denied.'); return; }

    const sub = await _swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToUint8(res.key)
    });
    await apiPost('/api/subscribe', sub.toJSON());
    _subbed = true;
    updateSubUI();
  } catch (e) { setPushStatus('Error: ' + e.message); }
}

async function unsubscribePush() {
  try {
    const sub = await _swReg?.pushManager.getSubscription();
    if (sub) {
      await apiPost('/api/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    _subbed = false;
    updateSubUI();
  } catch(e) { console.error(e); }
}

function updateSubUI() {
  const btn = document.getElementById('btnPush');
  const st  = document.getElementById('pushSt');
  if (!btn) return;
  if (_subbed) {
    btn.textContent = 'Disable Notifications';
    btn.classList.add('sub');
    if (st) st.textContent = '✓ Push enabled — you\'ll get alerts when app is closed';
  } else {
    btn.textContent = 'Enable Push Notifications';
    btn.classList.remove('sub');
    if (st) st.textContent = 'Not subscribed yet';
  }
}
function setPushStatus(msg) { const el = document.getElementById('pushSt'); if (el) el.textContent = msg; }
function b64ToUint8(b64) {
  const p = '='.repeat((4 - b64.length%4)%4);
  const raw = atob((b64+p).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════
function connectSocket() {
  _socket = io(API, { transports: ['websocket','polling'], reconnectionDelay: 2000 });
  _socket.on('connect',    () => setConn(true));
  _socket.on('disconnect', () => setConn(false));
  _socket.on('reconnect',  () => setConn(true));
  _socket.on('stats_update', s => updateStatTiles(s));

  // ← fires when ANY device (mobile or desktop) submits audio
  _socket.on('analysis_result', data => {
    updateStatTiles(data.stats);
    if (data.threat_detected) {
      bumpAlerts();
      showBanner(data);
      setStatusChip(true);
    } else {
      setStatusChip(false);
    }
    if (window.PAGE === 'dashboard') { renderDash(data); addFeedRow(data); }
    if (window.PAGE === 'alerts')    { prependLiveAlert(data); }
    if (window.PAGE === 'history')   { fetchHistory(); }
  });
}

function setConn(on) {
  const el = document.getElementById('connBadge');
  const ld = document.getElementById('liveDot');
  const ll = document.getElementById('liveLabel');
  if (el) el.className = 'conn-badge' + (on ? '' : ' off');
  if (ld) ld.parentElement.className = 'live-pill' + (on ? '' : ' off');
  if (ll) ll.textContent = on ? 'SYSTEM ONLINE' : 'RECONNECTING...';
}

// ═══════════════════════════════════════════════════════════════
//  API HELPERS
// ═══════════════════════════════════════════════════════════════
async function apiFetch(path) {
  const r = await fetch(API + path);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function apiPredict(formData) {
  const r = await fetch(API + '/api/predict', { method: 'POST', body: formData });
  return r.json();
}

// ═══════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════
async function fetchStats() {
  try { updateStatTiles(await apiFetch('/api/stats')); } catch(_) {}
}
function updateStatTiles(s) {
  set('sTotal',   s.total   ?? 0);
  set('sThreat',  s.threats ?? 0);
  set('sAvg',     s.avg_score != null ? (s.avg_score*100).toFixed(1)+'%' : '—');
  set('sRate',    (s.threat_rate ?? 0)+'%');
}

// ═══════════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════════
function set(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }

function setStatusChip(danger) {
  const el = document.getElementById('statusChip');
  if (!el) return;
  el.className = 'status-chip' + (danger ? ' danger' : '');
  el.querySelector('.status-txt').textContent = danger ? 'THREAT' : 'SAFE';
}

function showBanner(data) {
  const bar = document.getElementById('alertBanner');
  const det = document.getElementById('bannerDetail');
  if (!bar) return;
  const top = data.multi_threat?.[0]?.label || 'Unknown';
  if (det) det.textContent = `${top.toUpperCase()} · ${(data.threat_score*100).toFixed(1)}% · ${data.source}`;
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), 9000);
}

function closeBanner() { document.getElementById('alertBanner')?.classList.remove('show'); }

function bumpAlerts() {
  _alertCt++;
  const bc  = document.getElementById('bellCount');
  const nb  = document.getElementById('bellBtn');
  const bnd = document.getElementById('bnAlertDot');
  const nbd = document.getElementById('navAlertBadge');
  if (bc)  { bc.textContent = _alertCt; bc.classList.add('show'); }
  if (nb)  nb.classList.add('danger');
  if (bnd) { bnd.textContent = _alertCt; bnd.classList.add('show'); }
  if (nbd) { nbd.textContent = _alertCt; nbd.classList.add('show'); }
}

function showLoader(msg) {
  const el = document.getElementById('loader'); if (el) el.classList.add('on');
  const m = document.getElementById('loaderMsg'); if (m && msg) m.textContent = msg;
}
function hideLoader() { document.getElementById('loader')?.classList.remove('on'); }

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════
function initDash() {}

function renderDash(data) {
  drawGauge(data.threat_score, data.risk);
  renderSpec(data.spectrogram);
  renderClasses(data.all_sounds, 'clsList', 12);
  drawProbChart(data.frames);
  renderThrBreak(data.multi_threat);
  renderTimeline(data.frames);
}

function addFeedRow(data) {
  _feedCt++;
  const list = document.getElementById('feedList');
  if (!list) return;
  list.querySelector('.empty')?.remove();
  const top = data.all_sounds?.[0]?.label || '—';
  const t   = data.threat_detected;
  const src = data.source || 'upload';
  const el  = document.createElement('div');
  el.className = `feed-row${t ? ' thr' : ''}`;
  el.innerHTML = `
    <div class="fd${t?' thr':''}"></div>
    <div class="fi"><div class="fc">${top}</div><div class="fm">${t?'⚠ THREAT · ':''}${new Date().toLocaleTimeString()}</div></div>
    <div class="fs-n${t?' thr':''}">${(data.threat_score*100).toFixed(1)}%</div>
    <span class="f-src ${src}">${src}</span>`;
  list.insertBefore(el, list.firstChild);
  while (list.children.length > 20) list.removeChild(list.lastChild);
  set('feedCount', _feedCt + ' event' + (_feedCt===1?'':'s'));
}

// ═══════════════════════════════════════════════════════════════
//  ANALYZE
// ═══════════════════════════════════════════════════════════════
function initAnalyze() {
  const dz    = document.getElementById('dropzone');
  const input = document.getElementById('audioIn');
  if (dz) {
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', ()  => dz.classList.remove('over'));
    dz.addEventListener('drop',      e  => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
    dz.addEventListener('click',     e  => { if (e.target.tagName !== 'BUTTON') input?.click(); });
  }
  if (input) input.addEventListener('change', () => { if (input.files[0]) setFile(input.files[0]); });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('on', p.id === 'pane-'+tab));
}

function setFile(file) {
  const dt = new DataTransfer(); dt.items.add(file);
  const inp = document.getElementById('audioIn');
  if (inp) inp.files = dt.files;
  document.getElementById('dropzone').style.display = 'none';
  const chip = document.getElementById('fileChip');
  if (chip) chip.classList.add('show');
  set('fcName', file.name); set('fcSize', fmtBytes(file.size));
}

function clearFile() {
  const inp = document.getElementById('audioIn');
  if (inp) inp.value = '';
  document.getElementById('dropzone').style.display = '';
  document.getElementById('fileChip')?.classList.remove('show');
}

async function analyzeUpload() {
  const inp = document.getElementById('audioIn');
  if (!inp?.files[0]) { alert('Select an audio file first.'); return; }
  showLoader('Analyzing with PFT-AST...');
  const fd = new FormData(); fd.append('audio', inp.files[0]); fd.append('source','upload');
  try {
    const data = await apiPredict(fd);
    if (data.error) { alert(data.error); return; }
    showResult(data);
  } catch(e) { alert('Error: '+e.message); }
  finally { hideLoader(); }
}

async function analyzeRec() {
  if (!_blob) return;
  showLoader('Analyzing recording...');
  const ext  = _blob.type.includes('ogg') ? 'ogg' : 'webm';
  const file = new File([_blob], `rec.${ext}`, { type: _blob.type });
  const fd   = new FormData(); fd.append('audio', file); fd.append('source','record');
  try {
    const data = await apiPredict(fd);
    if (data.error) { alert(data.error); return; }
    showResult(data);
  } catch(e) { alert('Error: '+e.message); }
  finally { hideLoader(); }
}

function showResult(data) {
  const card = document.getElementById('resultCard');
  if (!card) return;
  card.style.display = 'block';
  const pct  = (data.threat_score*100).toFixed(1)+'%';
  const risk = data.risk || (data.threat_detected ? 'HIGH' : 'SAFE');
  set('resPct', pct);
  const rt = document.getElementById('resRisk');
  if (rt) { rt.textContent = risk; rt.className = 'rtag r-' + risk.toLowerCase(); }
  drawMiniGauge('resGauge', data.threat_score);
  renderClasses(data.all_sounds, 'resClasses', 6);
  const sp = document.getElementById('resSpec');
  if (sp && data.spectrogram) { sp.src = `data:image/png;base64,${data.spectrogram}`; sp.style.display = 'block'; }
  card.scrollIntoView({ behavior: 'smooth' });
  if (data.threat_detected) showBanner(data);
}

// ═══════════════════════════════════════════════════════════════
//  RECORDING
// ═══════════════════════════════════════════════════════════════
function getMime() {
  return ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4','audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function toggleRec() {
  (_mediaRec?.state === 'recording') ? stopRec() : await startRec();
}

async function startRec() {
  _chunks = []; _blob = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate:16000, channelCount:1, echoCancellation:true } });
    _actx    = new AudioContext();
    _analyser = _actx.createAnalyser(); _analyser.fftSize = 512;
    _actx.createMediaStreamSource(stream).connect(_analyser);
    drawRecWave();

    _mediaRec = new MediaRecorder(stream, { mimeType: getMime() });
    _mediaRec.ondataavailable = e => { if (e.data.size>0) _chunks.push(e.data); };
    _mediaRec.onstop = () => {
      _blob = new Blob(_chunks, { type: getMime() || 'audio/webm' });
      stopRecViz();
      const btn = document.getElementById('btnAnalyzeRec');
      if (btn) btn.disabled = false;
      setRecLbl('Ready · ' + _recSecs + 's recorded');
    };
    _mediaRec.start(100);

    _recSecs = 0;
    _timerInt = setInterval(() => {
      _recSecs++;
      const el = document.getElementById('recTimer');
      if (el) { el.textContent = `${pad(_recSecs/60|0)}:${pad(_recSecs%60)}`; el.classList.add('on'); }
      if (_recSecs >= 60) stopRec();
    }, 1000);

    document.getElementById('btnRec')?.classList.add('on');
    set('recBtnLbl', 'Stop');
    setRecLbl('● RECORDING');
  } catch(e) { alert('Mic access denied: '+e.message); }
}

function stopRec() {
  if (_mediaRec?.state === 'recording') { _mediaRec.stop(); _mediaRec.stream.getTracks().forEach(t=>t.stop()); }
  clearInterval(_timerInt);
  document.getElementById('btnRec')?.classList.remove('on');
  set('recBtnLbl', 'Record');
  document.getElementById('recTimer')?.classList.remove('on');
}

function drawRecWave() {
  const canvas = document.getElementById('recC');
  if (!canvas || !_analyser) return;
  canvas.width  = canvas.offsetWidth * devicePixelRatio;
  canvas.height = 80 * devicePixelRatio;
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const W = canvas.offsetWidth, H = 80;
  const buf = new Uint8Array(_analyser.frequencyBinCount);
  function draw() {
    _raf = requestAnimationFrame(draw);
    _analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0,0,W,H);
    ctx.beginPath(); ctx.strokeStyle='#00e5ff'; ctx.lineWidth=1.5;
    buf.forEach((v,i) => { const y=(v/128)*(H/2); i?ctx.lineTo(i*(W/buf.length),y):ctx.moveTo(0,y); });
    ctx.stroke();
  }
  draw();
}

function stopRecViz() {
  cancelAnimationFrame(_raf);
  if (_actx) { _actx.close(); _actx=null; }
}

function setRecLbl(msg) { const e=document.getElementById('recVizLbl'); if(e) e.textContent=msg; }
function pad(n) { return String(n).padStart(2,'0'); }

// ═══════════════════════════════════════════════════════════════
//  HISTORY
// ═══════════════════════════════════════════════════════════════
async function initHistory() { await fetchHistory(); }

async function fetchHistory() {
  try {
    const [hist, stats] = await Promise.all([apiFetch('/api/history?limit=100'), apiFetch('/api/stats')]);
    updateStatTiles(stats);
    renderHistStats(stats);
    renderHistTable(hist);
  } catch(e) { console.error(e); }
}

function renderHistStats(s) {
  const el = document.getElementById('histStats');
  if (!el) return;
  el.innerHTML = `
    <div class="stat"><div class="stat-ic si-c"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#00e5ff" stroke-width="1.5"><rect x="2" y="2" width="13" height="13" rx="2"/><line x1="2" y1="7" x2="15" y2="7"/></svg></div><div><div class="stat-n">${s.total}</div><div class="stat-l">Total</div></div></div>
    <div class="stat r"><div class="stat-ic si-r"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#ff5252" stroke-width="1.5"><path d="M8.5 2L1 15h15L8.5 2z"/><line x1="8.5" y1="8" x2="8.5" y2="11"/></svg></div><div><div class="stat-n">${s.threats}</div><div class="stat-l">Threats</div></div></div>
    <div class="stat"><div class="stat-ic si-g"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#00e676" stroke-width="1.5"><path d="M8.5 1L2 4.5v5.5c0 3.5 3 6 6.5 6s6.5-2.5 6.5-6V4.5L8.5 1z"/></svg></div><div><div class="stat-n">${s.safe}</div><div class="stat-l">Safe</div></div></div>
    <div class="stat"><div class="stat-ic si-y"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#ffc107" stroke-width="1.5"><circle cx="8.5" cy="8.5" r="6.5"/><line x1="8.5" y1="5" x2="8.5" y2="8.5"/><line x1="8.5" y1="8.5" x2="11" y2="10"/></svg></div><div><div class="stat-n">${s.threat_rate}%</div><div class="stat-l">Rate</div></div></div>`;
}

function renderHistTable(rows) {
  const el = document.getElementById('histTable');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="empty" style="padding:28px">No analyses yet.</div>'; return; }
  const rTag = r => `<span class="rtag r-${r.toLowerCase()}">${r}</span>`;
  el.innerHTML = `
    <div class="h-hd"><div>#</div><div>Top Class</div><div>Score</div><div>Risk</div><div>Source</div><div>Time</div></div>
    ${rows.map(r=>`
    <div class="h-row${r.threat?' thr':''}" onclick="location.href='/'">
      <div class="h-id">${r.id}</div>
      <div class="h-cls">${r.top_class||'—'}</div>
      <div class="h-sc">${(r.score*100).toFixed(1)}%</div>
      <div>${rTag(r.risk)}</div>
      <div><span class="s-tag">${r.source||'upload'}</span></div>
      <div class="h-time">${r.date||''} ${r.time||''}</div>
    </div>`).join('')}`;
}

// ═══════════════════════════════════════════════════════════════
//  ALERTS PAGE
// ═══════════════════════════════════════════════════════════════
async function initAlerts() {
  checkSub();
  try {
    const data = await apiFetch('/api/alerts');
    renderHistAlerts(data);
  } catch(_) {}
}

function renderHistAlerts(rows) {
  const el = document.getElementById('histAlerts');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="empty" style="padding:24px">No threats recorded yet.</div>'; return; }
  el.innerHTML = rows.map(r => `
    <div class="alert-item">
      <div class="ai-icon">⚠</div>
      <div class="ai-body">
        <div class="ai-title">${(r.top_class||'Unknown').toUpperCase()}</div>
        <div class="ai-detail">Score ${(r.score*100).toFixed(1)}% · Source: ${r.source||'upload'}</div>
        <div class="ai-time">${r.date} ${r.time}</div>
      </div>
      <div class="ai-score">${(r.score*100).toFixed(0)}%</div>
    </div>`).join('');
}

function prependLiveAlert(data) {
  const el   = document.getElementById('liveAlerts');
  if (!el) return;
  el.querySelector('.empty')?.remove();
  const top  = data.multi_threat?.[0]?.label || 'Unknown';
  const item = document.createElement('div');
  item.className = 'alert-item';
  item.innerHTML = `
    <div class="ai-icon">⚠</div>
    <div class="ai-body">
      <div class="ai-title">${top.toUpperCase()} — LIVE</div>
      <div class="ai-detail">Score ${(data.threat_score*100).toFixed(1)}% · ${data.source}</div>
      <div class="ai-time">${new Date().toLocaleString()}</div>
    </div>
    <div class="ai-score" style="color:var(--red2)">${(data.threat_score*100).toFixed(0)}%</div>`;
  el.insertBefore(item, el.firstChild);
  const n = el.querySelectorAll('.alert-item').length;
  set('liveAlertCt', n + ' alert' + (n===1?'':'s'));
}

// ═══════════════════════════════════════════════════════════════
//  GAUGE
// ═══════════════════════════════════════════════════════════════
function drawGauge(score, risk) {
  const canvas = document.getElementById('gaugeC');
  if (!canvas) return;
  const S=160, cx=S/2, cy=S/2, r=66;
  canvas.width=S; canvas.height=S;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,S,S);

  // Track
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.strokeStyle='rgba(255,255,255,.04)'; ctx.lineWidth=12; ctx.stroke();

  // Zones
  [[0,.3,'rgba(0,230,118,.07)'],[.3,TAU,'rgba(255,193,7,.07)'],[TAU,1,'rgba(255,23,68,.07)']].forEach(([a,b,c])=>{
    ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2+a*Math.PI*2,-Math.PI/2+b*Math.PI*2);
    ctx.strokeStyle=c; ctx.lineWidth=12; ctx.stroke();
  });

  // Fill
  const clr = score>=TAU ? '#ff1744' : score>=.3 ? '#ffc107' : '#00e676';
  const g = ctx.createLinearGradient(cx-r,cy,cx+r,cy);
  if (score>=TAU){ g.addColorStop(0,'#ff1744'); g.addColorStop(1,'#ff6d00'); }
  else if(score>=.3){ g.addColorStop(0,'#ffc107'); g.addColorStop(1,'#ffea00'); }
  else{ g.addColorStop(0,'#00e676'); g.addColorStop(1,'#69f0ae'); }

  ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+(score||0)*Math.PI*2);
  ctx.strokeStyle=g; ctx.lineWidth=12; ctx.lineCap='round'; ctx.stroke();
  if (score>=TAU) {
    ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+score*Math.PI*2);
    ctx.strokeStyle='rgba(255,23,68,.2)'; ctx.lineWidth=20; ctx.stroke();
  }

  // τ marker
  const ta=-Math.PI/2+TAU*Math.PI*2;
  ctx.beginPath();
  ctx.moveTo(cx+(r-7)*Math.cos(ta), cy+(r-7)*Math.sin(ta));
  ctx.lineTo(cx+(r+6)*Math.cos(ta), cy+(r+6)*Math.sin(ta));
  ctx.strokeStyle='rgba(255,255,255,.45)'; ctx.lineWidth=2; ctx.lineCap='round'; ctx.stroke();

  const pe=document.getElementById('gaugePct'); const le=document.getElementById('gaugeRisk');
  if(pe){ pe.textContent=score!=null?Math.round(score*100)+'%':'—'; pe.style.color=clr; }
  if(le){ le.textContent=risk||'—'; le.className='gauge-risk'+(risk==='HIGH'?' danger':risk==='MEDIUM'?' medium':''); }
}

function drawMiniGauge(id, score) {
  const canvas=document.getElementById(id); if(!canvas) return;
  const S=84,cx=S/2,cy=S/2,r=32;
  canvas.width=S; canvas.height=S;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,S,S);
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.strokeStyle='rgba(255,255,255,.05)'; ctx.lineWidth=7; ctx.stroke();
  const clr=score>=TAU?'#ff1744':score>=.3?'#ffc107':'#00e676';
  ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+(score||0)*Math.PI*2);
  ctx.strokeStyle=clr; ctx.lineWidth=7; ctx.lineCap='round'; ctx.stroke();
  ctx.fillStyle=clr; ctx.font='bold 13px Orbitron,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(Math.round(score*100)+'%', cx, cy);
}

// ═══════════════════════════════════════════════════════════════
//  SPECTROGRAM
// ═══════════════════════════════════════════════════════════════
function renderSpec(b64) {
  const img=document.getElementById('specImg'); const emp=document.getElementById('specEmpty');
  if(!img||!b64) return;
  img.src=`data:image/png;base64,${b64}`; img.style.display='block';
  if(emp) emp.style.display='none';
}

// ═══════════════════════════════════════════════════════════════
//  CHART
// ═══════════════════════════════════════════════════════════════
function drawProbChart(frames) {
  const el=document.getElementById('probChart'); if(!el) return;
  if(_chart) _chart.destroy();
  const labels=frames.map(f=>f.start+'s');
  const probs=frames.map(f=>+(f.confidence*100).toFixed(1));
  _chart=new Chart(el.getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{label:'Threat %',data:probs,fill:true,tension:.42,borderColor:'#00e5ff',borderWidth:2,
      backgroundColor:c=>{const g=c.chart.ctx.createLinearGradient(0,0,0,120);g.addColorStop(0,'rgba(0,229,255,.13)');g.addColorStop(1,'rgba(0,229,255,0)');return g;},
      pointBackgroundColor:probs.map(p=>p>=75?'#ff1744':p>=30?'#ffc107':'#00e676'),
      pointRadius:5,pointHoverRadius:7}]},
    options:{responsive:true,maintainAspectRatio:true,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(10,20,34,.95)',borderColor:'rgba(0,229,255,.3)',borderWidth:1,titleColor:'#8ba7c7',bodyColor:'#00e5ff',bodyFont:{family:'Space Mono',size:11}}},
      scales:{x:{ticks:{color:'#4a6080',font:{family:'Space Mono',size:9}},grid:{color:'rgba(255,255,255,.025)'}},
              y:{min:0,max:100,ticks:{color:'#4a6080',font:{family:'Space Mono',size:9},callback:v=>v+'%'},grid:{color:'rgba(255,255,255,.025)'}}}}
  });
}

// ═══════════════════════════════════════════════════════════════
//  THREAT BREAKDOWN
// ═══════════════════════════════════════════════════════════════
function renderThrBreak(threats) {
  const el=document.getElementById('thrList'); if(!el) return;
  if(!threats?.length){el.innerHTML='<div class="empty">No threat classes detected</div>';return;}
  el.innerHTML=threats.map(t=>{const p=(t.score*100).toFixed(1);return`<div class="thr-row"><div class="thr-hd"><span class="thr-n">${t.label}</span><span class="thr-p">${p}%</span></div><div class="thr-bg"><div class="thr-fill" style="width:${p}%"></div></div></div>`}).join('');
}

// ═══════════════════════════════════════════════════════════════
//  TIMELINE
// ═══════════════════════════════════════════════════════════════
function renderTimeline(frames) {
  const el=document.getElementById('tlList'); if(!el) return;
  el.innerHTML=frames.map(f=>{const t=f.is_threat||THREATS.some(x=>f.label.includes(x));return`<div class="tl-row${t?' thr':''}"><div class="tl-d${t?' thr':''}"></div><span class="tl-t">${f.start}–${f.end}s</span><span class="tl-l${t?' thr':''}">${f.label}</span><span class="tl-c">${(f.confidence*100).toFixed(0)}%</span></div>`;}).join('');
}

// ═══════════════════════════════════════════════════════════════
//  CLASSES LIST
// ═══════════════════════════════════════════════════════════════
function renderClasses(sounds, id, max) {
  const el=document.getElementById(id); if(!el) return;
  if(!sounds?.length){el.innerHTML='<div class="empty">No data</div>';return;}
  const list=max?sounds.slice(0,max):sounds;
  el.innerHTML=list.map(s=>{const p=(s.score*100).toFixed(1);const t=THREATS.some(x=>s.label.includes(x));return`<div class="cls-row${t?' thr':''}"><span class="cls-n">${s.label}</span><div class="cls-bg"><div class="cls-fill" style="width:${Math.min(parseFloat(p)*3,100)}%"></div></div><span class="cls-p">${p}%</span></div>`;}).join('');
}

// ═══════════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════════
function fmtBytes(n) {
  if(n<1024) return n+'B'; if(n<1048576) return (n/1024).toFixed(1)+'KB';
  return (n/1048576).toFixed(1)+'MB';
}
