'use strict';
/* TREINO APP — frontend (PWA). Fala com o Apps Script via JSON. O cronômetro roda 100% no cliente. */

const $v = document.getElementById('view');
const $tabs = document.getElementById('tabs');
const API_URL = (window.APP_CONFIG || {}).API_URL || '';

/* ---------- utilidades ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage', e); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const pad = n => String(n).padStart(2, '0');
const mmss = s => pad(Math.floor(s / 60)) + ':' + pad(s % 60);
const hhmm = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const kg = n => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' kg');
const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseDay = k => { const p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
const photoSrc = u => {
  if (!u) return '';
  const m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || u.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w300' : u;
};
const repsLabel = r => (/^\d+$/.test(String(r)) ? r + ' repetições' : esc(r));
const repsShort = r => (/^\d+$/.test(String(r)) ? r : esc(r));

let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------- áudio (precisa de gesto do usuário) ---------- */
let actx = null;
function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { console.warn('audio', e); }
}
function beep() {
  try {
    unlockAudio();
    [0, 0.25, 0.5].forEach((delay, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = i === 2 ? 1175 : 880;
      const t0 = actx.currentTime + delay;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + 0.22);
    });
  } catch (e) { console.warn('beep', e); }
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

let alarmT = null, alarmStop = null;
function stopAlarm() {
  clearInterval(alarmT); clearTimeout(alarmStop); alarmT = null; alarmStop = null;
  if (navigator.vibrate) navigator.vibrate(0);
}
function startAlarm() {           // toca por até 15 s ou até você agir
  stopAlarm(); beep();
  alarmT = setInterval(beep, 1200);
  alarmStop = setTimeout(stopAlarm, 15000);
}

/* ---------- API + fila offline ---------- */
const token = () => LS.get('token', '');
async function apiGet(action, params) {
  const u = new URL(API_URL);
  u.searchParams.set('action', action); u.searchParams.set('token', token());
  Object.keys(params || {}).forEach(k => u.searchParams.set(k, params[k]));
  const r = await fetch(u.toString(), { redirect: 'follow' });
  return r.json();
}
async function apiPost(action, payload) {
  const r = await fetch(API_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS
    body: JSON.stringify({ action, token: token(), payload })
  });
  return r.json();
}
let flushing = false;
async function flushQueue() {
  if (flushing || !navigator.onLine || !token()) return;
  flushing = true;
  try {
    let q = LS.get('queue', []);
    while (q.length) {
      const item = q[0];
      let res;
      try { res = await apiPost(item.type === 'workout' ? 'saveWorkout' : 'saveWeight', item.payload); }
      catch (e) { console.warn('sync adiada (sem conexão)', e); break; }
      if (res.ok || res.code === 'INVALID') { q = LS.get('queue', []).slice(1); LS.set('queue', q); }
      else if (res.code === 'AUTH') { toast('Token inválido. Abra o app e informe novamente.'); break; }
      else break; // erro de servidor: tenta de novo depois
    }
    if (!q.length && LS.get('queueWasPending', false)) { LS.set('queueWasPending', false); toast('Dados sincronizados com a planilha.'); }
  } finally { flushing = false; }
}
function enqueue(type, payload) {
  const q = LS.get('queue', []); q.push({ type, payload }); LS.set('queue', q);
  LS.set('queueWasPending', true);
  flushQueue();
}
window.addEventListener('online', flushQueue);
setInterval(flushQueue, 30000);

/* ---------- estado ---------- */
let S = { data: null, tab: 'home', offline: false, historyRange: '7' };
let W = LS.get('active', null);   // treino em andamento (persistido)
let tick = null;

const doneLocal = () => LS.get('doneLocal', {});
function completedSet() {
  const s = new Set((S.data && S.data.completedIds) || []);
  ((doneLocal()[S.data.today]) || []).forEach(id => s.add(id));
  return s;
}

/* ---------- navegação ---------- */
function go(tab) {
  S.tab = tab; stopTick();
  $tabs.hidden = false;
  [...$tabs.children].forEach(b => b.classList.toggle('on', b.dataset.go === tab));
  ({ home: renderHome, history: renderHistory, weight: renderWeight })[tab]();
  window.scrollTo(0, 0);
}
$tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.go); });
function loading() { $v.innerHTML = '<div class="spin" aria-label="Carregando"></div>'; }

