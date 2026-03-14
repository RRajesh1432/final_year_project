'use strict';
// PFT-AST v4.5 — Unified Frontend
// Features: history modal, continuous live recording, device+location notifications

const API     = window.BACKEND_URL || '';
const THREATS = ['gunshot','explosion','glass','scream','siren'];
const TAU     = 0.35;
const COLORS  = { blue:'#4361EE',green:'#059669',red:'#DC2626',amber:'#D97706',sky:'#0284C7',violet:'#7C3AED' };

let _chart=null, _socket=null, _swReg=null;
let _mediaRec=null, _chunks=[], _blob=null;
let _timerInt=null, _recSecs=0;
let _actx=null, _analyser=null, _raf=null;
let _feedCt=0, _alertCt=0, _subbed=false, _deferPWA=null;
let _modelReady=false, _modelPollInt=null;

// Device & location
let _deviceId   = null;
let _userLocation = null;  // { lat, lng, address }
let _liveChunkN = 0;       // chunk counter for continuous recording
let _liveActive = false;   // is continuous recording running
let _liveStream = null;    // MediaStream reference for continuous

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════
function initPage() {
  setActiveNav();
  connectSocket();
  registerSW();
  fetchStats();
  checkModelStatus();
  initDeviceInfo();
  requestNotifPermission();
  const P = window.PAGE;
  if (P==='dashboard') initDash();
  if (P==='analyze')   initAnalyze();
  if (P==='history')   initHistory();
  if (P==='alerts')    initAlerts();
}

// ═══════════════════════════════════════
//  DEVICE ID & LOCATION
// ═══════════════════════════════════════
function initDeviceInfo() {
  // Device ID: persistent UUID stored in localStorage
  _deviceId = localStorage.getItem('pft_device_id');
  if (!_deviceId) {
    _deviceId = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
    localStorage.setItem('pft_device_id', _deviceId);
  }
  // Try to get location (won't block UI — just enriches notifications)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        _userLocation = {
          lat: pos.coords.latitude.toFixed(5),
          lng: pos.coords.longitude.toFixed(5),
          accuracy: Math.round(pos.coords.accuracy)
        };
        console.log('[location] Acquired:', _userLocation);
      },
      err => { console.log('[location] Unavailable:', err.message); },
      { timeout: 8000, maximumAge: 300000 }
    );
  }
}

function getLocationString() {
  if (!_userLocation) return '';
  return `${_userLocation.lat},${_userLocation.lng}`;
}

// ═══════════════════════════════════════
//  BROWSER NOTIFICATIONS
// ═══════════════════════════════════════
async function requestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    // Delay asking so user has seen the page first
    setTimeout(() => Notification.requestPermission(), 3000);
  }
}

function showBrowserNotif(data) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const top   = data.multi_threat?.[0]?.label || data.top_class || 'Unknown';
  const pct   = (data.threat_score * 100).toFixed(1);
  const loc   = _userLocation ? `📍 ${_userLocation.lat}, ${_userLocation.lng}` : '📍 Location unavailable';
  const did   = _deviceId ? `🖥 ${_deviceId.slice(0,12)}` : '';
  const chunk = data.chunk_n ? ` · Chunk #${data.chunk_n}` : '';

  const n = new Notification(`⚠ THREAT DETECTED — ${top.toUpperCase()}`, {
    body: `Score: ${pct}%  ·  ${data.source || 'upload'}\n${loc}\n${did}${chunk}`,
    icon: '/icons/icon-192.png',
    badge:'/icons/badge-72.png',
    tag:  'pft-threat',
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 400],
  });
  n.onclick = () => { window.focus(); n.close(); };
  // Auto-close after 15s
  setTimeout(() => n.close(), 15000);
}

// ═══════════════════════════════════════
//  MODEL STATUS POLLING
// ═══════════════════════════════════════
async function checkModelStatus() {
  if (!API) return;
  try {
    const s = await apiFetch('/api/status');
    if (s.ready) { _modelReady = true; return; }
    if (s.error) { showModelBanner('error', s.error); return; }
    showModelBanner('loading');
    document.querySelectorAll('.btn-primary,.btn-analyze-r').forEach(b => b.disabled = true);
    _modelPollInt = setInterval(async () => {
      try {
        const st = await apiFetch('/api/status');
        if (st.ready) {
          _modelReady = true;
          clearInterval(_modelPollInt); _modelPollInt = null;
          showModelBanner('ready');
          setTimeout(() => document.getElementById('modelBanner')?.remove(), 5000);
          document.querySelectorAll('.btn-primary,.btn-analyze-r').forEach(b => b.disabled = false);
        } else if (st.error) {
          clearInterval(_modelPollInt); _modelPollInt = null;
          showModelBanner('error', st.error);
        }
      } catch(_) {}
    }, 8000);
  } catch(_) { _modelReady = true; }
}

function showModelBanner(state, detail) {
  let el = document.getElementById('modelBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'modelBanner';
    el.style.cssText = 'display:flex;align-items:center;gap:12px;padding:13px 18px;border-radius:10px;margin-bottom:16px;font-size:12px;font-weight:600;border:1.5px solid;';
    const main = document.querySelector('.main');
    if (main) main.insertBefore(el, main.firstChild);
  }
  const cfg = {
    loading:{ bg:'#EEF2FF',border:'#C7D2FE',color:'#4361EE',icon:'⏳',
      title:'AI Model Loading…', msg:'Downloading AST model (~1-2 min). History &amp; stats work now.' },
    ready:  { bg:'#D1FAE5',border:'#A7F3D0',color:'#059669',icon:'✅',
      title:'Model Ready', msg:'PFT-AST is ready — you can now analyze audio.' },
    error:  { bg:'#FEE2E2',border:'#FECACA',color:'#DC2626',icon:'❌',
      title:'Model Failed', msg: detail || 'Check HuggingFace Space logs.' },
  };
  const s = cfg[state] || cfg.error;
  el.style.background = s.bg; el.style.borderColor = s.border; el.style.color = s.color;
  el.innerHTML = `<span style="font-size:20px">${s.icon}</span>
    <div><div style="font-size:13px;font-weight:700;margin-bottom:2px">${s.title}</div>
    <div style="font-size:10px;font-weight:500;color:#64748B">${s.msg}</div></div>`;
}

