/* PB FPS Online — browser client (plain script, Three.js r128 UMD global THREE).
   Protocol: see ../PROTOCOL.md. Server is authoritative for HP/damage/scores/bots.
   Client: rendering, input, raycast target-picking, chat, WebRTC voice, minimap. */
(function () {
'use strict';

/* ---------------- Shared constants (must match PROTOCOL.md) ---------------- */
var MAPS = ['Downtown', 'Luxville', 'Midtown', 'Burning Hall', 'Safe House', 'Crackdown'];
var MAP_THEMES = {
  'Downtown':     { sky: 0x87b5d6, ground: 0x6b6f6b },
  'Luxville':     { sky: 0xffd9a0, ground: 0x8a7a5a },
  'Midtown':      { sky: 0x9fc3e8, ground: 0x5f6b7a },
  'Burning Hall': { sky: 0x3a2a2a, ground: 0x4a3a32 },
  'Safe House':   { sky: 0x7aa08a, ground: 0x5a6b52 },
  'Crackdown':    { sky: 0x2a2f3a, ground: 0x3a3f4a }
};
var WEAPONS = {
  k5:    { id: 'k5',    name: 'K-5',   dmg: 25, rpm: 600, range: 40,  auto: true,  mag: 30, reload: 1.6, desc: '25 dmg · 600 rpm' },
  ak47:  { id: 'ak47',  name: 'AK-47', dmg: 34, rpm: 600, range: 60,  auto: true,  mag: 30, reload: 2.2, desc: '34 dmg · 600 rpm' },
  m4a1:  { id: 'm4a1',  name: 'M4A1',  dmg: 30, rpm: 700, range: 55,  auto: true,  mag: 30, reload: 2.0, desc: '30 dmg · 700 rpm' },
  mp5:   { id: 'mp5',   name: 'MP5',   dmg: 22, rpm: 800, range: 35,  auto: true,  mag: 30, reload: 1.8, desc: '22 dmg · 800 rpm' },
  awp:   { id: 'awp',   name: 'AWP',   dmg: 100, rpm: 45, range: 100, auto: false, mag: 5,  reload: 3.0, desc: '100 dmg · bolt' },
  m1887: { id: 'm1887', name: 'M1887', dmg: 12, rpm: 70, range: 15,  auto: false, mag: 6,  reload: 2.8, desc: '12x8 dmg · pump' }
};
var WEAPON_ORDER = ['k5', 'ak47', 'm4a1', 'mp5', 'awp', 'm1887'];
var CHARACTERS = {
  CT: ['Keen Eyes', 'Acid Pol', 'Hide', 'Leopard'],
  FR: ['Rica', 'Tarantula', 'D-Fox', 'Viper Red']
};
var ALL_CHARACTERS = CHARACTERS.CT.concat(CHARACTERS.FR);
var CHAR_COLORS = {
  'Keen Eyes': '#3a7bd5', 'Acid Pol': '#2ecc71', 'Hide': '#95a5a6', 'Leopard': '#e67e22',
  'Rica': '#e74c3c', 'Tarantula': '#8e44ad', 'D-Fox': '#f1c40f', 'Viper Red': '#c0392b'
};
var TEAM_COLORS = { CT: '#2f7bff', FR: '#ff3b30' };
var MATCH_LEN = 300, RESPAWN_MS = 3000, PLAYER_RADIUS = 0.6;

/* Deterministic obstacles — SAME algorithm as PROTOCOL.md:
   seed = sum of char codes of map name; mulberry32; 26 boxes;
   w=2+rnd()*4, d=2+rnd()*4, x=-28+rnd()*56, z=-28+rnd()*56;
   skip if within 6 of either spawn (-26,0)/(26,0); h=2+rnd()*3 (only for kept boxes). */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function genObstacles(mapName) {
  var seed = 0, i;
  for (i = 0; i < mapName.length; i++) seed += mapName.charCodeAt(i);
  var rnd = mulberry32(seed), out = [];
  for (i = 0; i < 26; i++) {
    var w = 2 + rnd() * 4, d = 2 + rnd() * 4;
    var x = -28 + rnd() * 56, z = -28 + rnd() * 56;
    if (Math.hypot(x + 26, z) < 6 || Math.hypot(x - 26, z) < 6) continue;
    out.push({ x: x, z: z, w: w, d: d, h: 2 + rnd() * 3 });
  }
  return out;
}

/* ---------------- i18n ---------------- */
var I18N = {
  id: {
    soldier: 'Prajurit', name: 'Nama Prajurit', team: 'Tim', character: 'Karakter',
    weaponPick: 'WEAPON — PICK HERE', createRoom: 'Buat Room', map: 'Map', mode: 'Mode',
    createBtn: 'BUAT ROOM', joinRoom: 'Gabung Room', roomCode: 'Kode Room (4 huruf)',
    joinBtn: 'GABUNG', leave: 'Keluar', players: 'Pemain', startMatch: 'START MATCH',
    loadout: 'Loadout', chat: 'CHAT', score: 'SKOR', youDied: 'KAMU MATI',
    backToLobby: 'Kembali ke Lobby', reconnecting: 'Menghubungkan ulang…',
    menuHint: 'Desktop: WASD gerak, mouse bidik, klik tembak, R reload, Shift lari, Tab skor, Enter chat. Mobile: joystick kiri, geser kanan untuk membidik, tombol FIRE.',
    enterName: 'Isi nama prajurit dulu.', enterCode: 'Isi kode room 4 huruf.',
    connecting: 'Menghubungkan ke server…', hostStarts: 'Host memulai match…',
    waitingHost: 'Menunggu host memulai match…', respawnIn: 'Respawn dalam ',
    winner: 'Pemenang', draw: 'Seri!', chatPh: 'Ketik pesan… (Enter kirim)',
    micOn: 'MIC ON', micOff: 'MIC OFF', speaking: 'SUARA: ', ffa: 'FFA',
    you: 'KAMU', host: 'HOST', bot: 'BOT', kills: 'K', deaths: 'M',
    leftRoom: 'Keluar dari room.', connLost: 'Koneksi putus. Mencoba sambung ulang…',
    errJoin: 'Gagal gabung room.', needNameCode: 'Nama + kode room wajib diisi.'
  },
  en: {
    soldier: 'Soldier', name: 'Soldier Name', team: 'Team', character: 'Character',
    weaponPick: 'WEAPON — PICK HERE', createRoom: 'Create Room', map: 'Map', mode: 'Mode',
    createBtn: 'CREATE ROOM', joinRoom: 'Join Room', roomCode: 'Room Code (4 letters)',
    joinBtn: 'JOIN', leave: 'Leave', players: 'Players', startMatch: 'START MATCH',
    loadout: 'Loadout', chat: 'CHAT', score: 'SCORE', youDied: 'YOU DIED',
    backToLobby: 'Back to Lobby', reconnecting: 'Reconnecting…',
    menuHint: 'Desktop: WASD move, mouse aim, click shoot, R reload, Shift run, Tab score, Enter chat. Mobile: left joystick, drag right side to aim, FIRE button.',
    enterName: 'Enter a soldier name first.', enterCode: 'Enter the 4-letter room code.',
    connecting: 'Connecting to server…', hostStarts: 'Host starts the match…',
    waitingHost: 'Waiting for host to start the match…', respawnIn: 'Respawn in ',
    winner: 'Winner', draw: 'Draw!', chatPh: 'Type a message… (Enter to send)',
    micOn: 'MIC ON', micOff: 'MIC OFF', speaking: 'VOICE: ', ffa: 'FFA',
    you: 'YOU', host: 'HOST', bot: 'BOT', kills: 'K', deaths: 'D',
    leftRoom: 'Left the room.', connLost: 'Connection lost. Reconnecting…',
    errJoin: 'Failed to join room.', needNameCode: 'Name + room code are required.'
  }
};
var lang = localStorage.getItem('pb_lang') || 'id';
function t(key) { return (I18N[lang] && I18N[lang][key]) || I18N.id[key] || key; }
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var k = el.getAttribute('data-i18n');
    if (I18N[lang][k]) el.textContent = I18N[lang][k];
  });
  document.getElementById('chat-input').placeholder = t('chatPh');
  document.getElementById('lang-id').classList.toggle('active', lang === 'id');
  document.getElementById('lang-en').classList.toggle('active', lang === 'en');
  document.documentElement.lang = lang;
}
function setLang(l) { lang = l; localStorage.setItem('pb_lang', l); applyI18n(); renderAllSelectors(); }