/* ---------- boot ---------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(e => console.warn('SW', e));
  if (!API_URL || API_URL.indexOf('COLE_AQUI') === 0) {
    $v.innerHTML = '<div class="err">Falta configurar o endereço do Web App em <b>config.js</b>.</div>'; return;
  }
  if (!token()) return renderSetup();
  loading();
  await loadHome();
  if (W && !W.finished) return openWorkout(true);
  go('home');
  flushQueue();
}
function renderSetup(msg) {
  $tabs.hidden = true;
  $v.innerHTML = `<h1>Bem-vinda 👋</h1><p class="mute">Informe o token gerado na planilha (menu Treino App &gt; Mostrar token da API). Isso é feito uma única vez neste aparelho.</p>
  ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
  <input id="tk" class="field" placeholder="Token" autocomplete="off" autocapitalize="off">
  <div style="height:12px"></div><button class="btn" id="tkok">Entrar</button>`;
  document.getElementById('tkok').onclick = async () => {
    const v = document.getElementById('tk').value.trim();
    if (!v) return;
    LS.set('token', v); loading();
    const ok = await loadHome();
    if (ok === 'AUTH') { LS.del('token'); renderSetup('Token inválido. Confira e tente de novo.'); }
    else go('home');
  };
}

async function loadHome() {
  try {
    const r = await apiGet('bootstrap');
    if (!r.ok) {
      if (r.code === 'AUTH') return 'AUTH';
      throw new Error(r.message || 'erro');
    }
    S.data = r.data; S.offline = false; LS.set('cache', r.data);
    return 'OK';
  } catch (e) {
    console.warn('bootstrap falhou, usando cache', e);
    const c = LS.get('cache', null);
    if (c && c.today === dayKey(new Date())) { S.data = c; S.offline = true; return 'OFFLINE'; }
    S.data = null; return 'FAIL';
  }
}

/* ---------- HOME ---------- */
function renderHome() {
  const d = S.data;
  if (!d) {
    $v.innerHTML = `<div class="err">Não foi possível carregar os treinos. Verifique sua conexão.</div><button class="btn" id="retry">Tentar de novo</button>`;
    document.getElementById('retry').onclick = async () => { loading(); await loadHome(); renderHome(); };
    return;
  }
  const done = completedSet();
  const list = d.workouts;
  const total = list.length, nDone = list.filter(w => done.has(w.id)).length;
  const today = parseDay(d.today);
  const label = today.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
  const first = (d.user.name || 'Atleta').split(' ')[0];
  const nextId = suggestNext(null);
  const wkHtml = list.map(w => {
    const isDone = done.has(w.id);
    const isProg = W && !W.finished && W.workoutId === w.id && W.day === d.today;
    const st = isDone ? ['done', '✓', 'CONCLUÍDO'] : isProg ? ['prog', '▶', 'EM ANDAMENTO'] : ['', w.id === nextId ? '▶' : '○', 'DISPONÍVEL'];
    return `<button class="wk ${st[0]} ${w.id === nextId && !isDone && !isProg ? 'next' : ''}" data-w="${esc(w.id)}">
      <span class="ic">${st[1]}</span><span class="grow"><b>${esc(w.name)}</b>
      <span class="mute small">${w.series} séries × ${repsShort(w.reps)}</span></span><span class="badge ${st[0]}">${st[2]}</span></button>`;
  }).join('');

  $v.innerHTML = `
  ${S.offline ? '<div class="tip">Sem conexão: mostrando os dados salvos. Seu progresso será sincronizado depois.</div>' : ''}
  <div id="install"></div>
  <div class="hdr">
    ${d.user.photo ? `<img class="avatar" src="${esc(photoSrc(d.user.photo))}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar',textContent:'${esc(first.charAt(0).toUpperCase())}'}))">`
      : `<div class="avatar">${esc(first.charAt(0).toUpperCase())}</div>`}
    <div class="grow"><h1>Olá, ${esc(first)} 👋</h1><div class="mute">${esc(label)}</div></div>
  </div>
  <div class="stats">
    <div class="stat"><b>${kg(d.user.weight).replace(' kg', '')}</b><span>Peso (kg)</span></div>
    <div class="stat"><b>${total}</b><span>Hoje</span></div>
    <div class="stat"><b>${nDone}</b><span>Concluídos</span></div>
    <div class="stat"><b>${total - nDone}</b><span>Restantes</span></div>
  </div>
  <h2>Treinos de hoje</h2>
  ${total ? wkHtml : '<div class="card empty">Nenhum treino programado para hoje. 🌿<br>Programe na aba TREINOS da planilha.</div>'}
  <h2>Peso de hoje</h2>
  <div class="card">
    <input id="wInput" class="field" inputmode="decimal" placeholder="${d.user.weight != null ? String(d.user.weight).replace('.', ',') : '68,4'}" aria-label="Peso em kg">
    <div style="height:10px"></div><button class="btn alt" id="wBtn">Registrar peso</button>
  </div>`;
  $v.querySelectorAll('.wk').forEach(b => b.onclick = () => startWorkout(b.dataset.w));
  document.getElementById('wBtn').onclick = saveWeight;
  showInstall();
}