// ═══════════════════════════════════════
//  NAV
// ═══════════════════════════════════════
function setActiveNav() {
  const P = window.PAGE;
  document.querySelectorAll('.nav-a').forEach(a => a.classList.toggle('on', a.dataset.p===P));
  document.querySelectorAll('.bn').forEach(a    => a.classList.toggle('on', a.dataset.p===P));
}
function openNav()  { document.getElementById('sidebar').classList.add('open'); document.getElementById('overlay').classList.add('on'); }
function closeNav() { document.getElementById('sidebar')?.classList.remove('open'); document.getElementById('overlay')?.classList.remove('on'); }

// ═══════════════════════════════════════
//  SERVICE WORKER + PWA
// ═══════════════════════════════════════
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(r => { _swReg=r; checkSub(); }).catch(()=>{});
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); _deferPWA = e;
    const b = document.getElementById('btnInstall'), s = document.getElementById('installSt');
    if (b) b.style.display='block';
    if (s) s.textContent = 'App can be installed — tap button above';
  });
}
function doInstall() {
  if (!_deferPWA) return;
  _deferPWA.prompt();
  _deferPWA.userChoice.then(r => {
    if (r.outcome==='accepted') {
      const s=document.getElementById('installSt');
      if(s) s.textContent='✓ Installed!';
      document.getElementById('btnInstall').style.display='none';
    }
    _deferPWA=null;
  });
}

// ═══════════════════════════════════════
//  PUSH NOTIFICATIONS
// ═══════════════════════════════════════
async function checkSub() {
  if (!_swReg) return;
  const s = await _swReg.pushManager.getSubscription().catch(()=>null);
  _subbed = !!s; updateSubUI();
}
async function togglePush() { _subbed ? await unsub() : await doSub(); }

async function doSub() {
  try {
    const { key } = await apiFetch('/api/vapid-key');
    if (!key) { alert('Push not configured on server.'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notification permission denied.'); return; }
    const sub = await _swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(key),
    });
    await apiPost('/api/subscribe', sub.toJSON());
    _subbed = true; updateSubUI();
  } catch(e) { alert('Push setup failed: '+e.message); }
}

async function unsub() {
  const sub = await _swReg.pushManager.getSubscription().catch(()=>null);
  if (sub) { await sub.unsubscribe(); await apiPost('/api/unsubscribe', {endpoint:sub.endpoint}); }
  _subbed = false; updateSubUI();
}

function updateSubUI() {
  const btn=document.getElementById('pushBtn'), st=document.getElementById('pushSt');
  if (btn) { btn.textContent = _subbed ? '🔕 Disable Push Notifications' : '🔔 Enable Push Notifications'; btn.className = 'push-btn'+(_subbed?' active':''); }
  if (st)  { st.textContent = _subbed ? '✓ Push enabled — you will receive threat alerts on this device' : 'Not subscribed — tap above to enable'; st.className = 'push-st'+(_subbed?' on':''); }
}