/* ---------------- State ---------------- */
var $ = function (id) { return document.getElementById(id); };
var isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
if (isTouch) document.body.classList.add('touch');

var ws = null, wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
var myId = null, myName = localStorage.getItem('pb_name') || '';
var room = null, roomCode = null, inRoom = false, inMatch = false;
var sel = {
  team: localStorage.getItem('pb_team') || 'CT',
  character: localStorage.getItem('pb_char') || 'Keen Eyes',
  weapon: localStorage.getItem('pb_weapon') || 'k5',
  map: localStorage.getItem('pb_map') || 'Downtown',
  mode: localStorage.getItem('pb_mode') || 'tdm'
};
var reconnectTimer = null, reconnectDelay = 2000, wantReconnect = false;
var lastJoin = null; // {code,name,team,character,weapon} for auto re-join after drop
var chatOpen = false, unread = 0, chatTyping = false;
var keys = {};
var myPos = { x: -26, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true, kills: 0, deaths: 0 };
var spawnPending = true, deadSince = 0, respawnTimer = null;
var ammo = WEAPONS[sel.weapon].mag, reloading = false, reloadEnd = 0, lastShot = 0, firing = false, semiFired = false;
var remotePlayers = {}; // id -> {data, group, sprite, canvas, ctx, tex, lastHp, tx, tz, tyaw}
var hitMeshes = [];
var moveTimer = 0;
var speakingPeers = {};
var micOn = false, localStream = null, peers = {}, audioCtx = null, analysers = {};
var joy = { active: false, id: null, fx: 0, fz: 0 };
var lookTouch = { active: false, id: null, lx: 0, ly: 0 };

/* ---------------- Screens ---------------- */
function showScreen(name) {
  ['menu-screen', 'lobby-screen', 'game-screen'].forEach(function (id) {
    $(id).classList.toggle('active', id === name + '-screen');
  });
  updateForcedLandscape();
}
function setStatus(msg) { $('menu-status').textContent = msg || ''; }

/* ---------------- Menu / lobby selectors ---------------- */
function buildCharGrid(container, team) {
  container.innerHTML = '';
  var list = (room && room.mode === 'ffa') ? ALL_CHARACTERS : CHARACTERS[team];
  list.forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'char-card' + (sel.character === c ? ' active' : '');
    b.innerHTML = '<div class="dot" style="background:' + (CHAR_COLORS[c] || '#888') + '"></div>' + c;
    b.onclick = function () { setCharacter(c); };
    container.appendChild(b);
  });
}
function buildWeaponGrid(container) {
  container.innerHTML = '';
  WEAPON_ORDER.forEach(function (wid) {
    var w = WEAPONS[wid];
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'weapon-card' + (sel.weapon === wid ? ' active' : '');
    b.innerHTML = '<b>' + w.name + '</b><span>' + w.desc + ' · mag ' + w.mag + '</span>';
    b.onclick = function () { setWeapon(wid); };
    container.appendChild(b);
  });
}
function markSeg(containerId, attr, val) {
  var c = $(containerId); if (!c) return;
  c.querySelectorAll('button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute(attr) === val);
  });
}
function renderAllSelectors() {
  buildCharGrid($('char-grid'), sel.team);
  buildCharGrid($('lobby-char-grid'), sel.team);
  buildWeaponGrid($('weapon-grid'));
  buildWeaponGrid($('lobby-weapon-grid'));
  markSeg('team-seg', 'data-team', sel.team);
  markSeg('lobby-team-seg', 'data-team', sel.team);
  $('map-select').value = sel.map;
  $('mode-select').value = sel.mode;
}
function setTeam(team, send) {
  sel.team = team; localStorage.setItem('pb_team', team);
  if (CHARACTERS[team].indexOf(sel.character) < 0 && !(room && room.mode === 'ffa')) {
    sel.character = CHARACTERS[team][0]; localStorage.setItem('pb_char', sel.character);
  }
  renderAllSelectors();
  if (send && ws && ws.readyState === 1 && inRoom) sendWs({ type: 'updateTeam', team: team });
}
function setCharacter(c, send) {
  sel.character = c; localStorage.setItem('pb_char', c);
  renderAllSelectors();
  if (send !== false && ws && ws.readyState === 1 && inRoom) sendWs({ type: 'updateCharacter', character: c });
}
function setWeapon(wid, send) {
  if (!WEAPONS[wid]) return;
  sel.weapon = wid; localStorage.setItem('pb_weapon', wid);
  ammo = WEAPONS[wid].mag; reloading = false;
  renderAllSelectors(); updateAmmoHud();
  $('weapon-name').textContent = WEAPONS[wid].name;
  if (send !== false && ws && ws.readyState === 1 && inRoom) sendWs({ type: 'updateWeapon', weapon: wid });
}

