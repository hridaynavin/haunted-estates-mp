// Multiplayer client: pure render + intent-sender. All game rules live on
// the server (see server/gameEngine.js) — this file never decides anything,
// it only displays whatever `state` the server sends and forwards user
// actions as `intent`/`build`/`end_turn`/etc. socket messages.
(function(){
'use strict';

// ---------------------------------------------------------------------------
// CONNECTION / SESSION
// ---------------------------------------------------------------------------
const socket = io('https://haunted-estates.onrender.com');
let roomCode = null, myToken = null, mySeatId = null, isSpectator = false, hostSeatId = null;
let latestState = null;
let tokenEls = {};
let lastPositions = {}; // seatId -> last known position, for hop animation on 'move' events

function lsKey(code){ return 'he_token_' + code; }

// ---------------------------------------------------------------------------
// START / LOBBY SCREEN
// ---------------------------------------------------------------------------
const startScreen = document.getElementById('start-screen');
const lobbyCard = document.getElementById('lobby-card');
const hostPanel = document.getElementById('host-panel');
const joinPanel = document.getElementById('join-panel');

function setStartTab(tab){
  document.getElementById('tab-host').classList.toggle('active', tab==='host');
  document.getElementById('tab-join').classList.toggle('active', tab==='join');
  document.getElementById('tab-bots').classList.toggle('active', tab==='bots');
  hostPanel.style.display = (tab==='host'||tab==='bots') ? '' : 'none';
  joinPanel.style.display = (tab==='join') ? '' : 'none';
  document.getElementById('play-btn').style.display = (tab==='host') ? '' : 'none';
  document.getElementById('play-bots-btn').style.display = (tab==='bots') ? '' : 'none';
  document.getElementById('host-panel-hint').style.display = (tab==='host') ? '' : 'none';
  document.getElementById('bots-panel-hint').style.display = (tab==='bots') ? '' : 'none';
}
document.getElementById('tab-host').onclick = ()=> setStartTab('host');
document.getElementById('tab-join').onclick = ()=> setStartTab('join');
document.getElementById('tab-bots').onclick = ()=> setStartTab('bots');

let seats=4, startCash=1500, reviveThreshold=800;
document.getElementById('dec-seats').onclick=()=>{ seats=Math.max(2,seats-1); document.getElementById('seats-label').textContent=seats; };
document.getElementById('inc-seats').onclick=()=>{ seats=Math.min(6,seats+1); document.getElementById('seats-label').textContent=seats; };
document.getElementById('dec-cash').onclick=()=>{ startCash=Math.max(500,startCash-100); document.getElementById('cash-label').textContent='$'+startCash; };
document.getElementById('inc-cash').onclick=()=>{ startCash=Math.min(3000,startCash+100); document.getElementById('cash-label').textContent='$'+startCash; };
document.getElementById('dec-revive').onclick=()=>{ reviveThreshold=Math.max(300,reviveThreshold-100); document.getElementById('revive-label').textContent='$'+reviveThreshold; };
document.getElementById('inc-revive').onclick=()=>{ reviveThreshold=Math.min(2000,reviveThreshold+100); document.getElementById('revive-label').textContent='$'+reviveThreshold; };

document.getElementById('play-btn').onclick=()=>{
  const name = document.getElementById('name-input').value.trim() || 'Host';
  socket.emit('create_room', {name, maxSeats:seats, startingCash:startCash, reviveThreshold}, (res)=>{
    if (!res.ok){ alert(res.error||'Could not create room.'); return; }
    onJoined(res);
  });
};
document.getElementById('play-bots-btn').onclick=()=>{
  const name = document.getElementById('name-input').value.trim() || 'Host';
  socket.emit('create_room', {name, maxSeats:seats, startingCash:startCash, reviveThreshold}, (res)=>{
    if (!res.ok){ alert(res.error||'Could not create room.'); return; }
    roomCode = res.roomCode;
    hostSeatId = res.hostSeatId;
    mySeatId = res.seatId;
    myToken = res.token;
    localStorage.setItem(lsKey(roomCode), myToken);
    history.replaceState(null, '', '?room='+roomCode);
    // Skip the lobby entirely — the incoming 'state' broadcast (started:true)
    // flips the UI straight to the game screen once the server processes this.
    socket.emit('start_game', {roomCode, token: myToken});
  });
};
document.getElementById('join-btn').onclick=()=>{
  const name = document.getElementById('name-input-join').value.trim() || 'Player';
  const code = document.getElementById('code-input').value.trim().toLowerCase();
  if (!code) return;
  socket.emit('join_room', {roomCode:code, name}, (res)=>{
    if (!res.ok){ alert(res.error||'Could not join that room.'); return; }
    onJoined(res);
  });
};

function onJoined(res){
  roomCode = res.roomCode;
  hostSeatId = res.hostSeatId;
  if (res.spectator){
    isSpectator = true;
    document.getElementById('spectator-banner').style.display='block';
    if (res.started) showGameScreen();
    else showLobby();
    return;
  }
  mySeatId = res.seatId;
  myToken = res.token;
  localStorage.setItem(lsKey(roomCode), myToken);
  history.replaceState(null, '', '?room='+roomCode);
  if (res.started) showGameScreen();
  else showLobby();
}

function showLobby(){
  startScreen.querySelector('.start-card').style.display = 'none';
  document.getElementById('join-panel').parentElement.style.display = 'none';
  lobbyCard.style.display = '';
  const link = location.origin + location.pathname + '?room=' + roomCode;
  document.getElementById('share-link').value = link;
  document.getElementById('start-game-btn').style.display = (mySeatId===hostSeatId) ? '' : 'none';
  document.getElementById('lobby-hint').style.display = (mySeatId===hostSeatId) ? 'none' : '';
}
document.getElementById('copy-link-btn').onclick = ()=>{
  const el = document.getElementById('share-link');
  el.select();
  navigator.clipboard && navigator.clipboard.writeText(el.value).catch(()=>{});
  const btn = document.getElementById('copy-link-btn');
  const old = btn.textContent; btn.textContent='Copied!'; setTimeout(()=>btn.textContent=old, 1200);
};
document.getElementById('start-game-btn').onclick = ()=>{
  socket.emit('start_game', {roomCode, token: myToken});
};

function renderLobbySeats(state){
  const el = document.getElementById('lobby-seats');
  el.innerHTML = state.seats.map(s=>{
    const human = !s.isBot;
    return `<div class="seat-row ${human?'human':''}"><span class="dot" style="background:${s.color}"></span>
      <span>${s.name}</span><span class="tag">${s.id===state.yourSeatId?'(you)':''} ${human?(s.connected?'connected':'offline'):'bot'}</span></div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// AUTO-JOIN FROM URL (?room=CODE), with reconnect if we have a saved token
// ---------------------------------------------------------------------------
(function autoJoin(){
  const params = new URLSearchParams(location.search);
  const code = (params.get('room')||'').toLowerCase();
  if (!code) return;
  const savedToken = localStorage.getItem(lsKey(code));
  if (savedToken){
    socket.emit('reconnect_room', {roomCode:code, token:savedToken}, (res)=>{
      if (res.ok) onJoined(res);
      else { document.getElementById('tab-join').click(); document.getElementById('code-input').value = code; }
    });
  } else {
    document.getElementById('tab-join').click();
    document.getElementById('code-input').value = code;
  }
})();

// ---------------------------------------------------------------------------
// GAME SCREEN SETUP
// ---------------------------------------------------------------------------
function showGameScreen(){
  startScreen.style.display = 'none';
  document.getElementById('game-screen').style.display = 'flex';
  document.getElementById('room-code-badge').textContent = 'room: ' + roomCode;
  createBoardTiles();
}

// ---------------------------------------------------------------------------
// BOARD RENDERING (ported from the single-player client's tile/token system)
// ---------------------------------------------------------------------------
function isCorner(i){ return i===0||i===10||i===20||i===30; }
function tilePos(i){
  if (i<=10) return {row:11, col:11-i};
  if (i<=20) return {row:11-(i-10), col:1};
  if (i<=30) return {row:1, col:1+(i-20)};
  return {row:1+(i-30), col:11};
}
const TILE_ICON_NAME = {
  go:'flag', jail:'crypt', gotojail:'warning', vacation:'shore', tax:'coin',
  fate:'crystalball', omen:'moon', railroad:'plane', utility:'bolt',
};
function tileIcon(tile){
  const name = TILE_ICON_NAME[tile.type];
  return name ? Icon(name) : '';
}
let boardBuilt = false;
function createBoardTiles(){
  if (boardBuilt) return;
  boardBuilt = true;
  const board = document.getElementById('board');
  const CORNER_CLASS = {go:'corner-go', jail:'corner-jail', vacation:'corner-vacation', gotojail:'corner-gotojail'};
  BOARD.forEach((tile,i)=>{
    const pos = tilePos(i);
    const el = document.createElement('div');
    el.className = 'tile'+(isCorner(i)?' corner '+(CORNER_CLASS[tile.type]||''):'');
    el.style.gridRow = pos.row; el.style.gridColumn = pos.col;
    el.dataset.i = i; el.dataset.type = tile.type;
    const grpColor = tile.group ? GROUPS[tile.group].color : (tile.type==='railroad'?'#9aa0b8':tile.type==='utility'?'#c9c98a':null);
    if (grpColor) el.style.setProperty('--tile-accent', grpColor+'aa');
    if (isCorner(i)){
      el.innerHTML = `<div class="corner-icon">${tileIcon(tile)}</div><div class="nm">${tile.name}</div>`;
    } else if (tile.type==='fate' || tile.type==='omen'){
      el.innerHTML = `<div class="card-face"><span class="card-emoji">${tileIcon(tile)}</span></div><div class="nm" style="text-align:center;">${tile.name}</div>`;
    } else {
      el.innerHTML = `${grpColor?`<div class="grp" style="background:${grpColor}"></div>`:''}
        <div class="nm">${tile.flag || tileIcon(tile)} ${tile.name}</div>
        ${tile.price?`<div class="px">$${tile.price}</div>`:''}
        <div class="houses"></div><div class="owner-bar"></div>`;
    }
    el.onclick = ()=>showTileInfo(i);
    board.insertBefore(el, document.getElementById('center'));
  });
}

function renderTiles(state){
  BOARD.forEach((tile,i)=>{
    const el = document.querySelector(`.tile[data-i="${i}"]`);
    if (!el) return;
    const ts = state.tileState[i];
    el.classList.toggle('mortgaged', !!ts.mortgaged);
    const ownerBar = el.querySelector('.owner-bar');
    if (ownerBar){
      const owner = ts.owner!=null ? state.seats.find(s=>s.id===ts.owner) : null;
      ownerBar.style.background = owner ? owner.color : 'transparent';
    }
    const housesEl = el.querySelector('.houses');
    if (housesEl) housesEl.innerHTML = houseBadge(ts.houses);
  });
  document.getElementById('vacation-pot').textContent = `Vacation Pot: $${state.vacationPot}`;
  updateTokenLayer(state);
}

// ---- token overlay (percentage-based, glides tile-to-tile) ----
function computeTileCenterPercent(i){
  const pos = tilePos(i);
  return { leftPct:(pos.col-0.5)/11*100, topPct:(pos.row-0.5)/11*100 };
}
function getTokenEl(seat){
  if (tokenEls[seat.id]) return tokenEls[seat.id];
  const el = document.createElement('div');
  el.className = 'board-token';
  el.style.background = seat.color;
  const label = seat.name.match(/\d+/)?.[0] || seat.name[0] || '?';
  el.innerHTML = `<span class="tok-initial">${label}</span>`;
  document.getElementById('token-layer').appendChild(el);
  tokenEls[seat.id] = el;
  return el;
}
function positionTokenEl(el, tileIndex, offsetIndex, offsetCount){
  const {leftPct, topPct} = computeTileCenterPercent(tileIndex);
  const r = offsetCount>1 ? 2.0 : 0;
  const angle = offsetCount>1 ? (offsetIndex/offsetCount)*Math.PI*2 : 0;
  el.style.left = (leftPct + Math.cos(angle)*r) + '%';
  el.style.top = (topPct + Math.sin(angle)*r) + '%';
}
function updateTokenLayer(state){
  const byTile = {};
  for (const s of state.seats){ if (s.isGhost) continue; (byTile[s.position]=byTile[s.position]||[]).push(s); }
  for (const s of state.seats){
    const el = getTokenEl(s);
    if (s.isGhost){ el.style.display='none'; continue; }
    el.style.display='';
    const group = byTile[s.position];
    positionTokenEl(el, s.position, group.indexOf(s), group.length);
    el.classList.toggle('active-tok', s.id===state.currentIndex);
    lastPositions[s.id] = s.position;
  }
}
async function animateTokenHop(seatId, fromPos, toPos){
  const seat = latestState && latestState.seats.find(s=>s.id===seatId);
  if (!seat) return;
  let steps = toPos-fromPos; if (steps<0) steps+=40;
  if (steps===0) return;
  const el = getTokenEl(seat);
  el.style.display='';
  const hopMs = Math.max(22, Math.min(90, Math.round(480/steps)));
  for (let s=1;s<=steps;s++){
    positionTokenEl(el, (fromPos+s)%40, 0, 1);
    await sleep(hopMs);
  }
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// SIDE PANEL (Players / Actions / Trades / Properties I Own)
// ---------------------------------------------------------------------------
function ownedTiles(state, seatId){ const r=[]; BOARD.forEach((t,i)=>{ if (state.tileState[i].owner===seatId) r.push(i); }); return r; }
function netWorth(state, seat){
  let v = seat.cash||0;
  for (const i of ownedTiles(state, seat.id)){
    const t=BOARD[i], ts=state.tileState[i];
    v += ts.mortgaged ? Math.round(t.price*0.5) : t.price;
    if (ts.houses>0 && GROUPS[t.group]) v += ts.houses*GROUPS[t.group].houseCost*0.5;
  }
  return v;
}
function renderSidePanel(state){
  const panel = document.getElementById('side-panel');
  const me = state.seats.find(s=>s.id===state.yourSeatId);
  const living = state.seats.filter(s=>!s.isGhost);
  let richest=null;
  for (const s of living) if (!richest || netWorth(state,s)>netWorth(state,richest)) richest=s;

  const playerRows = state.seats.map(s=>{
    const isActive = s.id===state.currentIndex;
    const label = s.name.match(/\d+/)?.[0] || s.name[0] || '?';
    const avatar = `<span class="avatar ${(!s.isBot && !s.connected)?'offline':''}" style="background:${s.color}">${label}</span>`;
    const crown = richest===s ? `<span class="crown" title="Richest player">${Icon('crown')}</span>` : '';
    const botBadge = s.isBot ? `<span class="badge bot">${(s.wasHuman && s.connected===false)?Icon('ghost')+' bot (disc.)':'bot'}</span>` : '';
    if (s.isGhost && s.id!==state.yourSeatId){
      return `<div class="player-row ${isActive?'active':''}"><span class="avatar" style="background:${s.color}">?</span>
        <div class="pmain"><div class="pname">${s.name}<span class="badge ghost">${Icon('ghost')} Ghost</span></div></div></div>`;
    }
    const jailBadge = s.inJail ? '<span class="badge jail">Crypt</span>' : '';
    const ghostBadge = s.isGhost ? `<span class="badge ghost">${Icon('ghost')} $${s.spiritFund}</span>` : '';
    return `<div class="player-row ${isActive?'active':''}">${avatar}
      <div class="pmain"><div class="pname">${s.name}${crown}${jailBadge}${ghostBadge}${!s.isBot?'':botBadge}</div>
      <div class="pinfo">${ownedTiles(state,s.id).length} propert${ownedTiles(state,s.id).length===1?'y':'ies'}${s.jailCards>0?` &middot; ${s.jailCards} card`:''}</div></div>
      <div class="pcash">$${s.cash!=null?s.cash:'—'}</div></div>`;
  }).join('');

  const gated = isSpectator || !me || state.gameOver || me.isGhost || state.currentIndex!==me.id || !state.canActNow;
  const actionsHtml = (!isSpectator && me) ? `
    <button class="full danger" id="concede-btn" ${gated?'disabled':''}>${Icon('whiteflag')} Concede</button>
    <div class="empty-hint">${state.gameOver?'Game over':me.isGhost?"You're a Ghost":(state.canActNow && state.currentIndex===me.id)?'Available now':'Available on your turn'}</div>` : '';

  const recentTrades = (state.tradeHistory||[]).slice(0,5).map(t=>
    `<div class="trade-row"><b>${t.from}</b> ⇄ <b>${t.to}</b> &nbsp;${t.accepted?Icon('check'):Icon('cross')}</div>`
  ).join('') || '<div class="empty-hint">No trades yet.</div>';
  const tradesHtml = `${(!isSpectator && me)?`<button class="full" id="create-trade-btn" ${gated?'disabled':''}>${Icon('handshake')} Create Trade</button>`:''}
    <div id="trade-list">${recentTrades}</div>`;

  const ownedHtml = (!isSpectator && me) ? (ownedTiles(state, me.id).map(i=>{
    const t=BOARD[i], ts=state.tileState[i];
    return `<div class="owned-row"><span>${t.flag||''}</span><span class="oname">${t.name}</span><span>${houseBadge(ts.houses)}${ts.mortgaged?' '+Icon('lock'):''}</span></div>`;
  }).join('') || '<div class="empty-hint">You own no properties yet.</div>') : '<div class="empty-hint">Spectating.</div>';

  panel.innerHTML = `
    <div class="panel-box"><h4>${Icon('crown')} Players</h4>${playerRows}</div>
    ${(!isSpectator)?`<div class="panel-box"><h4>${Icon('whiteflag')} Actions</h4>${actionsHtml}</div>`:''}
    <div class="panel-box"><h4>${Icon('handshake')} Trades</h4>${tradesHtml}</div>
    <div class="panel-box"><h4>${Icon('estate')} Properties I Own</h4><div id="owned-list">${ownedHtml}</div></div>`;

  if (!isSpectator && me){
    const cb = document.getElementById('concede-btn');
    if (cb) cb.onclick = ()=>confirmConcede();
    const tb = document.getElementById('create-trade-btn');
    if (tb) tb.onclick = ()=>openTradeModal(state);
  }
}

// ---------------------------------------------------------------------------
// LOG
// ---------------------------------------------------------------------------
let renderedLogCount = 0;
function renderLog(state){
  const el = document.getElementById('log');
  const entries = state.log || [];
  if (entries.length < renderedLogCount) { el.innerHTML=''; renderedLogCount=0; } // state resync guard
  for (let i=renderedLogCount; i<entries.length; i++){
    const d = document.createElement('div');
    d.className = 'log-entry';
    d.innerHTML = highlightLogText(entries[i].text, state);
    el.appendChild(d);
  }
  renderedLogCount = entries.length;
  el.scrollTop = el.scrollHeight;
}
function highlightLogText(msg, state){
  let html = escapeHtml(msg).replace(/\$(\d+)/g, '<span class="log-money">$$$1</span>');
  for (const s of state.seats){
    const esc = s.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    html = html.replace(new RegExp(`\\b${esc}\\b`,'g'), `<span style="color:${s.color};font-weight:bold;">${s.name}</span>`);
  }
  return html;
}
function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ---------------------------------------------------------------------------
// TURN BANNER
// ---------------------------------------------------------------------------
let lastTurnBannerText = null;
function renderTurnBanner(state){
  const el = document.getElementById('turn-banner');
  const text = state.gameOver ? 'Game over' : (()=>{
    const cur = state.seats[state.currentIndex];
    const you = cur.id===state.yourSeatId;
    return cur.isGhost ? `${you?'Your':cur.name+"'s"} Ghost Turn` : `${you?'Your':cur.name+"'s"} Turn`;
  })();
  if (!state.gameOver){
    const cur = state.seats[state.currentIndex];
    el.innerHTML = cur.isGhost ? `${Icon('ghost')} ${text}` : text;
  } else {
    el.textContent = text;
  }
  if (text !== lastTurnBannerText){
    lastTurnBannerText = text;
    el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
  }
  document.body.classList.toggle('ghost-turn', !state.gameOver && !!state.seats[state.currentIndex].isGhost);
}

// ---------------------------------------------------------------------------
// MODAL SYSTEM (identical pattern to the single-player client)
// ---------------------------------------------------------------------------
function showRawModal(html){
  const content = document.getElementById('modal-content');
  content.innerHTML = html;
  content.classList.remove('card-reveal');
  document.getElementById('modal-backdrop').classList.add('show');
}
function closeModal(){ document.getElementById('modal-backdrop').classList.remove('show'); }
function askModal(headerHtml, options){
  return new Promise(resolve=>{
    const btns = options.map((o,idx)=>`<button data-idx="${idx}" class="${o.secondary?'secondary':''}" ${o.disabled?'disabled':''}>${o.label}</button>`).join('');
    showRawModal(`${headerHtml}<div class="btnrow">${btns}</div>`);
    document.querySelectorAll('#modal-content .btnrow button').forEach((b,idx)=>{
      b.onclick = ()=>{ closeModal(); resolve(options[idx].value); };
    });
  });
}
function showTileInfo(i){
  const t=BOARD[i], ts = latestState ? latestState.tileState[i] : null;
  let body = `<h3><span class="icon-row">${t.flag ? `<span>${t.flag}</span>` : tileIcon(t)}</span> ${t.name}${t.country?`, ${t.country}`:''}</h3>`;
  if (t.type==='property'){
    body += `<p>${GROUPS[t.group].name} group &middot; Price $${t.price}</p>
      <p>Rent: $${t.rent[0]} base (double if owner has the full group unimproved)<br>
      1 house: $${t.rent[1]} &middot; 2: $${t.rent[2]} &middot; 3: $${t.rent[3]} &middot; 4: $${t.rent[4]} &middot; Hotel: $${t.rent[5]}<br>
      House cost: $${GROUPS[t.group].houseCost} &middot; Mortgage value: $${t.mortgage}</p>`;
  } else if (t.type==='railroad'){
    body += `<p>Price $${t.price} &middot; Rent: $25/$50/$100/$200 for 1-4 owned &middot; Mortgage value: $${t.mortgage}</p>`;
  } else if (t.type==='utility'){
    body += `<p>Price $${t.price} &middot; Rent: 4&times;/10&times; dice roll &middot; Mortgage value: $${t.mortgage}</p>`;
  } else if (t.type==='tax'){
    body += `<p>Pay $${t.amount} into the Vacation Pot.</p>`;
  } else if (t.type==='vacation'){
    body += `<p>Landing here collects the entire Vacation Pot, plus a $100 bonus.</p>`;
  } else {
    body += `<p>${t.type==='fate'?'Draw a Fate card.':t.type==='omen'?'Draw an Omen card.':t.type==='jail'?'Just visiting — unless sent here.':t.type==='gotojail'?'Sends whoever lands here to the Crypt.':'Collect $200 landing on or passing Departure.'}</p>`;
  }
  if (t.price && ts){
    const owner = ts.owner!=null ? latestState.seats.find(s=>s.id===ts.owner) : null;
    body += owner ? `<p style="color:${owner.color}">Owned by ${owner.name}${ts.mortgaged?' (mortgaged)':''}${ts.houses>0?` &middot; ${ts.houses>=5?'Hotel':ts.houses+' house(s)'}`:''}</p>` : `<p style="color:var(--dim)">Unowned</p>`;
  }
  showRawModal(body+`<div class="btnrow"><button class="secondary" id="ti-close">Close</button></div>`);
  document.getElementById('ti-close').onclick = closeModal;
}
document.getElementById('rules-btn').onclick = ()=>{
  showRawModal(`<h3>How to Play</h3>
    <p><b>Classic rules:</b> Roll 2d6, move, buy or pay rent, build once you own a full color group, mortgage when short, 3 doubles sends you to the Crypt, Vacation pays out the tax pot.</p>
    <p><b>Ghosts:</b> Go bankrupt (or concede) and become a Ghost. Haunt one tile a turn in secret — land on it and a random spooky effect triggers, revealing you. Earn enough spirit fund to revive.</p>
    <p><b>Multiplayer:</b> This room is server-authoritative — everyone sees the same live board. If you disconnect, a bot pilots your seat until you reconnect with the same link.</p>
    <div class="btnrow"><button class="secondary" id="rules-close">Close</button></div>`);
  document.getElementById('rules-close').onclick = closeModal;
};
document.getElementById('ledger-btn').onclick = ()=>{
  if (!latestState) return;
  const state = latestState;
  let html = `<h3>${Icon('scroll')} Ledger</h3><h4 style="color:var(--gold);margin:8px 0 6px;">Property Ownership</h4>`;
  for (const s of state.seats){
    if (s.isGhost) continue;
    const owned = ownedTiles(state, s.id);
    html += `<div style="margin-bottom:10px;"><b style="color:${s.color}">${s.name}</b> — ${owned.length} propert${owned.length===1?'y':'ies'}<br>`;
    html += owned.length ? `<span style="font-size:11.5px;color:var(--dim);">${owned.map(i=>{
      const t=BOARD[i], ts=state.tileState[i];
      return `${t.flag||''} ${t.name}${ts.mortgaged?' '+Icon('lock'):''} ${houseBadge(ts.houses)}`;
    }).join(', ')}</span>` : `<span style="font-size:11.5px;color:var(--dim);">none</span>`;
    html += `</div>`;
  }
  html += `<h4 style="color:var(--gold);margin:14px 0 6px;">Trade History</h4>`;
  html += (state.tradeHistory||[]).length===0 ? `<p style="color:var(--dim);font-size:12.5px;">No trades yet.</p>` :
    state.tradeHistory.slice(0,25).map(t=>{
      const fromStr = [t.fromProps.join(', '), t.fromCash?`$${t.fromCash}`:''].filter(Boolean).join(' + ') || 'nothing';
      const toStr = [t.toProps.join(', '), t.toCash?`$${t.toCash}`:''].filter(Boolean).join(' + ') || 'nothing';
      return `<div style="font-size:12px;color:${t.accepted?'var(--ink)':'var(--dim)'};margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.08);">
        <b>${t.from}</b> → <b>${t.to}</b>: offered [${fromStr}] for [${toStr}] — ${t.accepted?'<span style="color:var(--accent2)">accepted</span>':'<span style="color:var(--danger)">rejected</span>'}</div>`;
    }).join('');
  showRawModal(html+`<div class="btnrow"><button class="secondary" id="ledger-close">Close</button></div>`);
  document.getElementById('ledger-close').onclick = closeModal;
};

// ---------------------------------------------------------------------------
// ACTION ROW (roll / build / trade / end turn depend on the current prompt)
// ---------------------------------------------------------------------------
function setActionButtons(list){
  const row = document.getElementById('action-row');
  row.innerHTML = '';
  for (const b of list){
    const btn = document.createElement('button');
    btn.innerHTML = b.label;
    if (b.secondary) btn.classList.add('secondary');
    btn.onclick = b.onClick;
    row.appendChild(btn);
  }
}
function sendIntent(type, payload){ socket.emit('intent', {roomCode, token:myToken, type, payload}); }

// ---------------------------------------------------------------------------
// PROMPT HANDLING — the server tells us exactly what input it's waiting for
// ---------------------------------------------------------------------------
socket.on('prompt', (p)=>{
  if (isSpectator) return; // shouldn't happen, but never let a spectator drive input
  switch (p.type){
    case 'roll_dice':
      setActionButtons([{label:`${Icon('dice')} Roll Dice`, onClick: ()=>{ setActionButtons([]); sendIntent('roll_dice', true); }}]);
      break;
    case 'post_move':
      setActionButtons([
        {label:`${Icon('house')} Build`, secondary:true, onClick: ()=>openManageModal()},
        {label:`${Icon('handshake')} Trade`, secondary:true, onClick: ()=>openTradeModal(latestState)},
        {label:'End Turn', onClick: ()=>{ setActionButtons([]); socket.emit('end_turn', {roomCode, token:myToken}); }},
      ]);
      break;
    case 'jail_choice': {
      const opts=[];
      if (p.payload.opts.includes('card')) opts.push({label:'Use Return Home Free card', value:'card'});
      opts.push({label:'Pay $50 to leave', value:'pay', disabled:!p.payload.canPay});
      opts.push({label:'Roll for doubles', value:'roll'});
      askModal(`<h3>${Icon('crypt')} In the Crypt</h3><p>Attempt ${p.payload.attempt} of 3.</p>`, opts).then(v=>sendIntent('jail_choice', v));
      break;
    }
    case 'buy_decision': {
      const t = BOARD[p.payload.tileIndex];
      askModal(`<h3>${t.flag||tileIcon(t)} ${t.name}${t.country?`, ${t.country}`:''}</h3><p>${t.group?GROUPS[t.group].name+' group':''} &middot; Price $${p.payload.price}</p>`,
        [{label:`Buy for $${p.payload.price}`, value:true, disabled:!p.payload.canAfford},
         {label:'Pass (go to auction)', value:false, secondary:true}]).then(v=>sendIntent('buy_decision', v));
      break;
    }
    case 'auction_bid': {
      const t = BOARD[p.payload.tileIndex];
      const bidderName = p.payload.currentBidderId!=null ? (latestState.seats.find(s=>s.id===p.payload.currentBidderId)||{}).name : null;
      askModal(`<h3>Auction: ${t.flag||''} ${t.name}</h3><p>Current bid: $${p.payload.currentBid}${bidderName?(' by '+bidderName):''}</p>`,
        [{label:`Bid $${p.payload.currentBid+10}`, value:true, disabled:!p.payload.canBid},
         {label:'Pass', value:false, secondary:true}]).then(v=>sendIntent('auction_bid', v));
      break;
    }
    case 'manage_assets': openForcedAssetModal(p.payload); break;
    case 'revive_choice':
      askModal(`<h3>${Icon('sparkle')} The Veil Thins...</h3><p>Your spirit fund is $${p.payload.spiritFund} — enough to return with fresh cash and no properties. Revive now?</p>`,
        [{label:'Revive!', value:true},{label:'Stay a ghost, haunt again', value:false, secondary:true}]).then(v=>sendIntent('revive_choice', v));
      break;
    case 'haunt_choice': openHauntModal(p.payload); break;
    case 'review_trade': openReviewTradeModal(p.payload); break;
  }
});

// ---------------------------------------------------------------------------
// BUILD / MORTGAGE MODAL
// ---------------------------------------------------------------------------
function isTradeable(state, i){ return state.tileState[i].houses===0; }
function groupHasMortgage(state, group){ return groupTiles(group).some(j=>state.tileState[j].mortgaged); }
function ownerHasFullGroup(state, seatId, group){ return groupTiles(group).every(j=>state.tileState[j].owner===seatId); }
function isLowestInGroup(state, i){ const g=BOARD[i].group; const min=Math.min(...groupTiles(g).map(j=>state.tileState[j].houses)); return state.tileState[i].houses===min; }
function isHighestInGroup(state, i){ const g=BOARD[i].group; const max=Math.max(...groupTiles(g).map(j=>state.tileState[j].houses)); return state.tileState[i].houses===max; }

function openManageModal(){
  function render(){
    const state = latestState, me = state.seats.find(s=>s.id===mySeatId);
    const owned = ownedTiles(state, mySeatId);
    const rows = owned.map(i=>{
      const t=BOARD[i], ts=state.tileState[i];
      let actions='';
      if (t.type==='property'){
        if (ownerHasFullGroup(state,mySeatId,t.group) && !groupHasMortgage(state,t.group) && ts.houses<5 &&
            isLowestInGroup(state,i) && me.cash>=GROUPS[t.group].houseCost && !ts.mortgaged){
          actions += `<button data-act="build" data-i="${i}">Build (-$${GROUPS[t.group].houseCost})</button>`;
        }
        if (ts.houses>0 && isHighestInGroup(state,i)){
          actions += `<button data-act="sell" data-i="${i}">Sell house (+$${Math.floor(GROUPS[t.group].houseCost/2)})</button>`;
        }
      }
      if (!ts.mortgaged && ts.houses===0) actions += `<button data-act="mortgage" data-i="${i}">Mortgage (+$${t.mortgage})</button>`;
      if (ts.mortgaged){
        const cost = Math.round(t.mortgage*1.1);
        actions += `<button data-act="unmortgage" data-i="${i}" ${me.cash<cost?'disabled':''}>Unmortgage (-$${cost})</button>`;
      }
      return `<div class="asset-row"><span>${t.flag||''} ${t.name}${ts.mortgaged?' '+Icon('lock'):''} ${houseBadge(ts.houses)}</span><div class="a-actions">${actions||'<span style="color:var(--dim);font-size:11px;">—</span>'}</div></div>`;
    }).join('') || '<p>You own no properties yet.</p>';
    showRawModal(`<h3>Manage Properties</h3><p>Cash: $${me.cash}</p>${rows}<div class="btnrow"><button class="secondary" id="manage-close">Close</button></div>`);
    document.querySelectorAll('.asset-row button').forEach(b=>{
      b.onclick = ()=>{
        const i=+b.dataset.i, act=b.dataset.act;
        socket.emit(act==='sell'?'sell_house':act, {roomCode, token:myToken, tileIndex:i});
        setTimeout(render, 120); // re-render once the next state snapshot lands
      };
    });
    document.getElementById('manage-close').onclick = closeModal;
  }
  render();
}
function openForcedAssetModal(payload){
  function render(){
    const rows = (payload.owned||[]).map(o=>{
      let actions='';
      if (o.houses>0) actions += `<button data-act="sell" data-i="${o.tileIndex}">Sell house</button>`;
      if (!o.mortgaged && o.houses===0) actions += `<button data-act="mortgage" data-i="${o.tileIndex}">Mortgage (+$${o.mortgageValue})</button>`;
      if (o.mortgaged) actions += `<button data-act="unmortgage" data-i="${o.tileIndex}">Unmortgage</button>`;
      return `<div class="asset-row"><span>${o.flag||''} ${o.name}${o.mortgaged?' '+Icon('lock'):''} ${houseBadge(o.houses)}</span><div class="a-actions">${actions}</div></div>`;
    }).join('') || '<p>No properties left.</p>';
    showRawModal(`<h3>Need $${payload.needed}</h3><p>You have $${payload.cash}. Raise funds or declare bankruptcy.</p>${rows}
      <div class="btnrow"><button class="secondary" id="mb-done">Continue</button><button class="danger" id="mb-bankrupt">Declare Bankruptcy</button></div>`);
    document.querySelectorAll('.asset-row button').forEach(b=>{
      b.onclick = ()=>{ sendIntent('manage_assets', {act:b.dataset.act, tileIndex:+b.dataset.i}); };
    });
    document.getElementById('mb-done').onclick = ()=>{ closeModal(); sendIntent('manage_assets', {act:'noop'}); };
    document.getElementById('mb-bankrupt').onclick = ()=>{ closeModal(); sendIntent('manage_assets', {give_up:true}); };
  }
  render();
}

// ---------------------------------------------------------------------------
// TRADE MODALS
// ---------------------------------------------------------------------------
function openTradeModal(state){
  const others = state.seats.filter(s=>!s.isGhost && s.id!==mySeatId);
  if (others.length===0){
    showRawModal(`<h3>${Icon('handshake')} Trade</h3><p>No one to trade with right now.</p><div class="btnrow"><button class="secondary" id="tr-close">Close</button></div>`);
    document.getElementById('tr-close').onclick = closeModal;
    return;
  }
  let partnerId = others[0].id, myProps=new Set(), theirProps=new Set(), myCash=0, theirCash=0;
  function tradeSideValue(forSeatId, propList, cash){
    let v=cash;
    for (const i of propList){
      let pv = state.tileState[i].mortgaged ? Math.round(BOARD[i].price*0.5) : BOARD[i].price;
      const g = BOARD[i].group;
      if (g && groupTiles(g).every(j=>state.tileState[j].owner===forSeatId || propList.includes(j))) pv=Math.round(pv*1.6);
      v+=pv;
    }
    return v;
  }
  function updateTotals(){
    const partner = state.seats.find(s=>s.id===partnerId);
    const totals = document.querySelectorAll('#modal-content .trade-total');
    if (totals[0]) totals[0].textContent = `Value: $${tradeSideValue(partner.id, Array.from(myProps), myCash)}`;
    if (totals[1]) totals[1].textContent = `Value: $${tradeSideValue(mySeatId, Array.from(theirProps), theirCash)}`;
  }
  function render(){
    const me = state.seats.find(s=>s.id===mySeatId);
    const partner = state.seats.find(s=>s.id===partnerId);
    const myOwned = ownedTiles(state, mySeatId).filter(i=>isTradeable(state,i));
    const theirOwned = ownedTiles(state, partner.id).filter(i=>isTradeable(state,i));
    const partnerOptions = others.map(s=>`<option value="${s.id}" ${s.id===partnerId?'selected':''}>${s.name}</option>`).join('');
    const rowsHtml = (list,set,side)=> list.map(i=>{
      const t=BOARD[i];
      return `<label class="trade-prop"><input type="checkbox" data-side="${side}" data-i="${i}" ${set.has(i)?'checked':''}> ${t.flag||''} ${t.name}</label>`;
    }).join('') || '<p style="color:var(--dim);font-size:11.5px;">Nothing tradeable.</p>';
    showRawModal(`<h3>${Icon('handshake')} Propose a Trade</h3><p>Trading with <select id="tr-partner">${partnerOptions}</select></p>
      <div class="trade-cols">
        <div class="trade-col"><h4>You Give</h4><div class="trade-list">${rowsHtml(myOwned,myProps,'mine')}</div>
          <label class="trade-cash">Cash: $<input type="number" id="tr-mycash" min="0" max="${me.cash}" value="${myCash}"></label>
          <div class="trade-total">Value: $${tradeSideValue(partner.id, Array.from(myProps), myCash)}</div></div>
        <div class="trade-col"><h4>You Get</h4><div class="trade-list">${rowsHtml(theirOwned,theirProps,'theirs')}</div>
          <label class="trade-cash">Cash: $<input type="number" id="tr-theircash" min="0" max="${partner.cash}" value="${theirCash}"></label>
          <div class="trade-total">Value: $${tradeSideValue(mySeatId, Array.from(theirProps), theirCash)}</div></div>
      </div>
      <div class="btnrow"><button id="tr-propose">Propose Trade</button><button class="secondary" id="tr-cancel">Cancel</button></div>`);
    document.getElementById('tr-partner').onchange = e=>{ partnerId=+e.target.value; myProps.clear(); theirProps.clear(); myCash=0; theirCash=0; render(); };
    document.querySelectorAll('.trade-prop input').forEach(cb=>{
      cb.onchange = ()=>{ const i=+cb.dataset.i, set = cb.dataset.side==='mine'?myProps:theirProps; cb.checked?set.add(i):set.delete(i); updateTotals(); };
    });
    const mycashEl=document.getElementById('tr-mycash'), theircashEl=document.getElementById('tr-theircash');
    const syncMy = ()=>{ myCash=Math.max(0,Math.min(me.cash,parseInt(mycashEl.value)||0)); updateTotals(); };
    const syncTheir = ()=>{ theirCash=Math.max(0,Math.min(partner.cash,parseInt(theircashEl.value)||0)); updateTotals(); };
    mycashEl.oninput=syncMy; mycashEl.onchange=syncMy; theircashEl.oninput=syncTheir; theircashEl.onchange=syncTheir;
    document.getElementById('tr-cancel').onclick = closeModal;
    document.getElementById('tr-propose').onclick = ()=>{
      syncMy(); syncTheir();
      socket.emit('propose_trade', {roomCode, token:myToken, toSeatId:partnerId, fromProps:Array.from(myProps), fromCash:myCash, toProps:Array.from(theirProps), toCash:theirCash});
      closeModal();
    };
  }
  render();
}
function openReviewTradeModal(payload){
  const fromHtml = (payload.fromProps||[]).map(x=>`${x.flag||''} ${x.name}`).join(', ') || 'nothing';
  const toHtml = (payload.toProps||[]).map(x=>`${x.flag||''} ${x.name}`).join(', ') || 'nothing';
  askModal(`<h3>${Icon('handshake')} Trade Offer from ${payload.fromName}</h3>
    <p><b>They offer:</b> ${fromHtml}${payload.fromCash>0?` + $${payload.fromCash}`:''}</p>
    <p><b>They want:</b> ${toHtml}${payload.toCash>0?` + $${payload.toCash}`:''}</p>`,
    [{label:'Accept', value:true},{label:'Reject', value:false, secondary:true}]).then(v=>sendIntent('review_trade', v));
}

// ---------------------------------------------------------------------------
// GHOST HAUNT MODAL
// ---------------------------------------------------------------------------
function openHauntModal(payload){
  let selected=null;
  function render(){
    const dash = `<div class="ghost-dash"><h4>${Icon('eye')} What you see (living players)</h4>${
      payload.living.map(p=>`<div class="gp-row"><span>${p.name}</span><span>$${p.cash} &middot; ${p.properties} properties</span></div>`).join('')
    }<div class="gp-row"><span>Your spirit fund</span><span>$${payload.spiritFund} / $${payload.threshold}</span></div></div>`;
    const grid = `<div class="haunt-grid">${BOARD.map((t,i)=>{
      const taken = payload.haunted.includes(i) || i===0;
      const cls = 'haunt-tile'+(taken?' disabled':'')+(selected===i?' sel':'');
      const style = selected===i ? 'outline:2px solid var(--ghost-accent);' : '';
      return `<div class="${cls}" style="${style}" data-i="${i}">${t.name}</div>`;
    }).join('')}</div>`;
    showRawModal(`<h3>${Icon('ghost')} Choose a tile to haunt</h3><p>Pick one tile. It stays haunted for ${payload.haventRounds||3} rounds unless someone triggers it. Nobody living will know.</p>${dash}${grid}
      <div class="btnrow"><button id="haunt-confirm" ${selected===null?'disabled':''}>Haunt this tile</button></div>`);
    document.querySelectorAll('.haunt-tile:not(.disabled)').forEach(el=>{
      el.onclick = ()=>{ selected=+el.dataset.i; render(); };
    });
    const cb = document.getElementById('haunt-confirm');
    if (cb) cb.onclick = ()=>{ closeModal(); sendIntent('haunt_choice', selected); };
  }
  render();
}

function confirmConcede(){
  askModal(`<h3>${Icon('whiteflag')} Concede?</h3><p>Are you sure you want to concede? Your cash and properties are forfeited and you'll become a Ghost — you can only return by earning enough spirit fund to revive.</p>`,
    [{label:'Yes, Concede', value:true},{label:'Cancel', value:false, secondary:true}]).then(v=>{
      if (v) socket.emit('concede', {roomCode, token:myToken});
    });
}

// ---------------------------------------------------------------------------
// DICE
// ---------------------------------------------------------------------------
const DIE_FACE_PIPS = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] };
function setDieFace(el, face){
  const pips = el.querySelectorAll('.pip');
  const on = DIE_FACE_PIPS[face] || [];
  pips.forEach((p,i)=> p.classList.toggle('on', on.includes(i)));
}
async function animateDice(d1,d2){
  const e1=document.getElementById('d1'), e2=document.getElementById('d2');
  e1.classList.add('rolling'); e2.classList.add('rolling');
  let n=0;
  await new Promise(resolve=>{
    const iv = setInterval(()=>{
      setDieFace(e1, 1+Math.floor(Math.random()*6));
      setDieFace(e2, 1+Math.floor(Math.random()*6));
      n++;
      if (n>7){
        clearInterval(iv);
        e1.classList.remove('rolling'); e2.classList.remove('rolling');
        setDieFace(e1, d1); setDieFace(e2, d2);
        e1.classList.add('settle'); e2.classList.add('settle');
        setTimeout(()=>{ e1.classList.remove('settle'); e2.classList.remove('settle'); resolve(); }, 400);
      }
    }, 80);
  });
}
setDieFace(document.getElementById('d1'), 1);
setDieFace(document.getElementById('d2'), 1);

// ---------------------------------------------------------------------------
// MICRO-INTERACTIONS
// ---------------------------------------------------------------------------
function flashTile(i){
  const el = document.querySelector(`.tile[data-i="${i}"]`);
  if (!el) return;
  el.classList.remove('flash-buy'); void el.offsetWidth;
  el.classList.add('flash-buy');
  setTimeout(()=>el.classList.remove('flash-buy'), 700);
}
async function flipTileBig(i){
  const el = document.querySelector(`.tile[data-i="${i}"]`);
  if (!el) return;
  el.classList.remove('big-flip'); void el.offsetWidth;
  el.classList.add('big-flip');
  await sleep(650);
  el.classList.remove('big-flip');
}
function spawnFloatMoney(seatId, amount){
  const rows = document.querySelectorAll('.player-row');
  // side-panel rows have no data-id in this client (kept simple); fall back to topbar center if not found
  const idx = latestState ? latestState.seats.findIndex(s=>s.id===seatId) : -1;
  const row = rows[idx];
  const rect = (row || document.getElementById('side-panel')).getBoundingClientRect();
  const span = document.createElement('div');
  span.className = 'float-money';
  span.style.left = (rect.right-46)+'px';
  span.style.top = (rect.top+4)+'px';
  span.style.color = amount>=0 ? '#3fd6ae' : '#ff5964';
  span.textContent = (amount>=0?'+$':'-$')+Math.abs(amount);
  document.body.appendChild(span);
  setTimeout(()=>span.remove(), 1200);
}
const FLOURISH_EMOJI_TO_ICON = {'🏳️':'whiteflag', '💀':'skull', '✨':'sparkle', '👻':'ghost', '🏆':'trophy'};
function showFlourish(emoji, title, sub){
  return new Promise(resolve=>{
    document.querySelector('.reveal-emoji').innerHTML = Icon(FLOURISH_EMOJI_TO_ICON[emoji] || 'ghost');
    document.getElementById('reveal-title').textContent = title;
    document.getElementById('reveal-sub').textContent = sub;
    const overlay = document.getElementById('reveal-overlay');
    overlay.classList.add('show');
    let done=false;
    function finish(){ if (done) return; done=true; overlay.classList.remove('show'); overlay.onclick=null; resolve(); }
    overlay.onclick = finish;
    setTimeout(finish, 2600);
  });
}

// ---------------------------------------------------------------------------
// EVENTS (one-shot cues broadcast alongside state)
// ---------------------------------------------------------------------------
// Events can arrive in several separate 'events' socket messages in quick
// succession (e.g. a dice roll immediately followed by a move). Queue them
// and process strictly one at a time so animations never overlap, regardless
// of how the server happened to batch them.
let eventQueue = [];
let processingEvents = false;
socket.on('events', (events)=>{
  eventQueue.push(...events);
  processEventQueue();
});
async function processEventQueue(){
  if (processingEvents) return;
  processingEvents = true;
  while (eventQueue.length){
    await handleOneEvent(eventQueue.shift());
  }
  processingEvents = false;
}
async function handleOneEvent(e){
  if (e.type==='dice') await animateDice(e.payload.d1, e.payload.d2);
  else if (e.type==='move') await animateTokenHop(e.payload.seatId, e.payload.from, e.payload.to);
  else if (e.type==='teleport') { const el=getTokenElBySeatId(e.payload.seatId); if (el) positionTokenEl(el, e.payload.to, 0, 1); }
  else if (e.type==='money') spawnFloatMoney(e.payload.seatId, e.payload.amount);
  else if (e.type==='flashTile') flashTile(e.payload.tileIndex);
  else if (e.type==='flipTile') await flipTileBig(e.payload.tileIndex);
  else if (e.type==='announce') { document.getElementById('turn-banner').textContent = e.payload; await sleep(700); }
  else if (e.type==='card') await showCardModal(e.payload);
  else if (e.type==='flourish') await showFlourish(e.payload.emoji, e.payload.title, e.payload.sub);
}
function getTokenElBySeatId(seatId){
  const seat = latestState && latestState.seats.find(s=>s.id===seatId);
  return seat ? getTokenEl(seat) : null;
}
async function showCardModal(payload){
  const html = `<h3>${payload.deckType==='fate'?Icon('crystalball')+' Fate Card':Icon('moon')+' Omen Card'}</h3><p>${payload.text}</p>`;
  showRawModal(html);
  document.getElementById('modal-content').classList.add('card-reveal');
  await sleep(1300);
  closeModal();
}

// ---------------------------------------------------------------------------
// MAIN STATE HANDLER
// ---------------------------------------------------------------------------
socket.on('state', (state)=>{
  latestState = state;
  if (!isSpectator && mySeatId==null && state.yourSeatId!=null) mySeatId = state.yourSeatId;
  if (!state.started){
    renderLobbySeats(state);
    return;
  }
  if (document.getElementById('game-screen').style.display !== 'flex') showGameScreen();
  renderTiles(state);
  renderSidePanel(state);
  renderLog(state);
  renderTurnBanner(state);
  if (state.gameOver && state.winnerSeatId!=null && !state._shownWin){
    // flourish for game over is sent as an 'events' entry already; nothing extra needed here
  }
});

socket.on('connect_error', ()=>{ /* transient; socket.io auto-reconnects */ });

})();