function urlB64ToUint8Array(b) {
  const p = '='.repeat((4-b.length%4)%4), raw = atob((b+p).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

// ═══════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════
function connectSocket() {
  _socket = io(API, { transports:['websocket','polling'], reconnectionDelay:2000 });
  _socket.on('connect',    () => setConn(true));
  _socket.on('disconnect', () => setConn(false));
  _socket.on('reconnect',  () => setConn(true));
  _socket.on('stats_update', s => updateStats(s));
  _socket.on('model_status', s => {
    if (s.ready && !_modelReady) {
      _modelReady = true;
      if (_modelPollInt) { clearInterval(_modelPollInt); _modelPollInt = null; }
      showModelBanner('ready');
      setTimeout(() => document.getElementById('modelBanner')?.remove(), 5000);
      document.querySelectorAll('.btn-primary,.btn-analyze-r').forEach(b => b.disabled = false);
    }
  });
  _socket.on('analysis_result', data => {
    updateStats(data.stats);
    if (data.threat_detected) {
      bumpAlerts();
      showBanner(data);
      showBrowserNotif(data);   // Browser popup notification
      setChip(true);
    } else setChip(false);
    if (window.PAGE==='dashboard') { renderDash(data); addFeed(data); }
    if (window.PAGE==='alerts'&&data.threat_detected) prependLive(data);
    if (window.PAGE==='history') fetchHistory();
    if (window.PAGE==='analyze') showResult(data);
  });
}
function setConn(on) {
  const el=document.getElementById('connPill'),
        ld=document.getElementById('livePill'),
        ll=document.getElementById('liveLabel');
  if(el) el.className='conn-pill '+(on?'online':'offline');
  if(ld) ld.className='sys-status '+(on?'online':'offline');
  if(ll) ll.textContent=on?'System Online':'Reconnecting...';
}

// ═══════════════════════════════════════
//  API HELPERS
// ═══════════════════════════════════════
async function apiFetch(path) { return (await fetch(API+path)).json(); }
async function apiPost(path,body) {
  return (await fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
}
async function apiPredict(fd) {
  // Attach device info to every prediction
  fd.append('device_id', _deviceId || 'unknown');
  fd.append('location', getLocationString());
  return (await fetch(API+'/api/predict',{method:'POST',body:fd})).json();
}

// ═══════════════════════════════════════
//  STATS
// ═══════════════════════════════════════
async function fetchStats() { try { updateStats(await apiFetch('/api/stats')); } catch(_){} }
function updateStats(s) {
  set('sTotal', s.total??0); set('sThreat', s.threats??0);
  set('sAvg', s.avg_score!=null?(s.avg_score*100).toFixed(1)+'%':'—');
  set('sRate', (s.threat_rate??0)+'%');
}

// ═══════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════
function set(id,v) { const e=document.getElementById(id); if(e) e.textContent=v; }
function setChip(danger) {
  const el=document.getElementById('statusChip');
  if(!el) return;
  el.className='status-chip '+(danger?'danger':'safe');
  el.querySelector('.status-txt').textContent=danger?'THREAT':'SAFE';
}
function showBanner(data) {
  const bar=document.getElementById('alertBanner'),det=document.getElementById('bannerDetail');
  if(!bar) return;
  const top=data.multi_threat?.[0]?.label||'Unknown';
  const loc = _userLocation ? ` · 📍${_userLocation.lat},${_userLocation.lng}` : '';
  const did = _deviceId ? ` · 🖥 ${_deviceId.slice(0,10)}` : '';
  if(det) det.textContent=`${top.toUpperCase()} · Score ${(data.threat_score*100).toFixed(1)}% · ${data.source}${did}${loc}`;
  bar.classList.add('show');
  setTimeout(()=>bar.classList.remove('show'),10000);
}
function closeBanner() { document.getElementById('alertBanner')?.classList.remove('show'); }
function bumpAlerts() {
  _alertCt++;
  const bc=document.getElementById('bellCount'), bb=document.getElementById('bellBtn');
  const bnd=document.getElementById('bnAlertDot'), nb=document.getElementById('navBadge');
  if(bc) { bc.textContent=_alertCt; bc.classList.add('show'); }
  if(bb) bb.classList.add('has-alerts');
  if(bnd) { bnd.textContent=_alertCt; bnd.classList.add('show'); }
  if(nb)  { nb.textContent=_alertCt; nb.classList.add('show'); }
}
function showLoader(msg) {
  const el=document.getElementById('loader'); if(el) el.classList.add('on');
  const m=document.getElementById('loaderMsg'); if(m&&msg) m.textContent=msg;
}
function hideLoader() { document.getElementById('loader')?.classList.remove('on'); }

// ═══════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════
function initDash() {}
function renderDash(data) {
  drawGauge(data.threat_score, data.risk);
  renderImg('specImg','specEmpty', data.spectrogram);
  renderImg('waveImg','waveEmpty', data.waveform_img);
  drawProbChart(data.frames);
  renderClasses(data.all_sounds, 'clsList', 20);
  renderThrDetail(data.threat_detail);
  renderFrames(data.frames);
  renderMeta(data);
}
function addFeed(data) {
  _feedCt++;
  const list=document.getElementById('feedList'); if(!list) return;
  list.querySelector('.empty')?.remove();
  const top=data.all_sounds?.[0]?.label||'—', t=data.threat_detected, src=data.source||'upload';
  const el=document.createElement('div');
  el.className=`feed-row${t?' thr':''}`;
  el.innerHTML=`
    <div class="fd ${t?'thr':'safe'}"></div>
    <div class="fi">
      <div class="fc">${top}</div>
      <div class="fm">${t?'⚠ THREAT · ':''}${new Date().toLocaleTimeString()} · #${data.id}</div>
    </div>
    <div class="fs-n ${t?'thr':'safe'}">${(data.threat_score*100).toFixed(1)}%</div>
    <span class="f-src ${src}">${src}</span>`;
  list.insertBefore(el, list.firstChild);
  while(list.children.length>25) list.removeChild(list.lastChild);
  set('feedCount', _feedCt+' event'+(_feedCt===1?'':'s'));
}

// ═══════════════════════════════════════
//  ANALYZE — UPLOAD
// ═══════════════════════════════════════
function initAnalyze() {
  const dz=document.getElementById('dropzone'), inp=document.getElementById('audioIn');
  if(!dz||!inp) return;
  dz.addEventListener('dragover', e=>{e.preventDefault();dz.classList.add('over');});
  dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
  dz.addEventListener('drop', e=>{e.preventDefault();dz.classList.remove('over');if(e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);});
  dz.addEventListener('click', e=>{if(e.target.tagName!=='BUTTON') inp.click();});
  inp.addEventListener('change',()=>{if(inp.files[0]) setFile(inp.files[0]);});
}
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('on',p.id==='pane-'+tab));
}
function setFile(f) {
  const dt=new DataTransfer(); dt.items.add(f);
  document.getElementById('audioIn').files=dt.files;
  document.getElementById('dropzone').style.display='none';
  document.getElementById('fileChip').classList.add('show');
  set('fcName',f.name); set('fcSize',fmtBytes(f.size));
}
function clearFile() {
  document.getElementById('audioIn').value='';
  document.getElementById('dropzone').style.display='';
  document.getElementById('fileChip').classList.remove('show');
}
async function analyzeUpload() {
  const inp=document.getElementById('audioIn');
  if(!inp?.files[0]) { alert('Select an audio file first.'); return; }
  showLoader('Analyzing with PFT-AST...');
  const fd=new FormData(); fd.append('audio',inp.files[0]); fd.append('source','upload');
  try {
    const data=await apiPredict(fd);
    if(data.error){alert(data.error);return;}
    showResult(data);
  } catch(e){alert('Error: '+e.message);}
  finally{hideLoader();}
}

// ═══════════════════════════════════════
//  ANALYZE — SHOW RESULT
// ═══════════════════════════════════════
function showResult(data) {
  const card=document.getElementById('resultCard');
  if(!card) return;
  card.style.display='block';
  set('resPct', (data.threat_score*100).toFixed(1)+'%');
  const rt=document.getElementById('resRisk');
  if(rt) { const r=data.risk||'SAFE'; rt.textContent=r; rt.className='rtag r-'+r.toLowerCase(); }
  drawMiniGauge('resGauge', data.threat_score);
  renderImg2('resSpec', data.spectrogram);
  renderImg2('resWave', data.waveform_img);
  renderClasses(data.all_sounds,'resClasses',10);
  renderThrDetail2(data.threat_detail);
  renderFrames2(data.frames);
  renderMeta2(data);
  card.scrollIntoView({behavior:'smooth'});
  if(data.threat_detected) showBanner(data);
}

// ═══════════════════════════════════════
//  RECORDING — SINGLE SHOT
// ═══════════════════════════════════════
function getMime() {
  return ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4','audio/webm']
    .find(t=>MediaRecorder.isTypeSupported(t))||'';
}
async function toggleRec() {
  if (_liveActive) return stopLiveRec();
  (_mediaRec?.state==='recording') ? stopRec() : await startRec();
}
async function startRec() {
  _chunks=[]; _blob=null;
  try {
    const stream=await navigator.mediaDevices.getUserMedia({audio:{sampleRate:16000,channelCount:1,echoCancellation:true}});
    _actx=new AudioContext();
    _analyser=_actx.createAnalyser(); _analyser.fftSize=512;
    _actx.createMediaStreamSource(stream).connect(_analyser);
    drawWave();
    _mediaRec=new MediaRecorder(stream,{mimeType:getMime()});
    _mediaRec.ondataavailable=e=>{if(e.data.size>0)_chunks.push(e.data);};
    _mediaRec.onstop=()=>{
      _blob=new Blob(_chunks,{type:getMime()||'audio/webm'});
      stopWave();
      const b=document.getElementById('btnAnalyzeRec'); if(b) b.disabled=false;
      setRecLbl('Ready · '+_recSecs+'s recorded');
    };
    _mediaRec.start(100);
    _recSecs=0;
    _timerInt=setInterval(()=>{
      _recSecs++;
      const el=document.getElementById('recTimer');
      if(el){el.textContent=`${pad(_recSecs/60|0)}:${pad(_recSecs%60)}`;el.classList.add('on');}
      if(_recSecs>=60) stopRec();
    },1000);
    document.getElementById('btnRec')?.classList.add('on');
    set('recBtnLbl','Stop'); setRecLbl('● RECORDING');
  } catch(e){alert('Mic access denied: '+e.message);}
}
function stopRec() {
  if(_mediaRec?.state==='recording'){_mediaRec.stop();_mediaRec.stream.getTracks().forEach(t=>t.stop());}
  clearInterval(_timerInt);
  document.getElementById('btnRec')?.classList.remove('on');
  set('recBtnLbl','Record');
  document.getElementById('recTimer')?.classList.remove('on');
}
async function analyzeRec() {
  if(!_blob) return;
  showLoader('Analyzing recording...');
  const ext=_blob.type.includes('ogg')?'ogg':'webm';
  const fd=new FormData(); fd.append('audio',new File([_blob],`rec.${ext}`,{type:_blob.type})); fd.append('source','record');
  try {
    const data=await apiPredict(fd);
    if(data.error){alert(data.error);return;}
    showResult(data);
  } catch(e){alert('Error: '+e.message);}
  finally{hideLoader();}
}

// ═══════════════════════════════════════
//  RECORDING — CONTINUOUS 10s CHUNKS
// ═══════════════════════════════════════
async function startLiveRec() {
  try {
    _liveStream = await navigator.mediaDevices.getUserMedia({audio:{sampleRate:16000,channelCount:1,echoCancellation:true}});
  } catch(e) { alert('Mic access denied: '+e.message); return; }

  // Set up waveform viz
  _actx=new AudioContext();
  _analyser=_actx.createAnalyser(); _analyser.fftSize=512;
  _actx.createMediaStreamSource(_liveStream).connect(_analyser);
  drawWave();

  _liveActive = true;
  _liveChunkN = 0;
  _recSecs    = 0;

  document.getElementById('btnLiveRec')?.classList.add('on');
  document.getElementById('btnLiveRec').textContent = '⏹ Stop Live';
  document.getElementById('liveStatusBadge').style.display = 'flex';
  set('liveChunkLabel','Starting...');

  // Clear previous live results
  const feed = document.getElementById('liveChunkFeed');
  if (feed) feed.innerHTML = '';

  // Global timer
  _timerInt = setInterval(() => {
    _recSecs++;
    const el = document.getElementById('recTimer');
    if (el) { el.textContent=`${pad(_recSecs/60|0)}:${pad(_recSecs%60)}`; el.classList.add('on'); }
  }, 1000);

  // Start first chunk immediately
  startNextChunk();
}

function startNextChunk() {
  if (!_liveActive) return;
  _liveChunkN++;
  const chunkN = _liveChunkN;
  const chunks = [];
  const mime   = getMime();

  set('liveChunkLabel', `● Analyzing chunk #${chunkN}...`);

  const rec = new MediaRecorder(_liveStream, {mimeType: mime});
  rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  rec.onstop = async () => {
    if (!_liveActive && chunkN > 1) return; // discard if stopped before first chunk
    const blob = new Blob(chunks, {type: mime || 'audio/webm'});
    if (blob.size < 1000) { if (_liveActive) startNextChunk(); return; } // too small, skip
    addLiveChunkPending(chunkN);
    try {
      const ext = mime.includes('ogg') ? 'ogg' : 'webm';
      const fd  = new FormData();
      fd.append('audio', new File([blob], `live_chunk_${chunkN}.${ext}`, {type: mime}));
      fd.append('source', 'live');
      const data = await apiPredict(fd);
      if (data.error) { updateLiveChunk(chunkN, null, data.error); }
      else {
        data.chunk_n = chunkN;
        updateLiveChunk(chunkN, data);
        // Also update the main result panel with latest chunk
        showResult(data);
        if (data.threat_detected) { showBrowserNotif(data); }
      }
    } catch(e) { updateLiveChunk(chunkN, null, e.message); }
    // Start next chunk only AFTER this one's recording stops
    if (_liveActive) startNextChunk();
  };

  rec.start();
  // Stop this chunk after 10 seconds
  setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, 10000);
}