/* ---------------- WebSocket ---------------- */
function wsConnect(onOpen) {
  try { if (ws) { try { ws.close(); } catch (e) {} } } catch (e) {}
  setStatus(t('connecting'));
  ws = new WebSocket(wsUrl);
  ws.onopen = function () {
    setStatus(''); $('reconnect').classList.add('hidden');
    reconnectDelay = 2000;
    if (onOpen) onOpen();
    else if (wantReconnect && lastJoin) {
      // Auto re-join the same room after a drop.
      sendWs({ type: 'joinRoom', code: lastJoin.code, name: lastJoin.name,
        team: lastJoin.team, character: lastJoin.character, weapon: lastJoin.weapon });
    }
  };
  ws.onmessage = function (ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleServer(msg);
  };
  ws.onerror = function () { /* onclose handles the notice */ };
  ws.onclose = function () {
    if (!inRoom && !wantReconnect) return;
    $('reconnect').classList.remove('hidden');
    setStatus(t('connLost'));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () { if (wantReconnect) wsConnect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  };
}
function sendWs(obj) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}
function ensureWs(cb) {
  if (ws && ws.readyState === 1) return cb();
  if (ws && ws.readyState === 0) { var iv = setInterval(function () {
    if (ws.readyState === 1) { clearInterval(iv); cb(); }
    if (ws.readyState > 1) { clearInterval(iv); wsConnect(cb); }
  }, 100); return; }
  wsConnect(cb);
}

function handleServer(msg) {
  switch (msg.type) {
    case 'roomCreated':
    case 'roomJoined':
      room = msg.room; roomCode = room.code; inRoom = true; wantReconnect = true;
      // Protocol sends no explicit myId: the just-added self entry is the last
      // player in room.players on create/join (fallback: name+team+character match).
      var plist = msg.room.players || [];
      if (plist.length) myId = plist[plist.length - 1].id;
      if (!myId) { var m = plist.filter(function (p) { return p.name === myName && p.team === sel.team && p.character === sel.character; }); if (m.length) myId = m[m.length - 1].id; }
      lastJoin = { code: room.code, name: myName, team: sel.team, character: sel.character, weapon: sel.weapon };
      showLobby(); break;
    case 'playerJoined': addChatLine(null, msg.player.name + ' joined', 'sys'); if (room) renderLobby(); break;
    case 'playerLeft':
      if (msg.id === myId) break;
      delete remotePlayers[msg.id]; removeSoldier(msg.id); closePeer(msg.id);
      if (room) { room.players = (room.players || []).filter(function (p) { return p.id !== msg.id; }); renderLobby(); }
      break;
    case 'matchStarted':
      inMatch = true; spawnPending = true; myPos.hp = 100; myPos.alive = true;
      $('match-end').classList.add('hidden'); $('respawn-overlay').classList.add('hidden');
      startGame(); break;
    case 'state': onState(msg); break;
    case 'hit': onHit(msg); break;
    case 'killfeed': addKillfeed(msg); break;
    case 'chat': addChatLine(msg.name, msg.text, msg.team); break;
    case 'voiceSignal': onVoiceSignal(msg.from, msg.signal); break;
    case 'matchEnded': onMatchEnded(msg); break;
    case 'respawned':
      if (msg.id === myId) { myPos.x = msg.x; myPos.z = msg.z; myPos.hp = 100; myPos.alive = true; spawnPending = false; $('respawn-overlay').classList.add('hidden'); }
      break;
    case 'error':
      setStatus(msg.message || t('errJoin'));
      $('lobby-hint').textContent = msg.message || '';
      if (!inRoom) { showScreen('menu'); }
      break;
  }
}
function onState(msg) {
  if (msg.room) room = msg.room;
  else if (room) {
    if (msg.timeLeft != null) room.timeLeft = msg.timeLeft;
    if (msg.scores) room.scores = msg.scores;
    if (msg.players) room.players = msg.players;
    if (msg.bots) room.bots = msg.bots;
  }
  if (msg.scores) updateScoresHud(msg.scores, msg.timeLeft);
  else if (msg.timeLeft != null) updateTimerHud(msg.timeLeft);
  var all = (msg.players || []).concat(msg.bots || []);
  // Fallback self-identification if roomCreated arrived before myId was set.
  if (myId == null) {
    var cand = all.filter(function (p) { return !p.isBot && p.name === myName && p.team === sel.team && p.character === sel.character; });
    if (cand.length) myId = cand[cand.length - 1].id;
  }
  var self = null, i;
  for (i = 0; i < all.length; i++) if (all[i].id === myId) self = all[i];
  if (self) {
    myPos.kills = self.kills || 0; myPos.deaths = self.deaths || 0;
    $('hud-kd').textContent = 'K ' + myPos.kills + ' · D ' + myPos.deaths;
    if (spawnPending || !self.alive) { myPos.x = self.x; myPos.z = self.z; myPos.yaw = self.yaw || 0; spawnPending = false; }
    if (self.hp != null && self.hp !== myPos.hp) { myPos.hp = self.hp; updateHpHud(); }
    if (!self.alive && myPos.alive) onDied();
    if (self.alive && !myPos.alive) { myPos.alive = true; $('respawn-overlay').classList.add('hidden'); }
    myPos.alive = !!self.alive;
  }
  // Remote players + bots
  var seen = {};
  all.forEach(function (p) {
    if (p.id === myId) return;
    seen[p.id] = true;
    var rp = remotePlayers[p.id];
    if (!rp) rp = remotePlayers[p.id] = createSoldier(p);
    rp.data = p; rp.tx = p.x; rp.tz = p.z; rp.tyaw = p.yaw || 0;
    if (p.hp !== rp.lastHp || p.name !== rp.lastName) { updateSoldierSprite(rp); rp.lastHp = p.hp; rp.lastName = p.name; }
    if (rp.group) rp.group.visible = !!p.alive;
  });
  Object.keys(remotePlayers).forEach(function (id) {
    if (!seen[id]) { removeSoldier(id); delete remotePlayers[id]; }
  });
  if (room && room.state === 'lobby') renderLobby();
  if (inMatch) updateScoreboard(all);
}
function onHit(msg) {
  if (msg.shooterId === myId) {
    var hm = $('hitmarker'); hm.classList.add('show'); if (msg.killed) hm.classList.add('kill');
    setTimeout(function () { hm.classList.remove('show'); hm.classList.remove('kill'); }, 120);
  }
  if (msg.targetId === myId) { myPos.hp = msg.hpLeft; updateHpHud(); if (msg.killed) onDied(); }
}
function onDied() {
  if (!myPos.alive) return;
  myPos.alive = false; myPos.hp = 0; deadSince = Date.now(); updateHpHud();
  exitPointerLock();
  $('respawn-overlay').classList.remove('hidden');
  var n = 3;
  $('respawn-text').textContent = t('respawnIn') + n + 's';
  clearInterval(respawnTimer);
  respawnTimer = setInterval(function () {
    n--;
    if (n <= 0) {
      clearInterval(respawnTimer);
      sendWs({ type: 'respawn' });
      $('respawn-text').textContent = t('respawnIn') + '…';
    } else $('respawn-text').textContent = t('respawnIn') + n + 's';
  }, 1000);
}
function onMatchEnded(msg) {
  inMatch = false; exitPointerLock();
  var title = msg.winner === 'draw' ? t('draw') : (t('winner') + ': ' + msg.winner);
  $('match-end-title').textContent = title;
  var s = msg.scores || (room && room.scores) || {};
  $('match-end-scores').textContent = 'CT ' + (s.CT || 0) + ' — ' + (s.FR || 0) + ' FR';
  $('match-end').classList.remove('hidden');
  updateScoreboard((room && room.players || []).concat(room && room.bots || []));
}