function suggestNext(excludeId) {
  const done = completedSet();
  const c = S.data.workouts.filter(w => !done.has(w.id) && w.id !== excludeId);
  const prog = W && !W.finished ? c.find(w => w.id === W.workoutId) : null;
  return prog ? prog.id : (c[0] ? c[0].id : null);
}

function saveWeight() {
  const raw = document.getElementById('wInput').value.trim().replace(',', '.');
  const n = Number(raw);
  if (!raw || !isFinite(n) || n < 20 || n > 400) return toast('Peso inválido. Digite um valor válido.');
  const v = Math.round(n * 10) / 10;
  enqueue('weight', { clientId: uid(), weight: v, ts: Date.now() });
  S.data.user.weight = v; LS.set('cache', S.data);
  toast('Peso salvo: ' + kg(v)); renderHome();
}

/* ---------- INSTALAÇÃO PWA ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; showInstall(); });
function showInstall() {
  const el = document.getElementById('install');
  if (!el || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
  if (deferredPrompt) {
    el.innerHTML = '<button class="btn alt" id="inst" style="margin-bottom:14px">Instalar na tela inicial</button>';
    document.getElementById('inst').onclick = async () => { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; el.innerHTML = ''; };
  } else if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !LS.get('hideIos', false)) {
    el.innerHTML = '<div class="tip">Para instalar: toque em Compartilhar e depois em “Adicionar à Tela de Início”.</div>';
  }
}

/* ---------- TREINO ---------- */
function startWorkout(id) {
  unlockAudio();
  const w = S.data.workouts.find(x => x.id === id);
  if (!w) return;
  if (completedSet().has(id) && !confirm('Este treino já foi concluído hoje. Refazer?')) return;
  if (W && !W.finished && !(W.workoutId === id && W.day === S.data.today)) {
    if (!confirm('Há outro treino em andamento. Descartar e começar este?')) return;
  }
  if (!(W && !W.finished && W.workoutId === id && W.day === S.data.today)) {
    W = { execId: uid(), workoutId: w.id, day: S.data.today, name: w.name, series: w.series, reps: w.reps, rest: w.rest,
      link: w.link, notes: w.notes, done: 0, startMs: Date.now(), restEndsAt: null, paused: null, restOver: false, finished: false, note: '' };
    saveW();
  }
  openWorkout(false);
}
function saveW() { LS.set('active', W); }

function openWorkout() {
  $tabs.hidden = true; renderWorkout(); startTick();
}
function stopTick() { clearInterval(tick); tick = null; }
function startTick() {
  stopTick();
  tick = setInterval(() => {
    if (!W || W.finished || !W.restEndsAt) return;
    const left = Math.ceil((W.restEndsAt - Date.now()) / 1000);
    if (left <= 0) {
      W.restEndsAt = null; W.restOver = true; saveW(); startAlarm(); renderWorkout();
    } else {
      const t = document.getElementById('tm'); if (t) t.textContent = mmss(left);
    }
  }, 250);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && W && !W.finished && W.restEndsAt) renderWorkout(); });

function bar() {
  return '<div class="bar" aria-hidden="true">' + Array.from({ length: W.series }, (_, i) => `<i class="${i < W.done ? 'on' : ''}"></i>`).join('') + '</div>';
}