function stopLiveRec() {
  _liveActive = false;
  if (_liveStream) { _liveStream.getTracks().forEach(t => t.stop()); _liveStream = null; }
  clearInterval(_timerInt);
  stopWave();
  document.getElementById('btnLiveRec')?.classList.remove('on');
  if (document.getElementById('btnLiveRec')) document.getElementById('btnLiveRec').textContent = '🔴 Start Live Analysis';
  document.getElementById('liveStatusBadge').style.display = 'none';
  document.getElementById('recTimer')?.classList.remove('on');
  set('liveChunkLabel', `Done — ${_liveChunkN} chunk${_liveChunkN===1?'':'s'} analyzed`);
}

function addLiveChunkPending(n) {
  const feed = document.getElementById('liveChunkFeed'); if(!feed) return;
  const el = document.createElement('div');
  el.className = 'live-chunk-row pending';
  el.id = `lc-${n}`;
  el.innerHTML = `<div class="lc-n">#${n}</div><div class="lc-info"><div class="lc-label">Analyzing…</div><div class="lc-bar-bg"><div class="lc-bar" style="width:0%"></div></div></div><div class="lc-score">—</div>`;
  feed.insertBefore(el, feed.firstChild);
  // keep max 20 in feed
  while (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

function updateLiveChunk(n, data, err) {
  const el = document.getElementById(`lc-${n}`); if (!el) return;
  if (err || !data) {
    el.className = 'live-chunk-row error';
    el.querySelector('.lc-label').textContent = err || 'Error';
    el.querySelector('.lc-score').textContent = '✗';
    return;
  }
  const pct   = (data.threat_score * 100).toFixed(1);
  const risk  = data.risk || 'SAFE';
  const top   = data.all_sounds?.[0]?.label || '—';
  const cls   = data.threat_detected ? 'threat' : (data.threat_score >= 0.2 ? 'medium' : 'safe');
  el.className = `live-chunk-row ${cls}`;
  el.querySelector('.lc-label').textContent = top;
  el.querySelector('.lc-bar').style.width   = Math.min(data.threat_score * 100, 100) + '%';
  el.querySelector('.lc-bar').className     = `lc-bar ${cls}`;
  el.querySelector('.lc-score').innerHTML   = `<span class="rtag r-${risk.toLowerCase()}">${pct}%</span>`;
}

// ═══════════════════════════════════════
//  RECORDING — WAVEFORM VIZ
// ═══════════════════════════════════════
function drawWave() {
  const c=document.getElementById('recC'); if(!c||!_analyser) return;
  c.width=c.offsetWidth*devicePixelRatio; c.height=76*devicePixelRatio;
  const ctx=c.getContext('2d'); ctx.scale(devicePixelRatio,devicePixelRatio);
  const W=c.offsetWidth,H=76, buf=new Uint8Array(_analyser.frequencyBinCount);
  function draw() {
    _raf=requestAnimationFrame(draw);
    _analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0,0,W,H);
    ctx.beginPath(); ctx.strokeStyle=COLORS.blue; ctx.lineWidth=1.5;
    buf.forEach((v,i)=>{const y=(v/128)*(H/2);i?ctx.lineTo(i*(W/buf.length),y):ctx.moveTo(0,y);});
    ctx.stroke();
  }
  draw();
}
function stopWave() { cancelAnimationFrame(_raf); if(_actx){_actx.close();_actx=null;} }
function setRecLbl(m){const e=document.getElementById('recVizLbl');if(e)e.textContent=m;}
function pad(n){return String(n).padStart(2,'0');}

// ═══════════════════════════════════════
//  HISTORY — TABLE + MODAL
// ═══════════════════════════════════════
async function initHistory(){ await fetchHistory(); }
async function fetchHistory() {
  try {
    const [hist,stats]=await Promise.all([apiFetch('/api/history?limit=100'),apiFetch('/api/stats')]);
    updateStats(stats); renderHistStats(stats); renderHistTable(hist);
  } catch(e){console.error(e);}
}
function renderHistStats(s) {
  const el=document.getElementById('histStats'); if(!el) return;
  el.innerHTML=`
    <div class="stat"><div class="stat-stripe blue"></div><div class="stat-ic si-blue"><svg width="19" height="19" viewBox="0 0 19 19" fill="none" stroke="${COLORS.blue}" stroke-width="1.7"><rect x="2" y="2" width="15" height="15" rx="2"/><line x1="2" y1="7" x2="17" y2="7"/></svg></div><div><div class="stat-n" id="sTotal">${s.total}</div><div class="stat-l">Total Analyses</div></div></div>
    <div class="stat"><div class="stat-stripe red"></div><div class="stat-ic si-red"><svg width="19" height="19" viewBox="0 0 19 19" fill="none" stroke="${COLORS.red}" stroke-width="1.7"><path d="M9.5 2L2 17h15L9.5 2z"/><line x1="9.5" y1="9" x2="9.5" y2="13"/></svg></div><div><div class="stat-n" id="sThreat">${s.threats}</div><div class="stat-l">Threats</div></div></div>
    <div class="stat"><div class="stat-stripe green"></div><div class="stat-ic si-green"><svg width="19" height="19" viewBox="0 0 19 19" fill="none" stroke="${COLORS.green}" stroke-width="1.7"><path d="M9.5 1L2 5v5.5c0 4 3.5 7 7.5 7s7.5-3 7.5-7V5L9.5 1z"/></svg></div><div><div class="stat-n">${s.safe}</div><div class="stat-l">Safe</div></div></div>
    <div class="stat"><div class="stat-stripe amber"></div><div class="stat-ic si-amber"><svg width="19" height="19" viewBox="0 0 19 19" fill="none" stroke="${COLORS.amber}" stroke-width="1.7"><circle cx="9.5" cy="9.5" r="7"/><line x1="9.5" y1="6" x2="9.5" y2="9.5"/><line x1="9.5" y1="9.5" x2="12" y2="11.5"/></svg></div><div><div class="stat-n">${s.threat_rate}%</div><div class="stat-l">Threat Rate</div></div></div>`;
}
function renderHistTable(rows) {
  const el=document.getElementById('histTable'); if(!el) return;
  if(!rows.length){el.innerHTML='<div class="empty" style="padding:32px">No analyses yet.</div>';return;}
  const rTag=r=>`<span class="rtag r-${r.toLowerCase()}">${r}</span>`;
  const srcTag=s=>`<span class="s-tag s-${s}">${s}</span>`;
  el.innerHTML=`
    <div class="h-hd"><div>#</div><div>Top Class</div><div>Score</div><div>Risk</div><div>Source</div><div>Timestamp</div><div>Action</div></div>
    ${rows.map(r=>`
    <div class="h-row${r.threat?' thr':''}" style="cursor:pointer" onclick="openHistoryModal(${r.id})">
      <div class="h-id">${r.id}</div>
      <div class="h-cls">${r.top_class||'—'}</div>
      <div class="h-sc">${(r.score*100).toFixed(1)}%</div>
      <div>${rTag(r.risk)}</div>
      <div>${srcTag(r.source||'upload')}</div>
      <div class="h-time">${r.date||''} ${r.time||''}</div>
      <div><button class="h-view-btn" onclick="event.stopPropagation();openHistoryModal(${r.id})">View Full ↗</button></div>
    </div>`).join('')}`;
}

// ── History Modal ─────────────────────────────────────────
async function openHistoryModal(id) {
  const modal = document.getElementById('histModal');
  const body  = document.getElementById('histModalBody');
  if (!modal || !body) return;

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  body.innerHTML = `<div style="text-align:center;padding:60px 20px">
    <div class="sonar" style="margin:0 auto 16px"><div class="s-ring"></div><div class="s-ring"></div><div class="s-core"></div></div>
    <div style="color:var(--t3);font-size:12px">Loading full analysis #${id}…</div>
  </div>`;

  try {
    const data = await apiFetch(`/api/history/${id}`);
    if (data.error) { body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--red)">Error: ${data.error}</div>`; return; }
    renderHistModalContent(data, id);
  } catch(e) {
    body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--red)">Failed to load: ${e.message}</div>`;
  }
}