/* ---------------- Lobby ---------------- */
function showLobby() {
  showScreen('lobby');
  $('lobby-code').textContent = roomCode || '----';
  renderLobby();
}
function renderLobby() {
  if (!room) return;
  var modeName = room.mode === 'ffa' ? 'FFA' : 'Team Deathmatch';
  $('lobby-meta').textContent = room.map + ' · ' + modeName + ' · ' + (room.state || 'lobby');
  $('lobby-hint').textContent = (room.hostId === myId) ? t('hostStarts') : t('waitingHost');
  $('btn-start').classList.toggle('hidden', room.hostId !== myId);
  var ul = $('player-list'); ul.innerHTML = '';
  var all = (room.players || []).concat(room.bots || []);
  all.forEach(function (p) {
    var li = document.createElement('li');
    if (p.team === 'FR') li.classList.add('fr');
    li.innerHTML = '<span><b>' + esc(p.name) + '</b>' +
      (p.id === room.hostId ? '<span class="host-tag">' + t('host') + '</span>' : '') +
      (p.id === myId ? '<span class="you-tag">' + t('you') + '</span>' : '') +
      (p.isBot ? '<span class="bot-tag">' + t('bot') + '</span>' : '') +
      '<br><small style="color:var(--muted)">' + esc(p.character || '') + ' · ' + (WEAPONS[p.weapon] ? WEAPONS[p.weapon].name : p.weapon || '') + '</small></span>' +
      '<span>' + (p.team === 'FR' ? 'Free Rebels' : (room.mode === 'ffa' ? t('ffa') : 'CT-Force')) + '</span>';
    ul.appendChild(li);
  });
  if (!all.length) ul.innerHTML = '<li>' + t('waitingHost') + '</li>';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

/* ---------------- Three.js game ---------------- */
var renderer, scene, camera, clock, obstacles = [], mapBuiltFor = null;
var raycaster = null;
var gameStarted = false, animId = null;

function initThree(mapName) {
  if (typeof THREE === 'undefined') { setStatus('Three.js failed to load (CDN). Check connection and reload.'); return false; }
  var canvas = $('game-canvas');
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  scene = new THREE.Scene();
  var theme = MAP_THEMES[mapName] || MAP_THEMES.Downtown;
  scene.background = new THREE.Color(theme.sky);
  scene.fog = new THREE.Fog(theme.sky, 40, 110);
  camera = new THREE.PerspectiveCamera(75, (canvas.clientWidth || 1) / (canvas.clientHeight || 1), 0.1, 200);
  camera.rotation.order = 'YXZ';
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  var sun = new THREE.DirectionalLight(0xffffff, 0.7); sun.position.set(20, 40, 10); scene.add(sun);
  var ground = new THREE.Mesh(new THREE.PlaneGeometry(64, 64),
    new THREE.MeshLambertMaterial({ color: theme.ground }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  // Grid lines for orientation
  var grid = new THREE.GridHelper(64, 32, 0x000000, 0x000000);
  grid.material.transparent = true; grid.material.opacity = 0.08; grid.position.y = 0.02; scene.add(grid);
  // Boundary walls (low, visual)
  var wallMat = new THREE.MeshLambertMaterial({ color: 0x3a4034 });
  [[0, -32, 64, 1], [0, 32, 64, 1], [-32, 0, 1, 64], [32, 0, 1, 64]].forEach(function (w) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w[2], 2.5, w[3]), wallMat);
    m.position.set(w[0], 1.25, w[1]); scene.add(m);
  });
  // Deterministic obstacles (same seed/algorithm as server)
  obstacles = genObstacles(mapName); mapBuiltFor = mapName;
  var palette = [0x8a7a5a, 0x6b7a8a, 0x7a6a4a, 0x5a6b52, 0x8a5a3a, 0x4a5a6a];
  obstacles.forEach(function (b, i) {
    var mat = new THREE.MeshLambertMaterial({ color: palette[i % palette.length] });
    var m = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), mat);
    m.position.set(b.x, b.h / 2, b.z); scene.add(m);
    // Roof lip so boxes read as buildings/containers
    var lip = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.3, 0.18, b.d + 0.3),
      new THREE.MeshLambertMaterial({ color: 0x2a2f26 }));
    lip.position.set(b.x, b.h + 0.09, b.z); scene.add(lip);
  });
  raycaster = new THREE.Raycaster(); raycaster.far = 100;
  clock = new THREE.Clock();
  window.addEventListener('resize', onResize);
  return true;
}
function onResize() {
  if (!renderer || !camera) return;
  var c = $('game-canvas');
  var w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
function createSoldier(p) {
  var teamCol = new THREE.Color(TEAM_COLORS[p.team] || '#888888');
  var charCol = new THREE.Color(CHAR_COLORS[p.character] || TEAM_COLORS[p.team] || '#888888');
  var g = new THREE.Group();
  var body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.4),
    new THREE.MeshLambertMaterial({ color: teamCol }));
  body.position.y = 0.9; body.userData.playerId = p.id; g.add(body);
  var vest = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.4, 0.44),
    new THREE.MeshLambertMaterial({ color: charCol }));
  vest.position.y = 1.05; vest.userData.playerId = p.id; g.add(vest);
  var head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42),
    new THREE.MeshLambertMaterial({ color: 0xd9b48a }));
  head.position.y = 1.65; head.userData.playerId = p.id; head.userData.isHead = true; g.add(head);
  var helm = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.18, 0.48),
    new THREE.MeshLambertMaterial({ color: charCol }));
  helm.position.y = 1.9; helm.userData.playerId = p.id; g.add(helm);
  var gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.85),
    new THREE.MeshLambertMaterial({ color: 0x1a1a1a }));
  gun.position.set(0.25, 1.15, -0.4); g.add(gun);
  var legs = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.35),
    new THREE.MeshLambertMaterial({ color: 0x2a2f26 }));
  legs.position.y = 0.2; legs.userData.playerId = p.id; g.add(legs);
  // Name + HP sprite
  var canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
  var tex = new THREE.CanvasTexture(canvas);
  var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(2.6, 0.65, 1); spr.position.y = 2.35; g.add(spr);
  g.position.set(p.x || 0, 0, p.z || 0);
  scene.add(g);
  [body, vest, head, helm, legs].forEach(function (m) { hitMeshes.push(m); });
  var rp = { data: p, group: g, sprite: spr, canvas: canvas, ctx: canvas.getContext('2d'), tex: tex,
    lastHp: p.hp, lastName: p.name, tx: p.x || 0, tz: p.z || 0, tyaw: p.yaw || 0 };
  updateSoldierSprite(rp);
  return rp;
}
function updateSoldierSprite(rp) {
  var ctx = rp.ctx, p = rp.data; if (!ctx || !p) return;
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = 'bold 24px Arial'; ctx.textAlign = 'center';
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
  ctx.strokeText(p.name || '?', 128, 26); ctx.fillText(p.name || '?', 128, 26);
  var hp = Math.max(0, p.hp == null ? 100 : p.hp);
  var enemy = (room && room.mode !== 'ffa') ? (p.team !== sel.team) : (p.id !== myId);
  ctx.fillStyle = '#222'; ctx.fillRect(53, 36, 150, 14);
  ctx.fillStyle = enemy ? '#ff3b30' : '#3ddc5a';
  ctx.fillRect(53, 36, 150 * hp / 100, 14);
  ctx.strokeStyle = '#000'; ctx.strokeRect(53, 36, 150, 14);
  rp.tex.needsUpdate = true;
}
function removeSoldier(id) {
  var rp = remotePlayers[id]; if (!rp || !rp.group) return;
  scene.remove(rp.group);
  hitMeshes = hitMeshes.filter(function (m) { return m.userData.playerId !== id; });
}
function startGame() {
  showScreen('game');
  $('hud-room').textContent = 'ROOM ' + (roomCode || '');
  $('hud-map-mode').textContent = (room ? room.map : sel.map) + ' · ' + (room && room.mode === 'ffa' ? 'FFA' : 'Team Deathmatch');
  $('hud-player').textContent = myName + ' · ' + sel.character;
  $('weapon-name').textContent = WEAPONS[sel.weapon].name;
  updateAmmoHud(); updateHpHud();
  if (!gameStarted || mapBuiltFor !== (room ? room.map : sel.map)) {
    if (!initThree(room ? room.map : sel.map)) return;
    gameStarted = true;
  }
  camera.position.set(myPos.x, 1.7, myPos.z);
  camera.rotation.set(myPos.pitch, myPos.yaw, 0);
  if (!isTouch) $('game-canvas').addEventListener('click', requestLockOnce);
  if (animId == null) animate();
  updateForcedLandscape();
}
function requestLockOnce() {
  if (chatOpen || !inMatch || isTouch) return;
  var c = $('game-canvas');
  if (c.requestPointerLock) { try { c.requestPointerLock(); } catch (e) {} }
}
function exitPointerLock() { try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {} }