function renderWorkout() {
  if (!W) return go('home');
  if (W.finished) return renderFinished();
  const cur = W.done + 1;
  const head = `<button class="back" id="bk">‹ Treinos</button>
    <h1 style="margin-top:6px">${esc(W.name)}</h1>
    <div class="mute">${W.series} séries × ${repsLabel(W.reps)}</div>
    ${W.link ? `<a class="btn alt" style="margin:14px 0" href="${esc(W.link)}" target="_blank" rel="noopener noreferrer">🎥 Ver como fazer</a>` : ''}
    ${W.notes ? `<div class="tip">${esc(W.notes)}</div>` : ''}`;
  let body;
  if (W.restEndsAt || W.paused != null) {
    const left = W.paused != null ? Math.ceil(W.paused / 1000) : Math.max(0, Math.ceil((W.restEndsAt - Date.now()) / 1000));
    body = `<div class="rest center"><div class="lbl">DESCANSO${W.paused != null ? ' (pausado)' : ''}</div>
      <div class="timer" id="tm" role="timer">${mmss(left)}</div>
      <div class="mute">Próxima: série ${cur} de ${W.series}</div></div>
      <button class="btn ghost" id="pz">${W.paused != null ? 'Continuar' : 'Pausar'}</button>
      <button class="btn ghost" id="rs">Reiniciar descanso</button>
      <button class="btn" id="sk">Pular descanso</button>`;
  } else {
    body = `${W.restOver ? '<div class="rest over center"><div class="lbl">Descanso terminou! Próxima série ✔</div></div>' : ''}
      <div class="center"><div class="set">Série ${cur} de ${W.series}</div><div class="reps">${repsLabel(W.reps)}</div></div>
      <button class="btn big green" id="ok">CONCLUIR SÉRIE</button>`;
  }
  $v.innerHTML = `${head}${bar()}<div class="center set" style="margin-top:-6px">${W.done}/${W.series} concluídas</div>
    <div style="height:14px"></div>${body}
    <textarea class="note" id="nt" placeholder="Observações do treino (opcional)" aria-label="Observações">${esc(W.note)}</textarea>`;
  document.getElementById('bk').onclick = () => { stopAlarm(); stopTick(); go('home'); };
  document.getElementById('nt').oninput = e => { W.note = e.target.value.slice(0, 300); saveW(); };
  const q = id => document.getElementById(id);
  if (q('ok')) q('ok').onclick = completeSet;
  if (q('sk')) q('sk').onclick = () => { stopAlarm(); W.restEndsAt = null; W.paused = null; W.restOver = false; saveW(); renderWorkout(); };
  if (q('rs')) q('rs').onclick = () => { stopAlarm(); W.restEndsAt = Date.now() + W.rest * 1000; W.paused = null; saveW(); renderWorkout(); };
  if (q('pz')) q('pz').onclick = () => {
    stopAlarm();
    if (W.paused != null) { W.restEndsAt = Date.now() + W.paused; W.paused = null; }
    else { W.paused = Math.max(0, W.restEndsAt - Date.now()); W.restEndsAt = null; }
    saveW(); renderWorkout();
  };
}

function completeSet() {
  stopAlarm(); unlockAudio();
  W.done = Math.min(W.series, W.done + 1); W.restOver = false;
  if (W.done >= W.series) return finishWorkout();
  if (W.rest > 0) W.restEndsAt = Date.now() + W.rest * 1000;
  saveW(); renderWorkout();
}

function finishWorkout() {
  stopAlarm(); stopTick();
  W.finished = true; W.endMs = Date.now(); W.restEndsAt = null; W.paused = null; saveW();
  const dl = doneLocal(); (dl[W.day] = dl[W.day] || []).push(W.workoutId); LS.set('doneLocal', dl);
  enqueue('workout', { execId: W.execId, workoutId: W.workoutId, day: W.day, name: W.name, series: W.series, reps: W.reps,
    seriesDone: W.done, startMs: W.startMs, endMs: W.endMs });
  toast('Treino concluído com sucesso.');
  renderFinished();
}

function renderFinished() {
  $tabs.hidden = true;
  const mins = Math.max(1, Math.round((W.endMs - W.startMs) / 60000));
  const next = suggestNext(W.workoutId);
  const nextW = next && S.data.workouts.find(w => w.id === next);
  const left = S.data.workouts.filter(w => !completedSet().has(w.id)).length;
  $v.innerHTML = `<div class="center" style="padding-top:20px"><div style="font-size:64px">🎉</div><h1>Treino concluído!</h1>
    <h2 style="margin-top:8px">${esc(W.name)}</h2><div class="mute">${W.series} × ${repsLabel(W.reps)}</div></div>
    <div class="stat2"><div class="stat"><b>${hhmm(W.startMs)}</b><span>Início</span></div><div class="stat"><b>${hhmm(W.endMs)}</b><span>Término</span></div></div>
    <div class="stat" style="margin-bottom:16px"><b>${mins} min</b><span>Duração</span></div>
    ${left ? `<p class="center">Você ainda tem <b>${left}</b> ${left > 1 ? 'treinos' : 'treino'} hoje.</p>` : '<p class="center">Todos os treinos de hoje foram concluídos. 💜</p>'}
    ${nextW ? `<button class="btn" id="nx">Próximo treino: ${esc(nextW.name)}</button>` : ''}
    <button class="btn ghost" id="bk">Voltar para treinos</button>`;
  const leave = () => { LS.del('active'); W = null; };
  document.getElementById('bk').onclick = () => { leave(); go('home'); };
  if (nextW) document.getElementById('nx').onclick = () => { leave(); startWorkout(nextW.id); };
}