function closeHistoryModal() {
  document.getElementById('histModal')?.classList.remove('open');
  document.body.style.overflow = '';
}

function renderHistModalContent(data, id) {
  const body = document.getElementById('histModalBody');
  const risk  = data.risk || 'SAFE';
  const pct   = (data.threat_score * 100).toFixed(1);
  const isT   = data.threat_detected;
  const loc   = data.location ? `📍 ${data.location}` : '📍 Location not recorded';
  const did   = data.device_id || 'unknown';
  const noData = data.no_full_data;

  body.innerHTML = `
    <!-- Header strip -->
    <div class="hm-header ${isT?'threat':'safe'}">
      <div class="hm-hinfo">
        <div class="hm-risk-badge r-${risk.toLowerCase()}">${isT?'⚠ ':'✓ '}${risk}</div>
        <div class="hm-title">Analysis #${id}</div>
        <div class="hm-meta">${data.date||''} ${data.time||''} · ${data.source||'upload'} · ${data.duration||'—'}s</div>
      </div>
      <div class="hm-score-big">${pct}%</div>
    </div>

    <!-- Device info banner -->
    <div class="hm-device-row">
      <span>🖥 <b>Device:</b> ${did}</span>
      <span>${loc}</span>
      <span>⏱ ${data.date||''} ${data.time||''}</span>
    </div>

    ${noData ? `
    <div style="padding:24px;text-align:center;background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;margin:16px 0;font-size:12px;color:#92400E">
      ⚠ This record was created before full-result storage was added. Detailed analysis panels are not available for this record.
      Only records created after the v4.5 update will show full analysis.
    </div>
    ` : `
    <!-- Gauge + Top classes row -->
    <div class="hm-grid2" style="margin-top:16px">
      <div class="hm-card">
        <div class="hm-card-title">THREAT SCORE</div>
        <div style="display:flex;align-items:center;gap:20px;padding:16px">
          <canvas id="hmGauge" width="110" height="110"></canvas>
          <div>
            <div style="font-size:42px;font-weight:800;line-height:1;color:${isT?'#DC2626':risk==='MEDIUM'?'#D97706':'#059669'}">${pct}%</div>
            <div style="font-size:10px;color:var(--t4);margin-top:6px;font-weight:600">THRESHOLD τ = ${(data.threshold||0.35).toFixed(2)}</div>
            <div style="font-size:10px;color:var(--t3);margin-top:4px">${data.num_threat_vocab||137} threat vocab keywords</div>
          </div>
        </div>
      </div>
      <div class="hm-card">
        <div class="hm-card-title">TOP 10 AUDIO CLASSES</div>
        <div id="hmClasses" style="padding:12px 16px"></div>
      </div>
    </div>

    <!-- Spectrogram + Waveform -->
    ${(data.spectrogram||data.waveform_img) ? `
    <div class="hm-grid2" style="margin-top:14px">
      ${data.spectrogram ? `<div class="hm-card"><div class="hm-card-title">LOG-MEL SPECTROGRAM</div><div class="img-wrap"><img src="data:image/png;base64,${data.spectrogram}" style="width:100%;border-radius:6px"></div></div>` : ''}
      ${data.waveform_img ? `<div class="hm-card"><div class="hm-card-title">WAVEFORM</div><div class="img-wrap"><img src="data:image/png;base64,${data.waveform_img}" style="width:100%;border-radius:6px"></div></div>` : ''}
    </div>` : ''}

    <!-- Threat categories -->
    ${data.threat_detail?.length ? `
    <div class="hm-card" style="margin-top:14px">
      <div class="hm-card-title">THREAT CATEGORY BREAKDOWN</div>
      <div id="hmThrDetail" style="padding:12px 16px"></div>
    </div>` : ''}

    <!-- Temporal frames -->
    ${data.frames?.length ? `
    <div class="hm-card" style="margin-top:14px">
      <div class="hm-card-title">TEMPORAL SEGMENT ANALYSIS — ${data.frames.length} FRAMES</div>
      <div id="hmFrames" class="frames-grid" style="padding:12px 16px"></div>
    </div>` : ''}
    `}
  `;

  if (!noData) {
    // Render gauge
    setTimeout(() => {
      drawMiniGaugeSize('hmGauge', data.threat_score, 110, 42);
      renderClasses(data.all_sounds, 'hmClasses', 10);
      if (data.threat_detail?.length) _renderThrDetail(data.threat_detail, 'hmThrDetail');
      if (data.frames?.length) _renderFrames(data.frames, 'hmFrames');
    }, 50);
  }
}