/* Movement collision: circle (r=0.6) vs obstacle boxes, same as server. */
function collide(nx, nz) {
  nx = Math.max(-31, Math.min(31, nx)); nz = Math.max(-31, Math.min(31, nz));
  for (var i = 0; i < obstacles.length; i++) {
    var b = obstacles[i];
    var cx = Math.max(b.x - b.w / 2, Math.min(nx, b.x + b.w / 2));
    var cz = Math.max(b.z - b.d / 2, Math.min(nz, b.z + b.d / 2));
    var dx = nx - cx, dz = nz - cz, d2 = dx * dx + dz * dz;
    if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
      if (d2 < 1e-6) { nx = b.x + b.w / 2 + PLAYER_RADIUS; continue; }
      var d = Math.sqrt(d2);
      nx = cx + dx / d * PLAYER_RADIUS; nz = cz + dz / d * PLAYER_RADIUS;
    }
  }
  return { x: nx, z: nz };
}
function animate() {
  animId = requestAnimationFrame(animate);
  var dt = clock ? Math.min(clock.getDelta(), 0.05) : 0.016;
  if (!inMatch || !camera) return;
  // Movement
  var speed = (keys['ShiftLeft'] || keys['ShiftRight']) ? 8 : 5;
  var f = 0, s = 0;
  if (!chatTyping && myPos.alive) {
    if (keys['KeyW'] || keys['ArrowUp']) f += 1;
    if (keys['KeyS'] || keys['ArrowDown']) f -= 1;
    if (keys['KeyA'] || keys['ArrowLeft']) s -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) s += 1;
    f += joy.fz; s += joy.fx;
  }
  var len = Math.hypot(f, s); if (len > 1) { f /= len; s /= len; }
  if ((f || s) && myPos.alive) {
    var sin = Math.sin(myPos.yaw), cos = Math.cos(myPos.yaw);
    // forward = (-sin, -cos); right = (cos, -sin)
    var nx = myPos.x + (-sin * f + cos * s) * speed * dt;
    var nz = myPos.z + (-cos * f - sin * s) * speed * dt;
    var p = collide(nx, nz); myPos.x = p.x; myPos.z = p.z;
  }
  camera.position.set(myPos.x, 1.7, myPos.z);
  camera.rotation.set(myPos.pitch, myPos.yaw, 0);
  // Auto fire while held (auto weapons)
  if (firing && myPos.alive && !chatTyping) tryShoot();
  // Throttled move send (~15/s)
  moveTimer += dt;
  if (moveTimer >= 0.066) { moveTimer = 0; sendWs({ type: 'move', x: +myPos.x.toFixed(2), z: +myPos.z.toFixed(2), yaw: +myPos.yaw.toFixed(3) }); }
  // Smooth remote players
  Object.keys(remotePlayers).forEach(function (id) {
    var rp = remotePlayers[id]; if (!rp.group) return;
    var k = Math.min(1, dt * 12);
    rp.group.position.x += (rp.tx - rp.group.position.x) * k;
    rp.group.position.z += (rp.tz - rp.group.position.z) * k;
    rp.group.rotation.y = rp.tyaw;
  });
  checkSpeakingLevels();
  drawMinimap();
  renderer.render(scene, camera);
}