/* ---------- HISTÓRICO ---------- */
async function renderHistory() {
  const ranges = [['today', 'Hoje'], ['7', '7 dias'], ['30', '30 dias'], ['all', 'Todos']];
  $v.innerHTML = `<h1>Histórico</h1><div class="chips">${ranges.map(r => `<button class="chip ${S.historyRange === r[0] ? 'on' : ''}" data-r="${r[0]}">${r[1]}</button>`).join('')}</div><div id="hl"><div class="spin"></div></div>`;
  $v.querySelectorAll('.chip').forEach(b => b.onclick = () => { S.historyRange = b.dataset.r; renderHistory(); });
  const box = document.getElementById('hl');
  try {
    const r = await apiGet('history', { range: S.historyRange });
    if (!r.ok) throw new Error(r.message);
    const items = r.data.items;
    box.innerHTML = items.length ? items.map(i => `<div class="hi"><div class="d">${esc(i.date)}</div>
      <div class="grow"><b>✓ ${esc(i.name)}</b><div class="mute small">${esc(i.series)} × ${esc(i.reps)} · ${i.minutes} min${i.weight != null ? ' · ' + kg(i.weight) : ''}</div></div></div>`).join('')
      : '<div class="card empty">Nenhum treino concluído neste período.</div>';
  } catch (e) {
    console.warn(e); box.innerHTML = '<div class="err">Não foi possível carregar o histórico. Verifique sua conexão.</div>';
  }
}

/* ---------- EVOLUÇÃO DO PESO ---------- */
async function renderWeight() {
  $v.innerHTML = '<h1>Evolução do peso</h1><div id="wl"><div class="spin"></div></div>';
  const box = document.getElementById('wl');
  try {
    const r = await apiGet('weightEvolution');
    if (!r.ok) throw new Error(r.message);
    const p = r.data.points;
    if (!p.length) { box.innerHTML = '<div class="card empty">Ainda não há pesos registrados. Registre na tela Hoje.</div>'; return; }
    const ws = p.map(x => x.weight), first = ws[0], last = ws[ws.length - 1], diff = last - first;
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
    box.innerHTML = `<div class="stat2">
      <div class="stat"><b>${kg(first)}</b><span>Inicial</span></div><div class="stat"><b>${kg(last)}</b><span>Atual</span></div>
      <div class="stat"><b>${sign}${Math.abs(diff).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg</b><span>Diferença</span></div>
      <div class="stat"><b>${p.length}</b><span>Registros</span></div>
      <div class="stat"><b>${kg(Math.min(...ws))}</b><span>Menor</span></div><div class="stat"><b>${kg(Math.max(...ws))}</b><span>Maior</span></div></div>
      ${p.length < 3 ? '<div class="tip">Com poucos registros o gráfico fica simples. Continue registrando para ver a evolução.</div>' : ''}
      <div class="card">${chart(p)}</div><p class="mute small">Dados registrados por você, sem interpretação médica.</p>`;
  } catch (e) {
    console.warn(e); box.innerHTML = '<div class="err">Não foi possível carregar o peso. Verifique sua conexão.</div>';
  }
}
function chart(p) {
  const w = 320, h = 180, m = 28;
  const ws = p.map(x => x.weight); let lo = Math.min(...ws), hi = Math.max(...ws);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const x = i => p.length === 1 ? w / 2 : m + i * (w - 2 * m) / (p.length - 1);
  const y = v => h - m - (v - lo) / (hi - lo) * (h - 2 * m);
  const pts = p.map((q, i) => x(i) + ',' + y(q.weight)).join(' ');
  const every = Math.ceil(p.length / 5);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Gráfico de evolução do peso">
    <polyline points="${pts}" fill="none" stroke="var(--violet)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    ${p.map((q, i) => `<circle cx="${x(i)}" cy="${y(q.weight)}" r="4" fill="var(--violet)"/>${i % every === 0 || i === p.length - 1 ? `<text x="${x(i)}" y="${h - 8}" font-size="10" text-anchor="middle" fill="var(--mute)">${esc(q.label)}</text>` : ''}`).join('')}
    <text x="4" y="${y(hi) + 4}" font-size="10" fill="var(--mute)">${hi.toFixed(1)}</text><text x="4" y="${y(lo) + 4}" font-size="10" fill="var(--mute)">${lo.toFixed(1)}</text></svg>`;
}

boot();