// ═══════════════════════════════════════
//  ALERTS
// ═══════════════════════════════════════
async function initAlerts() {
  checkSub();
  try {
    const rows=await apiFetch('/api/alerts');
    renderHistAlerts(rows);
  } catch(_){}
}
function renderHistAlerts(rows) {
  const el=document.getElementById('histAlerts'); if(!el) return;
  if(!rows.length){el.innerHTML='<div class="empty" style="padding:24px">No threats recorded yet.</div>';return;}
  el.innerHTML=rows.map(r=>`
    <div class="alert-item" onclick="openHistoryModal(${r.id})" style="cursor:pointer">
      <div class="ai-icon">⚠️</div>
      <div class="ai-body">
        <div class="ai-title">${(r.top_class||'Unknown').toUpperCase()}</div>
        <div class="ai-detail">Score: ${(r.score*100).toFixed(1)}% · Source: ${r.source||'upload'}${r.location?' · 📍'+r.location:''}</div>
        <div class="ai-time">${r.date} ${r.time}${r.device_id?' · 🖥 '+r.device_id.slice(0,12):''}</div>
      </div>
      <div class="ai-score">${(r.score*100).toFixed(0)}%</div>
    </div>`).join('');
}
function prependLive(data) {
  const el=document.getElementById('liveAlerts'); if(!el) return;
  el.querySelector('.empty')?.remove();
  const top=data.multi_threat?.[0]?.label||'Unknown';
  const item=document.createElement('div');
  item.className='alert-item';
  const loc = data.location ? ` · 📍${data.location}` : '';
  item.innerHTML=`
    <div class="ai-icon">🔴</div>
    <div class="ai-body">
      <div class="ai-title">${top.toUpperCase()} — LIVE</div>
      <div class="ai-detail">Score ${(data.threat_score*100).toFixed(1)}% · Source: ${data.source} · #${data.id}${loc}</div>
      <div class="ai-time">${new Date().toLocaleString()}</div>
    </div>
    <div class="ai-score">${(data.threat_score*100).toFixed(0)}%</div>`;
  el.insertBefore(item,el.firstChild);
  const n=el.querySelectorAll('.alert-item').length;
  set('liveAlertCt', n+' alert'+(n===1?'':'s'));
}