/* ---------------- Shooting ---------------- */
function tryShoot() {
  var w = WEAPONS[sel.weapon];
  var now = performance.now();
  var interval = 60000 / w.rpm;
  if (now - lastShot < interval) return;
  if (reloading) return;
  if (ammo <= 0) { startReload(); return; }
  if (!w.auto && semiFired) return;
  lastShot = now; semiFired = true; ammo--;
  updateAmmoHud();
  var targetId = null;
  if (raycaster && camera) {
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    raycaster.far = w.range;
    var hits = raycaster.intersectObjects(hitMeshes.filter(function (m) { return m.visible !== false; }), false);
    // Filter out dead / invisible soldiers
    for (var i = 0; i < hits.length; i++) {
      var pid = hits[i].object.userData.playerId;
      var rp = remotePlayers[pid];
      if (rp && rp.data && rp.data.alive === false) continue;
      if (rp && rp.group && !rp.group.visible) continue;
      targetId = pid; break;
    }
  }
  sendWs({ type: 'shoot', targetId: targetId });
  if (ammo <= 0) startReload();
}
function startReload() {
  var w = WEAPONS[sel.weapon];
  if (reloading || ammo === w.mag) return;
  reloading = true; reloadEnd = Date.now() + w.reload * 1000;
  $('reload-hint').textContent = 'RELOADING…';
  setTimeout(function () {
    ammo = w.mag; reloading = false; $('reload-hint').textContent = ''; updateAmmoHud();
  }, w.reload * 1000);
}

/* ---------------- HUD / minimap / scoreboard / killfeed ---------------- */
function updateHpHud() {
  $('hp-text').textContent = 'HP ' + Math.max(0, Math.round(myPos.hp));
  var f = $('hp-fill'); f.style.width = Math.max(0, myPos.hp) + '%';
  f.style.background = myPos.hp > 50 ? '#3ddc5a' : (myPos.hp > 25 ? '#f5c518' : '#ff4d4d');
}
function updateAmmoHud() {
  var w = WEAPONS[sel.weapon];
  $('ammo').innerHTML = ammo + ' <small>/ ' + w.mag + '</small>';
  $('weapon-name').textContent = w.name;
}
function updateTimerHud(sec) {
  sec = Math.max(0, Math.round(sec == null ? MATCH_LEN : sec));
  $('timer').textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function updateScoresHud(scores, timeLeft) {
  if (timeLeft != null) updateTimerHud(timeLeft);
  if (!scores) return;
  if (room && room.mode === 'ffa') $('team-scores').innerHTML = 'FFA · ' + t('kills') + ' ' + (myPos.kills || 0);
  else $('team-scores').innerHTML = '<span class="ct">CT ' + (scores.CT || 0) + '</span> — <span class="fr">' + (scores.FR || 0) + ' FR</span>';
}
function drawMinimap() {
  var cv = $('minimap'), ctx = cv.getContext('2d'); if (!ctx) return;
  var W = cv.width, H = cv.height;
  ctx.fillStyle = '#141a12'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#3a4430';
  obstacles.forEach(function (b) {
    ctx.fillRect((b.x - b.w / 2 + 32) / 64 * W, (b.z - b.d / 2 + 32) / 64 * H, b.w / 64 * W, b.d / 64 * H);
  });
  function dot(x, z, col, r) {
    ctx.fillStyle = col; ctx.beginPath();
    ctx.arc((x + 32) / 64 * W, (z + 32) / 64 * H, r || 3, 0, Math.PI * 2); ctx.fill();
  }
  Object.keys(remotePlayers).forEach(function (id) {
    var rp = remotePlayers[id]; if (!rp.data || !rp.data.alive) return;
    var enemy = (room && room.mode !== 'ffa') ? (rp.data.team !== sel.team) : true;
    dot(rp.tx, rp.tz, enemy ? '#ff3b30' : '#3ddc5a', 3);
  });
  // self: white triangle pointing by yaw
  var sx = (myPos.x + 32) / 64 * W, sy = (myPos.z + 32) / 64 * H;
  ctx.fillStyle = '#fff'; ctx.beginPath();
  var a = Math.atan2(-Math.sin(myPos.yaw), -Math.cos(myPos.yaw)); // screen angle: x->right, z->down
  // In minimap coords, forward (-sin yaw, -cos yaw) maps to (dx, dy) directly.
  var fx = -Math.sin(myPos.yaw), fz = -Math.cos(myPos.yaw);
  ctx.moveTo(sx + fx * 6, sy + fz * 6);
  ctx.lineTo(sx - fz * 4 - fx * 3, sy + fx * 4 - fz * 3);
  ctx.lineTo(sx + fz * 4 - fx * 3, sy - fx * 4 - fz * 3);
  ctx.closePath(); ctx.fill();
}
function addKillfeed(msg) {
  var kf = $('killfeed');
  var div = document.createElement('div');
  div.innerHTML = '<b>' + esc(msg.killer || '?') + '</b> [' + esc((WEAPONS[msg.weapon] || {}).name || msg.weapon || '') + '] ' + esc(msg.victim || '?');
  kf.prepend(div);
  while (kf.children.length > 5) kf.removeChild(kf.lastChild);
  setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, 6000);
}
function updateScoreboard(all) {
  var sb = $('scoreboard'); if (sb.classList.contains('hidden')) return;
  renderScoreboard(all);
}
function renderScoreboard(all) {
  var rows = (all || []).slice().sort(function (a, b) { return (b.kills || 0) - (a.kills || 0); });
  var html = '<h3 style="margin:0 0 8px;color:var(--hazard)">SCOREBOARD</h3><table><tr><th>Player</th><th>Team</th><th>K</th><th>D</th></tr>';
  rows.forEach(function (p) {
    html += '<tr><td>' + esc(p.name) + (p.id === myId ? ' (' + t('you') + ')' : '') + (p.isBot ? ' [' + t('bot') + ']' : '') +
      '</td><td>' + esc(p.team || '') + '</td><td>' + (p.kills || 0) + '</td><td>' + (p.deaths || 0) + '</td></tr>';
  });
  $('scoreboard').innerHTML = html + '</table>';
}

/* ---------------- Chat ---------------- */
function addChatLine(name, text, team) {
  var log = $('chat-log');
  var div = document.createElement('div');
  if (!name) div.innerHTML = '<span class="sys">' + esc(text) + '</span>';
  else div.innerHTML = '<span class="' + (team === 'FR' ? 'fr' : 'ct') + '"><b>' + esc(name) + ':</b></span> ' + esc(text);
  log.appendChild(div); log.scrollTop = log.scrollHeight;
  if (!chatOpen && name) { unread++; var b = $('chat-badge'); b.textContent = unread; b.classList.remove('hidden'); }
}
function openChat() {
  chatOpen = true; unread = 0; $('chat-badge').classList.add('hidden');
  $('chat-panel').classList.remove('hidden');
  exitPointerLock();
  setTimeout(function () { $('chat-input').focus(); }, 50);
}
function closeChat() {
  chatOpen = false; $('chat-panel').classList.add('hidden');
  if ($('chat-input') === document.activeElement) $('chat-input').blur();
}
function sendChat() {
  var inp = $('chat-input'), text = inp.value.trim();
  if (text) sendWs({ type: 'chat', text: text.slice(0, 200) });
  inp.value = ''; closeChat(); requestLockOnce();
}

/* ---------------- Voice (WebRTC P2P, signaling via server) ---------------- */
function humanPeers() {
  return (room && room.players || []).filter(function (p) { return p.id && p.id !== myId && !p.isBot; });
}
function toggleMic() {
  if (micOn) { stopMic(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('btn-mic').textContent = 'MIC N/A'; return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    localStream = stream; micOn = true;
    $('btn-mic').textContent = t('micOn'); $('btn-mic').classList.add('on');
    humanPeers().forEach(function (p) { createPeer(p.id, true); });
  }).catch(function () { $('btn-mic').textContent = 'MIC ERR'; });
}
function stopMic() {
  micOn = false; $('btn-mic').textContent = t('micOff'); $('btn-mic').classList.remove('on');
  if (localStream) { localStream.getTracks().forEach(function (tr) { tr.stop(); }); localStream = null; }
  Object.keys(peers).forEach(closePeer);
}
function createPeer(id, initiator) {
  if (peers[id]) return peers[id];
  var pc;
  try { pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); }
  catch (e) { return null; }
  peers[id] = pc;
  if (localStream) localStream.getTracks().forEach(function (tr) { pc.addTrack(tr, localStream); });
  pc.onicecandidate = function (ev) {
    if (ev.candidate) sendWs({ type: 'voiceSignal', to: id, signal: { candidate: ev.candidate } });
  };
  pc.ontrack = function (ev) {
    var audio = new Audio(); audio.srcObject = ev.streams[0]; audio.autoplay = true; audio.play().catch(function () {});
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaElementSource(audio);
      var an = audioCtx.createAnalyser(); an.fftSize = 512;
      src.connect(an); an.connect(audioCtx.destination);
      analysers[id] = an;
    } catch (e) {}
  };
  pc.onconnectionstatechange = function () {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(id);
  };
  if (initiator) {
    pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer).then(function () {
      sendWs({ type: 'voiceSignal', to: id, signal: { type: 'offer', sdp: offer.sdp } });
    }); }).catch(function () {});
  }
  return pc;
}
function closePeer(id) {
  if (peers[id]) { try { peers[id].close(); } catch (e) {} delete peers[id]; }
  delete analysers[id]; delete speakingPeers[id];
}
function onVoiceSignal(from, signal) {
  if (!signal || !from || from === myId) return;
  var pc = createPeer(from, false); if (!pc) return;
  if (signal.type === 'offer') {
    pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp })).then(function () {
      return pc.createAnswer();
    }).then(function (ans) { return pc.setLocalDescription(ans).then(function () {
      sendWs({ type: 'voiceSignal', to: from, signal: { type: 'answer', sdp: ans.sdp } });
    }); }).catch(function () {});
  } else if (signal.type === 'answer') {
    pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp })).catch(function () {});
  } else if (signal.candidate) {
    pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(function () {});
  }
}
function checkSpeakingLevels() {
  if (!audioCtx) return;
  var buf = new Uint8Array(256), any = null;
  Object.keys(analysers).forEach(function (id) {
    analysers[id].getByteTimeDomainData(buf);
    var sum = 0; for (var i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - 128);
    if (sum / buf.length > 4) any = id;
  });
  var el = $('speaking');
  if (any) {
    var p = (room && room.players || []).filter(function (x) { return x.id === any; })[0];
    el.textContent = t('speaking') + (p ? p.name : any);
    el.classList.remove('hidden');
  } else el.classList.add('hidden');
}

/* ---------------- Forced landscape (mobile) ---------------- */
function updateForcedLandscape() {
  var inGameArea = inRoom && ($('lobby-screen').classList.contains('active') || $('game-screen').classList.contains('active'));
  var portrait = window.innerHeight > window.innerWidth;
  var force = isTouch && inGameArea && portrait;
  document.body.classList.toggle('force-landscape', force);
  if (force) setTimeout(onResize, 50);
}
/* Convert a screen-space touch delta to game-local delta under a 90deg CW
   container rotation: local dx = screen dy, local dy = -screen dx. */
function convertTouchDelta(dx, dy) {
  if (document.body.classList.contains('force-landscape')) return { x: dy, y: -dx };
  return { x: dx, y: dy };
}

/* ---------------- Input: keyboard / mouse ---------------- */
document.addEventListener('keydown', function (e) {
  var tag = (document.activeElement && document.activeElement.tagName) || '';
  chatTyping = tag === 'INPUT' || tag === 'TEXTAREA';
  if (chatTyping) {
    if (e.key === 'Escape') closeChat();
    return; // typing in chat must NOT move the character or shoot
  }
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); renderScoreboard((room && room.players || []).concat(room && room.bots || [])); $('scoreboard').classList.remove('hidden'); }
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Enter' && inMatch) { e.preventDefault(); openChat(); }
});
document.addEventListener('keyup', function (e) {
  keys[e.code] = false;
  if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
});
document.addEventListener('mousemove', function (e) {
  if (document.pointerLockElement !== $('game-canvas') || chatTyping || !inMatch) return;
  myPos.yaw -= e.movementX * 0.0022;
  myPos.pitch = Math.max(-1.5, Math.min(1.5, myPos.pitch - e.movementY * 0.0022));
});
document.addEventListener('mousedown', function (e) {
  if (e.button !== 0 || chatTyping || !inMatch || !myPos.alive) return;
  if (document.pointerLockElement !== $('game-canvas') && !isTouch) return;
  if (e.target.closest && e.target.closest('button, input, #chat-panel, #scoreboard, .hud-btns')) return;
  firing = true; semiFired = false; tryShoot();
});
document.addEventListener('mouseup', function (e) { if (e.button === 0) { firing = false; semiFired = false; } });
window.addEventListener('blur', function () { keys = {}; firing = false; });