// ═══════════════════════════════════════
//  GAUGES
// ═══════════════════════════════════════
function drawGauge(score,risk) {
  const c=document.getElementById('gaugeC'); if(!c) return;
  const S=165,cx=S/2,cy=S/2,r=66;
  c.width=S; c.height=S;
  const ctx=c.getContext('2d');
  ctx.clearRect(0,0,S,S);
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.strokeStyle='#E2E8F0'; ctx.lineWidth=12; ctx.stroke();
  [[0,.2,'rgba(5,150,105,.08)'],[.2,TAU,'rgba(217,119,6,.08)'],[TAU,1,'rgba(220,38,38,.1)']].forEach(([a,b,cl])=>{
    ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2+a*Math.PI*2,-Math.PI/2+b*Math.PI*2);
    ctx.strokeStyle=cl; ctx.lineWidth=12; ctx.stroke();
  });
  const clr=score>=TAU?COLORS.red:score>=.2?COLORS.amber:COLORS.green;
  const g=ctx.createLinearGradient(cx-r,cy,cx+r,cy);
  if(score>=TAU){g.addColorStop(0,'#DC2626');g.addColorStop(1,'#EF4444');}
  else if(score>=.2){g.addColorStop(0,'#D97706');g.addColorStop(1,'#F59E0B');}
  else{g.addColorStop(0,'#059669');g.addColorStop(1,'#10B981');}
  ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+(score||0)*Math.PI*2);
  ctx.strokeStyle=g; ctx.lineWidth=12; ctx.lineCap='round'; ctx.stroke();
  if(score>=TAU) {
    ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+score*Math.PI*2);
    ctx.strokeStyle='rgba(220,38,38,.15)'; ctx.lineWidth=20; ctx.stroke();
  }
  const ta=-Math.PI/2+TAU*Math.PI*2;
  ctx.beginPath();
  ctx.moveTo(cx+(r-8)*Math.cos(ta),cy+(r-8)*Math.sin(ta));
  ctx.lineTo(cx+(r+7)*Math.cos(ta),cy+(r+7)*Math.sin(ta));
  ctx.strokeStyle='#64748B'; ctx.lineWidth=2; ctx.lineCap='round'; ctx.stroke();
  const pe=document.getElementById('gaugePct'),le=document.getElementById('gaugeRisk');
  if(pe){pe.textContent=score!=null?Math.round(score*100)+'%':'—';pe.style.color=clr;}
  if(le){le.textContent=risk||'—';le.className='gauge-risk '+(risk||'safe').toLowerCase();}
}
function drawMiniGauge(id,score) { drawMiniGaugeSize(id,score,82,30); }
function drawMiniGaugeSize(id,score,S,r) {
  const c=document.getElementById(id); if(!c) return;
  const cx=S/2,cy=S/2;
  c.width=S; c.height=S;
  const ctx=c.getContext('2d');
  ctx.clearRect(0,0,S,S);
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.strokeStyle='#E2E8F0'; ctx.lineWidth=S/10; ctx.stroke();
  const clr=score>=TAU?COLORS.red:score>=.2?COLORS.amber:COLORS.green;
  ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+(score||0)*Math.PI*2);
  ctx.strokeStyle=clr; ctx.lineWidth=S/10; ctx.lineCap='round'; ctx.stroke();
  ctx.fillStyle=clr; ctx.font=`bold ${Math.round(S/6.5)}px "IBM Plex Mono",monospace`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(Math.round(score*100)+'%',cx,cy);
}