/* ---------------- Input: mobile touch ---------------- */
function bindMobile() {
  var joyEl = $('joystick'), knob = $('joy-knob');
  function joyPos(t) {
    var r = joyEl.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var dx = t.clientX - cx, dy = t.clientY - cy;
    var m = Math.hypot(dx, dy), max = r.width / 2;
    if (m > max) { dx = dx / m * max; dy = dy / m * max; }
    knob.style.left = (35 + dx) + 'px'; knob.style.top = (35 + dy) + 'px';
    var local = convertTouchDelta(dx / max, dy / max);
    // joystick local: up (local -y) = forward; local x = strafe
    joy.fz = -local.y; joy.fx = local.x;
  }
  joyEl.addEventListener('touchstart', function (e) { e.preventDefault(); joy.active = true; joy.id = e.changedTouches[0].identifier; joyPos(e.changedTouches[0]); }, { passive: false });
  joyEl.addEventListener('touchmove', function (e) { e.preventDefault(); for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === joy.id) joyPos(e.changedTouches[i]); }, { passive: false });
  function joyEnd(e) { for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === joy.id) { joy.active = false; joy.fx = 0; joy.fz = 0; knob.style.left = '35px'; knob.style.top = '35px'; } }
  joyEl.addEventListener('touchend', joyEnd); joyEl.addEventListener('touchcancel', joyEnd);

  var canvas = $('game-canvas');
  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var tch = e.changedTouches[i];
      if (tch.clientX > window.innerWidth * 0.4 && !lookTouch.active) {
        lookTouch.active = true; lookTouch.id = tch.identifier; lookTouch.lx = tch.clientX; lookTouch.ly = tch.clientY;
      }
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var tch = e.changedTouches[i];
      if (lookTouch.active && tch.identifier === lookTouch.id) {
        var d = convertTouchDelta(tch.clientX - lookTouch.lx, tch.clientY - lookTouch.ly);
        myPos.yaw -= d.x * 0.004;
        myPos.pitch = Math.max(-1.5, Math.min(1.5, myPos.pitch - d.y * 0.004));
        lookTouch.lx = tch.clientX; lookTouch.ly = tch.clientY;
      }
    }
  }, { passive: false });
  function lookEnd(e) { for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === lookTouch.id) lookTouch.active = false; }
  canvas.addEventListener('touchend', lookEnd); canvas.addEventListener('touchcancel', lookEnd);

  var fireBtn = $('btn-fire');
  fireBtn.addEventListener('touchstart', function (e) { e.preventDefault(); if (inMatch && myPos.alive && !chatTyping) { firing = true; semiFired = false; tryShoot(); } }, { passive: false });
  fireBtn.addEventListener('touchend', function (e) { e.preventDefault(); firing = false; semiFired = false; }, { passive: false });
  $('btn-jump').addEventListener('touchstart', function (e) { e.preventDefault(); /* no jump physics in v1 protocol; visual hop */ if (camera) camera.position.y = 1.9; setTimeout(function () { if (camera) camera.position.y = 1.7; }, 180); }, { passive: false });
  $('btn-reload').addEventListener('touchstart', function (e) { e.preventDefault(); startReload(); }, { passive: false });
}

/* ---------------- Buttons / wiring ---------------- */
function doCreate() {
  myName = $('player-name').value.trim();
  if (!myName) { setStatus(t('enterName')); $('player-name').focus(); return; }
  localStorage.setItem('pb_name', myName);
  localStorage.setItem('pb_map', $('map-select').value); sel.map = $('map-select').value;
  localStorage.setItem('pb_mode', $('mode-select').value); sel.mode = $('mode-select').value;
  ensureWs(function () { sendWs({ type: 'createRoom', name: myName, map: sel.map, mode: sel.mode, team: sel.team, character: sel.character, weapon: sel.weapon }); });
}
function doJoin() {
  myName = $('player-name').value.trim();
  var code = $('room-code').value.trim().toUpperCase();
  if (!myName || code.length !== 4) { setStatus(t('needNameCode')); return; }
  localStorage.setItem('pb_name', myName);
  ensureWs(function () { sendWs({ type: 'joinRoom', code: code, name: myName, team: sel.team, character: sel.character, weapon: sel.weapon }); });
}
function leaveRoom() {
  wantReconnect = false; inRoom = false; inMatch = false;
  clearTimeout(reconnectTimer);
  sendWs({ type: 'leaveRoom' });
  stopMic(); exitPointerLock();
  document.body.classList.remove('force-landscape');
  room = null; roomCode = null; lastJoin = null;
  Object.keys(remotePlayers).forEach(removeSoldier); remotePlayers = {}; hitMeshes = [];
  $('match-end').classList.add('hidden'); $('respawn-overlay').classList.add('hidden');
  showScreen('menu'); setStatus(t('leftRoom'));
}
function wire() {
  $('player-name').value = myName;
  $('lang-id').onclick = function () { setLang('id'); };
  $('lang-en').onclick = function () { setLang('en'); };
  $('map-select').onchange = function (e) { sel.map = e.target.value; localStorage.setItem('pb_map', sel.map); };
  $('mode-select').onchange = function (e) { sel.mode = e.target.value; localStorage.setItem('pb_mode', sel.mode); renderAllSelectors(); };
  $('team-seg').querySelectorAll('button').forEach(function (b) { b.onclick = function () { setTeam(b.getAttribute('data-team')); }; });
  $('lobby-team-seg').querySelectorAll('button').forEach(function (b) { b.onclick = function () { setTeam(b.getAttribute('data-team'), true); }; });
  $('btn-create').onclick = doCreate;
  $('btn-join').onclick = doJoin;
  $('room-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
  $('player-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') doCreate(); });
  $('btn-leave').onclick = leaveRoom;
  $('btn-start').onclick = function () { sendWs({ type: 'startMatch' }); };
  $('btn-chat').onclick = function () { chatOpen ? closeChat() : openChat(); };
  $('btn-mic').onclick = toggleMic;
  $('btn-score').onclick = function () {
    var sb = $('scoreboard');
    if (sb.classList.contains('hidden')) { renderScoreboard((room && room.players || []).concat(room && room.bots || [])); sb.classList.remove('hidden'); }
    else sb.classList.add('hidden');
  };
  $('btn-quit').onclick = leaveRoom;
  $('btn-back-lobby').onclick = function () {
    inMatch = false; $('match-end').classList.add('hidden'); showLobby();
  };
  $('chat-send').onclick = sendChat;
  $('chat-close').onclick = closeChat;
  $('chat-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    if (e.key === 'Escape') closeChat();
    e.stopPropagation();
  });
  window.addEventListener('resize', updateForcedLandscape);
  window.addEventListener('orientationchange', function () { setTimeout(updateForcedLandscape, 300); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) updateForcedLandscape(); });
}

/* ---------------- Boot ---------------- */
applyI18n();
renderAllSelectors();
wire();
bindMobile();
updateAmmoHud();
$('weapon-name').textContent = WEAPONS[sel.weapon].name;
})();