// ═══════════════════════════════════════
//  CHARTS
// ═══════════════════════════════════════
function drawProbChart(frames) {
  const el=document.getElementById('probChart'); if(!el) return;
  if(_chart) _chart.destroy();
  const labels=frames.map(f=>`${f.start}s`);
  const probs=frames.map(f=>+(f.threat_score*100).toFixed(1));
  _chart=new Chart(el.getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{
      label:'Threat Score (%)', data:probs, borderRadius:5, borderSkipped:false,
      backgroundColor:probs.map(p=>p>=35?'rgba(220,38,38,.7)':p>=20?'rgba(217,119,6,.6)':'rgba(5,150,105,.6)'),
      borderColor:probs.map(p=>p>=35?COLORS.red:p>=20?COLORS.amber:COLORS.green),
      borderWidth:1.5,
    },{
      type:'line', label:'Score', data:probs, tension:.45,
      borderColor:COLORS.blue, borderWidth:2, pointRadius:5,
      pointBackgroundColor:probs.map(p=>p>=35?COLORS.red:p>=20?COLORS.amber:COLORS.green),
      fill:false,
    }]},
    options:{responsive:true,maintainAspectRatio:true,
      plugins:{
        legend:{display:false},
        tooltip:{backgroundColor:'rgba(255,255,255,.98)',borderColor:'#E2E8F0',borderWidth:1,titleColor:'#334155',bodyColor:'#4361EE',bodyFont:{family:'IBM Plex Mono',size:11},padding:10}
      },
      scales:{
        x:{ticks:{color:'#64748B',font:{family:'IBM Plex Mono',size:10}},grid:{color:'#F1F5F9'}},
        y:{min:0,max:100,ticks:{color:'#64748B',font:{family:'IBM Plex Mono',size:10},callback:v=>v+'%'},grid:{color:'#F1F5F9'}}
      }}
  });
}

// ═══════════════════════════════════════
//  CLASSES / THREAT DETAIL / FRAMES / META
// ═══════════════════════════════════════
function renderClasses(sounds,id,max) {
  const el=document.getElementById(id); if(!el) return;
  if(!sounds?.length){el.innerHTML='<div class="empty">No data</div>';return;}
  const list=max?sounds.slice(0,max):sounds;
  const maxScore=list[0]?.score||1;
  el.innerHTML=list.map((s,i)=>{
    const p=(s.score*100).toFixed(2);
    const t=THREATS.some(x=>s.label.includes(x));
    const w=Math.min((s.score/maxScore)*100,100);
    return `<div class="cls-row${t?' thr':''}">
      <span class="cls-rank">${i+1}</span>
      <span class="cls-name" title="${s.label}">${s.label}</span>
      <div class="cls-bg"><div class="cls-fill" style="width:${w}%"></div></div>
      <span class="cls-pct">${p}%</span>
    </div>`;
  }).join('');
}
function renderThrDetail(threats) { _renderThrDetail(threats,'thrList'); }
function renderThrDetail2(threats) { _renderThrDetail(threats,'resThrList'); }
function _renderThrDetail(threats,id) {
  const el=document.getElementById(id); if(!el) return;
  if(!threats?.length){el.innerHTML='<div class="empty">No threat signals detected</div>';return;}
  el.innerHTML=threats.map(t=>{
    const cls=t.pct>=35?'high':t.pct>=20?'medium':'low';
    return `<div class="thr-item">
      <div class="thr-hd"><span class="thr-name">${t.class}</span><span class="thr-pct">${t.pct}%</span></div>
      <div class="thr-bar-bg"><div class="thr-bar-fill ${cls}" style="width:${Math.min(t.pct,100)}%"></div></div>
    </div>`;
  }).join('');
}
function renderFrames(frames) { _renderFrames(frames,'framesGrid'); }
function renderFrames2(frames){ _renderFrames(frames,'resFrames'); }
function _renderFrames(frames,id) {
  const el=document.getElementById(id); if(!el||!frames?.length) return;
  el.innerHTML=frames.map(f=>{
    const pct=(f.threat_score*100).toFixed(1);
    const cls=f.threat_score>=TAU?'high':f.threat_score>=.2?'med':'safe';
    return `<div class="frame-card${f.is_threat?' thr':''}">
      <div class="frame-time">${f.start}s – ${f.end}s</div>
      <div class="frame-label${f.is_threat?' thr':''}" title="${f.label}">${f.label}</div>
      <div class="frame-conf ${cls}">${pct}%</div>
      <div class="frame-tag ${f.is_threat?'thr':'safe'}">${f.is_threat?'⚠ THREAT':'✓ Safe'}</div>
    </div>`;
  }).join('');
}
function renderMeta(data) { _renderMeta(data,'metaGrid'); }
function renderMeta2(data){ _renderMeta(data,'resMeta'); }
function _renderMeta(data,id) {
  const el=document.getElementById(id); if(!el) return;
  el.innerHTML=`
    <div class="meta-item"><div class="meta-val2">${data.duration??'—'}s</div><div class="meta-lbl2">Duration</div></div>
    <div class="meta-item"><div class="meta-val2">${data.sample_rate??16000}</div><div class="meta-lbl2">Sample Rate</div></div>
    <div class="meta-item"><div class="meta-val2">${data.num_classes??527}</div><div class="meta-lbl2">Classes</div></div>
    <div class="meta-item"><div class="meta-val2">${(data.threshold||.35).toFixed(2)}</div><div class="meta-lbl2">Threshold τ</div></div>`;
}
function renderImg(imgId,emptyId,b64) {
  const img=document.getElementById(imgId), emp=document.getElementById(emptyId);
  if(!img||!b64) return;
  img.src=`data:image/png;base64,${b64}`; img.style.display='block';
  if(emp) emp.style.display='none';
}
function renderImg2(imgId,b64) {
  const img=document.getElementById(imgId); if(!img||!b64) return;
  img.src=`data:image/png;base64,${b64}`; img.style.display='block';
}

// ═══════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════
function fmtBytes(n) {
  if(n<1024) return n+'B'; if(n<1048576) return (n/1024).toFixed(1)+'KB';
  return (n/1048576).toFixed(1)+'MB';
}
