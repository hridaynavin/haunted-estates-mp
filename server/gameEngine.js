// Server-authoritative game engine. Pure state + turn-flow logic, no HTTP/IO
// concerns — server.js wires this to Socket.IO. Ported rule-for-rule from the
// single-player client (haunted-estates/index.html) so both versions stay
// balanced identically; the difference is *where* decisions are waited on:
// here every "wait for the human" point goes through requestIntent(), which
// either asks a connected human's socket or, if that seat is bot-controlled
// (including a temporarily-disconnected human), resolves immediately via bot
// heuristics ported from the same client.
'use strict';
const { GROUPS, BOARD, RAILROAD_RENTS, JAIL_TILE, GOTOJAIL_TILE, VACATION_TILE, GO_TILE,
  FATE_CARDS, OMEN_CARDS, groupTiles } = require('./boardConfig');

const MAX_TURNS = 300;
const HAUNT_ROUNDS = 3;
const REVIVE_CASH = 500;
const PLAYER_COLORS = ['#ff5964','#35a7ff','#ffd23f','#06d6a0','#c77dff','#f78c6b'];

function shuffle(a){ for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function dist2(ax,ay,bx,by){ return Math.hypot(ax-bx, ay-by); }

class Room {
  constructor(code, opts, broadcastFn){
    this.code = code;
    this.startingCash = opts.startingCash || 1500;
    this.reviveThreshold = opts.reviveThreshold || 800;
    this.maxSeats = clamp(opts.maxSeats || 4, 2, 6);
    this.hostSeatId = 0;
    this.seats = [];
    this.started = false;
    this.gameOver = false;
    this.winnerSeatId = null;
    this.tileState = BOARD.map(()=>({owner:null, houses:0, mortgaged:false}));
    this.vacationPot = 0;
    this.hauntedTiles = new Map(); // tileIndex -> {ghostSeatId, expiresAtRound}
    this.fateDeck = shuffle(FATE_CARDS.slice());
    this.omenDeck = shuffle(OMEN_CARDS.slice());
    this.tradeHistory = [];
    this.currentIndex = 0;
    this.roundCount = 0;
    this.turnCount = 0;
    this.log = [];
    this.pendingIntent = null; // {seatId, type, resolve}
    this.canActNow = false;    // mirrors client's safe-window flag (gates trade/concede)
    this.spectatorSocketIds = new Set();
    this.lastActivityAt = Date.now();
    this._broadcast = broadcastFn; // (room, events) => void, provided by server.js
    for (let i=0;i<this.maxSeats;i++) this.seats.push(this._makeBotSeat(i));
  }

  _makeBotSeat(id){
    return {
      id, name:'Bot '+(id+1), color: PLAYER_COLORS[id % PLAYER_COLORS.length],
      isBot:true, socketId:null, token:null, wasHuman:false, connected:false,
      position:0, cash:this.startingCash, isGhost:false, inJail:false, jailTurns:0, jailCards:0,
      doublesStreak:0, spiritFund:0, skipNextTurn:false, nextRentMultiplier:0,
      aiDecisionAt:0, aiMode:'chase', aiTargetId:null,
    };
  }

  log_(text){ this.log.push({text, t:Date.now()}); if (this.log.length>200) this.log.shift(); }

  event(type, payload){
    // one-shot client-side cue (animation/flourish); state is re-broadcast right after
    this._pendingEvents = this._pendingEvents || [];
    this._pendingEvents.push({type, payload});
  }

  flush(){
    const events = this._pendingEvents || [];
    this._pendingEvents = [];
    this.lastActivityAt = Date.now();
    this._broadcast(this, events);
  }

  // ---------------------------------------------------------------------
  // SEATS / LOBBY
  // ---------------------------------------------------------------------
  claimSeatForNewPlayer(name){
    // Prefer a seat that was never human. Never steal a seat that's mid-disconnect
    // (wasHuman && !connected) — that one is reserved for its own reconnect.
    let seat = this.seats.find(s => s.isBot && !s.wasHuman);
    if (!seat) return null; // no free seat -> caller should make this a spectator
    seat.isBot = false;
    seat.wasHuman = true;
    seat.connected = true;
    seat.name = name || ('Player ' + (seat.id+1));
    seat.token = randomToken();
    return seat;
  }

  reclaimSeat(token){
    const seat = this.seats.find(s => s.token === token);
    if (!seat) return null;
    seat.isBot = false;
    seat.connected = true;
    return seat;
  }

  onSeatDisconnected(seat){
    seat.connected = false;
    seat.socketId = null;
    seat.isBot = true; // bot pilots it until reconnect; wasHuman stays true so it can't be stolen
    if (this.pendingIntent && this.pendingIntent.seatId === seat.id){
      const resolve = this.pendingIntent.resolve;
      this.pendingIntent = null;
      resolve(botDecide(this, seat, this._pendingIntentType, this._pendingIntentPayload));
    }
  }

  // ---------------------------------------------------------------------
  // INTENT WAITING (the human-vs-bot decision point)
  // ---------------------------------------------------------------------
  requestIntent(seatId, type, payload){
    const seat = this.seats[seatId];
    if (seat.isBot){
      return this._sleep(350 + Math.random()*250).then(()=>botDecide(this, seat, type, payload));
    }
    return new Promise(resolve=>{
      this.pendingIntent = {seatId, type, resolve};
      this._pendingIntentType = type;
      this._pendingIntentPayload = payload;
      this.flush();
    });
  }

  resolveIntent(seatId, type, payload){
    if (!this.pendingIntent || this.pendingIntent.seatId!==seatId || this.pendingIntent.type!==type) return false;
    const resolve = this.pendingIntent.resolve;
    this.pendingIntent = null;
    resolve(payload);
    return true;
  }

  // ---------------------------------------------------------------------
  // GAME START / MAIN LOOP
  // ---------------------------------------------------------------------
  start(){
    if (this.started) return;
    this.started = true;
    for (const p of this.seats) claimHomeless(p); // no-op placeholder for symmetry with client; nothing needed
    this.log_('The game begins. Good luck — and beware the estates after dark.');
    this.flush();
    this._runLoop().catch(err=>{ console.error('[room '+this.code+'] engine crashed:', err); });
  }

  async _runLoop(){
    while (!this.gameOver){
      const seat = this.seats[this.currentIndex];
      if (seat.isGhost) await this._takeGhostTurn(seat);
      else await this._takeLivingTurn(seat);
      this._purgeExpiredHaunts();
      if (this._checkWinConditions()) break;
      this.currentIndex = (this.currentIndex+1) % this.seats.length;
      if (this.currentIndex===0) this.roundCount++;
      this.turnCount++;
      if (this.turnCount>=MAX_TURNS){
        const living = this.seats.filter(s=>!s.isGhost);
        let best = living[0] || this.seats[0];
        for (const p of living) if (netWorth(this,p) > netWorth(this,best)) best = p;
        this._endGame(best, `The estate closes its doors after a long night. ${best.name} holds the greatest fortune.`);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------
  // LIVING TURN
  // ---------------------------------------------------------------------
  async _takeLivingTurn(p){
    this.canActNow = false;
    if (p.skipNextTurn){
      p.skipNextTurn = false;
      this.log_(`${p.name} is too spooked to move and skips their turn.`);
      this.event('announce', `${p.name} skips this turn...`);
      this.flush();
      return;
    }
    p.doublesStreak = 0;
    let turnOver = false;
    while (!turnOver){
      turnOver = true;
      if (this.gameOver) return;
      if (p.inJail){
        const left = await this._handleJailTurn(p);
        if (this.gameOver || p.isGhost || !left) break;
        await this._movePlayerTo(p, (p.position + this._lastRoll[0] + this._lastRoll[1]) % 40, {diceSum: this._lastRoll[0]+this._lastRoll[1]});
        break;
      }
      const [d1,d2] = await this._rollDice(p);
      this._lastRoll = [d1,d2];
      if (d1===d2){
        p.doublesStreak++;
        if (p.doublesStreak>=3){
          this.log_(`${p.name} rolled doubles three times in a row — hauled to the Crypt!`);
          this._sendToJail(p);
          this.flush();
          break;
        }
      }
      await this._movePlayerTo(p, (p.position+d1+d2)%40, {diceSum:d1+d2});
      if (this.gameOver || p.isGhost) break;
      if (d1===d2 && !p.inJail){
        turnOver = false;
        this.event('announce', `Doubles! ${p.name} goes again.`);
        this.flush();
      }
    }
    if (!p.isGhost) await this._postMoveActions(p);
  }

  async _rollDice(p){
    // humans explicitly click "Roll Dice" (matches the single-player UX); bots
    // just roll immediately since requestIntent's bot branch resolves right away
    await this.requestIntent(p.id, 'roll_dice', {});
    const d1 = 1+Math.floor(Math.random()*6), d2 = 1+Math.floor(Math.random()*6);
    this.event('dice', {d1,d2,seatId:p.id});
    this.flush();
    return [d1,d2];
  }

  async _postMoveActions(p){
    if (this.gameOver) return;
    if (p.isBot){
      botManageProperties(this, p);
      await this.maybeBotProposeTrade(p);
      this.flush();
      await this._sleep(300);
      return;
    }
    this.canActNow = true;
    this.flush();
    await this.requestIntent(p.id, 'post_move', {});
    this.canActNow = false;
    // Build/Trade sub-actions are handled via their own intent types while
    // canActNow stays true; 'end_turn' is what ends this wait.
    this.flush();
  }

  // ---------------------------------------------------------------------
  // JAIL
  // ---------------------------------------------------------------------
  async _handleJailTurn(p){
    const opts = [];
    if (p.jailCards>0) opts.push('card');
    opts.push('pay','roll');
    const choice = await this.requestIntent(p.id, 'jail_choice', {attempt: p.jailTurns+1, opts, canPay: p.cash>=50});
    if (choice==='card'){
      p.jailCards--; p.inJail=false; p.jailTurns=0;
      this.log_(`${p.name} uses a Return Home Free card.`);
      const [d1,d2] = await this._rollDice(p); this._lastRoll=[d1,d2];
      this.flush();
      return true;
    }
    if (choice==='pay' && p.cash>=50){
      p.cash-=50; this.vacationPot+=50; p.inJail=false; p.jailTurns=0;
      this.log_(`${p.name} pays $50 to leave the Crypt.`);
      const [d1,d2] = await this._rollDice(p); this._lastRoll=[d1,d2];
      this.flush();
      return true;
    }
    const [d1,d2] = await this._rollDice(p); this._lastRoll=[d1,d2];
    if (d1===d2){
      p.inJail=false; p.jailTurns=0;
      this.log_(`${p.name} rolls doubles and breaks free!`);
      this.flush();
      return true;
    }
    p.jailTurns++;
    if (p.jailTurns>=3){
      this.log_(`${p.name} has failed 3 times and must pay $50 to leave.`);
      if (p.cash>=50){ p.cash-=50; this.vacationPot+=50; p.inJail=false; p.jailTurns=0; this.flush(); return true; }
      const ok = await this._payDebt(p, 50, null, 'forced Crypt fine');
      if (p.isGhost) return false;
      p.inJail=false; p.jailTurns=0;
      this.flush();
      return true;
    }
    this.log_(`${p.name} stays in the Crypt (attempt ${p.jailTurns}/3).`);
    this.flush();
    return false;
  }

  // ---------------------------------------------------------------------
  // MOVEMENT / LANDING
  // ---------------------------------------------------------------------
  async _movePlayerTo(p, targetIndex, opts={}){
    const old = p.position;
    const passedGo = targetIndex < old;
    this.event('move', {seatId:p.id, from:old, to:targetIndex});
    p.position = targetIndex;
    if (passedGo){
      p.cash += 200;
      this.log_(`${p.name} passes Departure and collects $200.`);
      this.event('money', {seatId:p.id, amount:200});
    }
    this.flush();
    await this._resolveLanding(p, targetIndex, opts.diceSum, opts);
  }

  async _advanceToNearest(p, type, doubleRentIfOwned){
    let i = (p.position+1)%40;
    while (BOARD[i].type!==type) i=(i+1)%40;
    const owned = this.tileState[i].owner!==null && this.tileState[i].owner!==p.id;
    await this._movePlayerTo(p, i, {doubleRent: doubleRentIfOwned && owned});
  }

  _sendToJail(p){
    p.position = JAIL_TILE; p.inJail=true; p.jailTurns=0; p.doublesStreak=0;
    this.log_(`${p.name} is sent to the Crypt!`);
    this.event('teleport', {seatId:p.id, to:JAIL_TILE});
  }

  async _resolveLanding(p, tileIndex, diceSum, opts={}){
    if (p.isGhost || this.gameOver) return;
    if (this.hauntedTiles.has(tileIndex)){
      const haunt = this.hauntedTiles.get(tileIndex);
      this.hauntedTiles.delete(tileIndex);
      this.flush();
      await this._triggerHaunt(haunt, p, tileIndex);
      return;
    }
    const tile = BOARD[tileIndex];
    switch (tile.type){
      case 'go': break;
      case 'jail': this.log_(`${p.name} is just visiting the Crypt.`); break;
      case 'gotojail': this._sendToJail(p); break;
      case 'vacation': {
        const award = this.vacationPot + 100;
        this.vacationPot = 0; p.cash += award;
        this.log_(`${p.name} takes a Vacation and collects $${award}!`);
        this.event('money', {seatId:p.id, amount:award});
        break;
      }
      case 'tax': await this._payDebt(p, tile.amount, null, tile.name); break;
      case 'fate': await this._drawCard('fate', p); break;
      case 'omen': await this._drawCard('omen', p); break;
      case 'property': case 'railroad': case 'utility':
        await this._resolvePropertyLanding(p, tileIndex, diceSum, opts);
        break;
    }
    this.flush();
  }

  async _resolvePropertyLanding(p, tileIndex, diceSum, opts){
    const tile = BOARD[tileIndex], ts = this.tileState[tileIndex];
    if (ts.owner===null){
      await this._offerPurchase(p, tileIndex);
    } else if (ts.owner===p.id){
      // own property, nothing happens
    } else if (ts.mortgaged){
      this.log_(`${tile.name} is mortgaged — no rent due.`);
    } else {
      const owner = this.seats[ts.owner];
      let rent = this._computeRent(tileIndex, diceSum);
      if (opts.doubleRent) rent *= 2;
      if (p.nextRentMultiplier){ rent *= p.nextRentMultiplier; p.nextRentMultiplier=0; }
      await this._payDebt(p, rent, owner, `rent on ${tile.name}`);
    }
  }

  _computeRent(tileIndex, diceSum){
    const tile = BOARD[tileIndex], ts = this.tileState[tileIndex], ownerId = ts.owner;
    if (tile.type==='railroad'){
      const owned = BOARD.filter((t,i)=>t.type==='railroad' && this.tileState[i].owner===ownerId).length;
      return RAILROAD_RENTS[owned-1];
    }
    if (tile.type==='utility'){
      const owned = BOARD.filter((t,i)=>t.type==='utility' && this.tileState[i].owner===ownerId).length;
      return (owned===2?10:4) * diceSum;
    }
    if (ts.houses>0) return tile.rent[ts.houses];
    return this._ownerHasFullGroup(ownerId, tile.group) ? tile.rent[0]*2 : tile.rent[0];
  }

  _ownerHasFullGroup(ownerId, group){
    if (ownerId===null) return false;
    return groupTiles(group).every(i => this.tileState[i].owner===ownerId);
  }

  // ---------------------------------------------------------------------
  // BUYING / AUCTION
  // ---------------------------------------------------------------------
  async _offerPurchase(p, tileIndex){
    const tile = BOARD[tileIndex];
    const wantsBuy = await this.requestIntent(p.id, 'buy_decision', {tileIndex, price:tile.price, canAfford:p.cash>=tile.price});
    if (wantsBuy && p.cash>=tile.price){
      p.cash -= tile.price;
      this.tileState[tileIndex].owner = p.id;
      this.log_(`${p.name} buys ${tile.name} for $${tile.price}.`);
      this.event('money', {seatId:p.id, amount:-tile.price});
      this.event('flashTile', {tileIndex});
      this.flush();
    } else {
      this.log_(`${p.name} passes on ${tile.name} — it goes to auction!`);
      this.flush();
      await this._runAuction(tileIndex);
    }
  }

  async _runAuction(tileIndex){
    const tile = BOARD[tileIndex];
    let active = this.seats.filter(s => !s.isGhost && s.cash>10);
    if (active.length===0) return;
    let currentBid=0, currentBidderId=null;
    const valuation = {};
    for (const s of active) if (s.isBot) valuation[s.id] = tile.price*(0.6+Math.random()*0.7);
    let rounds=0;
    while (active.length>1 && rounds<20){
      rounds++;
      let anyRaise=false;
      for (const s of active.slice()){
        if (!active.includes(s)) continue;
        let raises;
        if (!s.isBot){
          raises = await this.requestIntent(s.id, 'auction_bid', {tileIndex, currentBid, currentBidderId, canBid: s.cash>=currentBid+10});
        } else {
          raises = (currentBid+10<=valuation[s.id]) && (currentBid+10<=s.cash);
        }
        if (raises){ currentBid+=10; currentBidderId=s.id; anyRaise=true; }
        else active = active.filter(x=>x!==s);
      }
      if (!anyRaise) break;
    }
    if (currentBidderId!==null && currentBid>0){
      const winner = this.seats[currentBidderId];
      winner.cash -= currentBid;
      this.tileState[tileIndex].owner = winner.id;
      this.log_(`🔨 ${winner.name} wins the auction for ${tile.name} at $${currentBid}!`);
      this.event('money', {seatId:winner.id, amount:-currentBid});
      this.event('flashTile', {tileIndex});
    } else {
      this.log_(`No bids — ${tile.name} remains unclaimed.`);
    }
    this.flush();
  }

  // ---------------------------------------------------------------------
  // MONEY
  // ---------------------------------------------------------------------
  async _payDebt(p, amount, dest, reason){
    if (p.cash < amount){
      if (!p.isBot) await this._humanRaiseCash(p, amount);
      else this._autoRaiseCash(p, amount);
      if (p.cash < amount){
        const creditor = (dest && !dest.ghost) ? dest : null;
        await this._goBankrupt(p, creditor, false);
        return false;
      }
    }
    p.cash -= amount;
    this.event('money', {seatId:p.id, amount:-amount});
    if (!dest) this.vacationPot += amount;
    else if (dest.ghost){ dest.ghost.spiritFund += amount; }
    else { dest.cash += amount; this.event('money', {seatId:dest.id, amount}); }
    this.log_(`${p.name} pays $${amount} — ${reason}.`);
    return true;
  }

  _ownedTiles(seatId){ const r=[]; BOARD.forEach((t,i)=>{ if (this.tileState[i].owner===seatId) r.push(i); }); return r; }

  _autoRaiseCash(p, needed){
    let owned = this._ownedTiles(p.id);
    let safety=200;
    while (p.cash<needed && safety-->0){
      const withHouses = owned.filter(i=>this.tileState[i].houses>0);
      if (withHouses.length===0) break;
      const i = withHouses[0], t=BOARD[i], ts=this.tileState[i];
      ts.houses--; p.cash += Math.floor(GROUPS[t.group].houseCost/2);
    }
    owned.sort((a,b)=>BOARD[a].price-BOARD[b].price);
    for (const i of owned){
      if (p.cash>=needed) break;
      const ts=this.tileState[i];
      if (!ts.mortgaged && ts.houses===0){ ts.mortgaged=true; p.cash+=BOARD[i].mortgage; }
    }
    return p.cash>=needed;
  }

  async _humanRaiseCash(p, needed){
    // Let the human manage assets (mortgage/sell) via repeated 'manage_assets'
    // intents until they either cover the debt or explicitly give up.
    while (p.cash < needed){
      const action = await this.requestIntent(p.id, 'manage_assets', {needed, cash:p.cash, owned:this._ownedSummary(p.id)});
      if (!action || action.give_up) return false;
      const {act, tileIndex} = action;
      const t = BOARD[tileIndex], ts = this.tileState[tileIndex];
      if (!ts || ts.owner!==p.id) continue;
      if (act==='sell' && ts.houses>0){ ts.houses--; p.cash += Math.floor(GROUPS[t.group].houseCost/2); }
      if (act==='mortgage' && !ts.mortgaged && ts.houses===0){ ts.mortgaged=true; p.cash += t.mortgage; }
      if (act==='unmortgage' && ts.mortgaged){ const cost=Math.round(t.mortgage*1.1); if (p.cash>=cost){ p.cash-=cost; ts.mortgaged=false; } }
      this.flush();
    }
    return true;
  }

  _ownedSummary(seatId){
    return this._ownedTiles(seatId).map(i=>{
      const t=BOARD[i], ts=this.tileState[i];
      return {tileIndex:i, name:t.name, flag:t.flag, houses:ts.houses, mortgaged:ts.mortgaged, mortgageValue:t.mortgage};
    });
  }

  async _goBankrupt(p, creditor, conceded){
    const owned = this._ownedTiles(p.id);
    for (const i of owned){
      const ts = this.tileState[i];
      if (creditor) ts.owner = creditor.id;
      else { ts.owner=null; ts.houses=0; ts.mortgaged=false; }
    }
    p.cash=0; p.isGhost=true; p.spiritFund=0; p.inJail=false; p.jailCards=0;
    if (conceded){
      this.log_(`🏳️ ${p.name} conceded and became a Ghost.`);
      this.flush();
      await this._flourish('🏳️', `${p.name} concedes!`, 'They surrender the estate and slip into the world of Ghosts...');
    } else {
      this.log_(`💀 ${p.name} has gone bankrupt and become a Ghost!`);
      this.flush();
      await this._flourish('💀', `${p.name} has gone bankrupt!`, 'Their spirit lingers over Haunted Estates as a Ghost...');
    }
    this._checkWinConditions();
  }

  async concede(seatId){
    const p = this.seats[seatId];
    if (!this.canActNow || p.isGhost || p.isBot || this.gameOver) return;
    this.canActNow = false;
    this.resolveIntent(seatId, 'post_move', {end_turn:true}); // unblock the pending wait, same as client's fix
    await this._goBankrupt(p, null, true);
  }

  // ---------------------------------------------------------------------
  // BUILD / MORTGAGE (voluntary, during the safe window)
  // ---------------------------------------------------------------------
  build(seatId, tileIndex){
    const p = this.seats[seatId];
    if (!this.canActNow || p.id!==seatId) return;
    const t = BOARD[tileIndex], ts = this.tileState[tileIndex];
    if (!t || t.type!=='property' || ts.owner!==p.id) return;
    if (!this._ownerHasFullGroup(p.id, t.group)) return;
    if (groupTiles(t.group).some(i=>this.tileState[i].mortgaged)) return;
    if (ts.houses>=5) return;
    const min = Math.min(...groupTiles(t.group).map(i=>this.tileState[i].houses));
    if (ts.houses!==min) return;
    const cost = GROUPS[t.group].houseCost;
    if (p.cash<cost) return;
    ts.houses++; p.cash -= cost;
    this.log_(`${p.name} builds on ${t.name} (now ${ts.houses>=5?'a hotel':ts.houses+' house(s)'}).`);
    this.flush();
  }
  sellHouse(seatId, tileIndex){
    const p = this.seats[seatId];
    if (!this.canActNow || p.id!==seatId) return;
    const t = BOARD[tileIndex], ts = this.tileState[tileIndex];
    if (!t || ts.owner!==p.id || ts.houses<=0) return;
    const max = Math.max(...groupTiles(t.group).map(i=>this.tileState[i].houses));
    if (ts.houses!==max) return;
    ts.houses--; p.cash += Math.floor(GROUPS[t.group].houseCost/2);
    this.log_(`${p.name} sells a house on ${t.name}.`);
    this.flush();
  }
  mortgage(seatId, tileIndex){
    const p = this.seats[seatId];
    if (!this.canActNow || p.id!==seatId) return;
    const t = BOARD[tileIndex], ts = this.tileState[tileIndex];
    if (!t || ts.owner!==p.id || ts.mortgaged || ts.houses>0) return;
    ts.mortgaged = true; p.cash += t.mortgage;
    this.log_(`${p.name} mortgages ${t.name} for $${t.mortgage}.`);
    this.flush();
  }
  unmortgage(seatId, tileIndex){
    const p = this.seats[seatId];
    if (!this.canActNow || p.id!==seatId) return;
    const t = BOARD[tileIndex], ts = this.tileState[tileIndex];
    if (!t || ts.owner!==p.id || !ts.mortgaged) return;
    const cost = Math.round(t.mortgage*1.1);
    if (p.cash<cost) return;
    p.cash -= cost; ts.mortgaged = false;
    this.log_(`${p.name} unmortgages ${t.name} for $${cost}.`);
    this.flush();
  }
  endTurn(seatId){
    this.resolveIntent(seatId, 'post_move', {end_turn:true});
  }

  // ---------------------------------------------------------------------
  // CARDS
  // ---------------------------------------------------------------------
  async _drawCard(deckType, p){
    await this._flipTileBig(p.position);
    const deck = deckType==='fate' ? this.fateDeck : this.omenDeck;
    const card = deck.shift();
    if (!card.keep) deck.push(card);
    this.event('card', {seatId:p.id, deckType, text:card.text});
    this.flush();
    await this._sleep(900); // gives every client's card-flip modal a moment before it resolves
    await this._applyCardOp(card, p);
  }

  async _applyCardOp(card, p){
    switch (card.op){
      case 'moveTo': await this._movePlayerTo(p, card.target); break;
      case 'advanceNearest': await this._advanceToNearest(p, card.kind, card.doubleRent); break;
      case 'sendToJail': this._sendToJail(p); this.flush(); break;
      case 'collect': p.cash += card.amount; this.log_(`${p.name} collects $${card.amount}.`); this.event('money',{seatId:p.id,amount:card.amount}); this.flush(); break;
      case 'pay': await this._payDebt(p, card.amount, null, 'a card fee'); break;
      case 'keepCard': p.jailCards++; this.log_(`${p.name} keeps a Return Home Free card.`); this.flush(); break;
      case 'repairs': {
        const owned = this._ownedTiles(p.id);
        let cost=0;
        for (const i of owned){ const h=this.tileState[i].houses; if (h>0&&h<5) cost+=card.perHouse*h; if (h===5) cost+=card.perHotel; }
        if (cost>0) await this._payDebt(p, cost, null, 'estate repairs');
        else { this.log_(`${p.name} owns no houses — no repairs needed.`); this.flush(); }
        break;
      }
      case 'birthday': {
        let total=0;
        for (const s of this.seats){
          if (s===p || s.isGhost) continue;
          const amt=Math.min(10,s.cash); s.cash-=amt; total+=amt;
          if (amt>0) this.event('money',{seatId:s.id, amount:-amt});
        }
        p.cash += total;
        this.log_(`${p.name} collects $${total} from fellow players for their birthday.`);
        this.event('money',{seatId:p.id, amount:total});
        this.flush();
        break;
      }
    }
  }

  // ---------------------------------------------------------------------
  // GHOSTS
  // ---------------------------------------------------------------------
  _purgeExpiredHaunts(){
    for (const [i,h] of Array.from(this.hauntedTiles.entries())){
      if (this.roundCount>=h.expiresAtRound) this.hauntedTiles.delete(i);
    }
  }

  async _takeGhostTurn(ghost){
    this.canActNow = false;
    if (ghost.spiritFund >= this.reviveThreshold){
      const wantsRevive = await this.requestIntent(ghost.id, 'revive_choice', {spiritFund:ghost.spiritFund, threshold:this.reviveThreshold});
      if (wantsRevive){
        ghost.isGhost=false; ghost.cash=REVIVE_CASH; ghost.spiritFund=0; ghost.position=0;
        ghost.inJail=false; ghost.jailTurns=0; ghost.jailCards=0; ghost.doublesStreak=0; ghost.skipNextTurn=false; ghost.nextRentMultiplier=0;
        this.log_(`✨ ${ghost.name} claws their way back to the land of the living!`);
        this.flush();
        await this._flourish('✨', `${ghost.name} has returned!`, `Starting fresh with $${REVIVE_CASH} and a second chance.`);
        return;
      }
    }
    const livingView = this.seats.filter(s=>!s.isGhost).map(s=>({id:s.id, name:s.name, cash:s.cash, properties:this._ownedTiles(s.id).length}));
    const haunted = Array.from(this.hauntedTiles.keys());
    const tileIndex = await this.requestIntent(ghost.id, 'haunt_choice', {living:livingView, spiritFund:ghost.spiritFund, threshold:this.reviveThreshold, haunted, haventRounds:HAUNT_ROUNDS});
    if (tileIndex!==null && tileIndex!==undefined && !this.hauntedTiles.has(tileIndex) && tileIndex!==GO_TILE){
      this.hauntedTiles.set(tileIndex, {ghostSeatId:ghost.id, expiresAtRound:this.roundCount+HAUNT_ROUNDS});
    }
    this.log_(`👻 ${ghost.name} stirs restlessly, haunting somewhere on the estate...`);
    this.flush();
  }

  chooseHauntTile(ghost){
    const living = this.seats.filter(s=>!s.isGhost);
    const scores = new Array(40).fill(0);
    for (const p of living) for (const roll of [6,7,7,8,7,5,9]) scores[(p.position+roll)%40]++;
    const candidates=[];
    for (let i=0;i<40;i++){
      if (i===GO_TILE || this.hauntedTiles.has(i)) continue;
      candidates.push({i, score:scores[i]});
    }
    if (candidates.length===0) return null;
    candidates.sort((a,b)=>b.score-a.score);
    const top = candidates.slice(0, Math.min(5,candidates.length));
    return top[Math.floor(Math.random()*top.length)].i;
  }

  async _triggerHaunt(haunt, victim, tileIndex){
    await this._flipTileBig(tileIndex);
    const ghost = this.seats[haunt.ghostSeatId];
    if (!ghost) return;
    const pool = [];
    const effects = SABOTAGE_EFFECTS;
    for (const e of effects) for (let k=0;k<e.weight;k++) pool.push(e);
    const chosen = pool[Math.floor(Math.random()*pool.length)];
    const msg = await chosen.run(this, victim, ghost);
    this.log_(`👻 HAUNTED! ${BOARD[tileIndex].name} was haunted by ${ghost.name}. ${msg}`);
    this.flush();
    await this._flourish('👻', `${ghost.name}'s ghost strikes!`, msg);
  }

  async _flipTileBig(tileIndex){
    this.event('flipTile', {tileIndex});
    this.flush();
    await this._sleep(650);
  }

  async _flourish(emoji, title, sub){
    this.event('flourish', {emoji, title, sub});
    this.flush();
    await this._sleep(1600);
  }

  _sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  // ---------------------------------------------------------------------
  // TRADES
  // ---------------------------------------------------------------------
  _propertyValue(i){ const t=BOARD[i], ts=this.tileState[i]; return ts.mortgaged ? Math.round(t.price*0.5) : t.price; }
  _wouldCompleteGroup(seatId, tileIndex, extra){
    const group = BOARD[tileIndex].group; if (!group) return false;
    return groupTiles(group).every(i => this.tileState[i].owner===seatId || extra.includes(i));
  }
  _tradeSideValue(forSeatId, propList, cash){
    let v=cash;
    for (const i of propList){ let pv=this._propertyValue(i); if (this._wouldCompleteGroup(forSeatId,i,propList)) pv=Math.round(pv*1.6); v+=pv; }
    return v;
  }
  _isTradeable(i){ return this.tileState[i].houses===0; }

  async proposeTrade(fromSeatId, toSeatId, fromProps, fromCash, toProps, toCash){
    if (!this.canActNow) return;
    const from = this.seats[fromSeatId], to = this.seats[toSeatId];
    if (!from || !to || from.isGhost || to.isGhost || from.id!==fromSeatId) return;
    fromProps = fromProps.filter(i=>this.tileState[i] && this.tileState[i].owner===from.id && this._isTradeable(i));
    toProps = toProps.filter(i=>this.tileState[i] && this.tileState[i].owner===to.id && this._isTradeable(i));
    fromCash = clamp(fromCash|0, 0, from.cash);
    toCash = clamp(toCash|0, 0, to.cash);
    if (fromProps.length===0 && fromCash===0 && toProps.length===0 && toCash===0) return;
    this.log_(`🤝 ${from.name} proposes a trade to ${to.name}.`);
    this.flush();
    let accept;
    if (!to.isBot){
      accept = await this.requestIntent(to.id, 'review_trade', {
        fromName: from.name, fromProps: fromProps.map(i=>({i, name:BOARD[i].name, flag:BOARD[i].flag})), fromCash,
        toProps: toProps.map(i=>({i, name:BOARD[i].name, flag:BOARD[i].flag})), toCash,
      });
    } else {
      await this._sleep(500);
      accept = botEvaluateTrade(this, to, fromSeatId, toProps, toCash, fromProps, fromCash);
    }
    if (accept){
      for (const i of fromProps) this.tileState[i].owner = to.id;
      for (const i of toProps) this.tileState[i].owner = from.id;
      from.cash += toCash - fromCash;
      to.cash += fromCash - toCash;
      this.tradeHistory.unshift({from:from.name, to:to.name,
        fromProps: fromProps.map(i=>`${BOARD[i].flag||''} ${BOARD[i].name}`), toProps: toProps.map(i=>`${BOARD[i].flag||''} ${BOARD[i].name}`),
        fromCash, toCash, accepted:true});
      this.log_(`✅ ${to.name} accepts the trade!`);
      if (toCash-fromCash!==0) this.event('money',{seatId:from.id, amount:toCash-fromCash});
      if (fromCash-toCash!==0) this.event('money',{seatId:to.id, amount:fromCash-toCash});
      for (const i of [...fromProps, ...toProps]) this.event('flashTile', {tileIndex:i});
    } else {
      this.tradeHistory.unshift({from:from.name, to:to.name,
        fromProps: fromProps.map(i=>`${BOARD[i].flag||''} ${BOARD[i].name}`), toProps: toProps.map(i=>`${BOARD[i].flag||''} ${BOARD[i].name}`),
        fromCash, toCash, accepted:false});
      this.log_(`${to.name} rejects the trade offer from ${from.name}.`);
    }
    this.flush();
  }

  async maybeBotProposeTrade(bot){
    const human = this.seats.find(s=>!s.isBot && !s.isGhost);
    if (!human || Math.random()>0.25) return;
    const humanOwned = this._ownedTiles(human.id).filter(i=>this._isTradeable(i));
    for (const i of humanOwned){
      if (!BOARD[i].group) continue;
      if (this._wouldCompleteGroup(bot.id, i, [])){
        const offerCash = Math.min(bot.cash-50, Math.round(this._propertyValue(i)*1.3));
        if (offerCash < Math.round(this._propertyValue(i)*0.5)) continue;
        await this._sleep(500);
        this.log_(`🤝 ${bot.name} proposes a trade to ${human.name}.`);
        this.flush();
        const accept = await this.requestIntent(human.id, 'review_trade', {
          fromName: bot.name, fromProps: [], fromCash: offerCash, toProps: [{i, name:BOARD[i].name, flag:BOARD[i].flag}], toCash: 0,
        });
        if (accept){
          this.tileState[i].owner = bot.id;
          bot.cash -= offerCash; human.cash += offerCash;
          this.tradeHistory.unshift({from:bot.name, to:human.name, fromProps:[], toProps:[`${BOARD[i].flag||''} ${BOARD[i].name}`], fromCash:offerCash, toCash:0, accepted:true});
          this.log_(`✅ ${human.name} accepts the trade!`);
          this.event('money',{seatId:bot.id, amount:-offerCash});
          this.event('money',{seatId:human.id, amount:offerCash});
          this.event('flashTile', {tileIndex:i});
        } else {
          this.tradeHistory.unshift({from:bot.name, to:human.name, fromProps:[], toProps:[`${BOARD[i].flag||''} ${BOARD[i].name}`], fromCash:offerCash, toCash:0, accepted:false});
          this.log_(`${human.name} rejects the trade offer from ${bot.name}.`);
        }
        this.flush();
        return;
      }
    }
  }

  // ---------------------------------------------------------------------
  // WIN CONDITIONS
  // ---------------------------------------------------------------------
  _anyGhostCanRevive(){ return this.seats.some(s=>s.isGhost && s.spiritFund>=this.reviveThreshold); }
  _endGame(winner, message){
    this.gameOver = true;
    this.winnerSeatId = winner.id;
    this.log_(`🏆 GAME OVER — ${message}`);
    this.event('flourish', {emoji:'🏆', title:`${winner.name} wins!`, sub: message});
    this.flush();
  }
  _checkWinConditions(){
    if (this.gameOver) return true;
    const living = this.seats.filter(s=>!s.isGhost);
    if (living.length===0){
      let best = this.seats[0];
      for (const p of this.seats) if (p.spiritFund>best.spiritFund) best=p;
      this._endGame(best, `The estates lie empty. ${best.name} haunts on with the largest spirit fund and claims eternal victory.`);
      return true;
    }
    if (living.length===1 && !this._anyGhostCanRevive()){
      this._endGame(living[0], `${living[0].name} stands as the last living soul, and no spirit has the strength to return.`);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // CLIENT VIEW (per-recipient redaction — this is what keeps haunts secret)
  // ---------------------------------------------------------------------
  viewFor(seatId){
    const viewer = seatId!=null ? this.seats[seatId] : null;
    const viewerIsGhost = !!(viewer && viewer.isGhost);
    return {
      code: this.code,
      started: this.started,
      gameOver: this.gameOver,
      winnerSeatId: this.winnerSeatId,
      currentIndex: this.currentIndex,
      roundCount: this.roundCount,
      vacationPot: this.vacationPot,
      canActNow: this.canActNow,
      tileState: this.tileState,
      tradeHistory: this.tradeHistory.slice(0,15),
      log: this.log.slice(-60),
      yourSeatId: seatId,
      haunted: viewerIsGhost ? Array.from(this.hauntedTiles.entries()).map(([i,h])=>({tileIndex:i, ghostSeatId:h.ghostSeatId})) : undefined,
      seats: this.seats.map(s=>{
        const base = {id:s.id, name:s.name, color:s.color, isBot:s.isBot, connected:s.connected||s.isBot===false,
          wasHuman:s.wasHuman, position:s.position, isGhost:s.isGhost, inJail:s.inJail, jailCards:s.jailCards};
        if (s.isGhost && !(viewer===s)){
          return base; // hide cash/spiritFund of ghosts from everyone except themselves
        }
        return {...base, cash:s.cash, spiritFund:s.isGhost?s.spiritFund:undefined};
      }),
    };
  }
}

function claimHomeless(){ /* symmetry no-op: server has no board "home" concept beyond seat defaults */ }

function netWorth(room, p){
  let v = p.cash;
  for (const i of room._ownedTiles(p.id)){
    const t=BOARD[i], ts=room.tileState[i];
    v += ts.mortgaged ? Math.round(t.price*0.5) : t.price;
    if (ts.houses>0 && GROUPS[t.group]) v += ts.houses*GROUPS[t.group].houseCost*0.5;
  }
  return v;
}

function randomToken(){
  return Array.from({length:24}, ()=> 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join('');
}

// ===========================================================================
// SABOTAGE EFFECTS — ported from the single-player client
// ===========================================================================
const SABOTAGE_EFFECTS = [
  {key:'fine', weight:3, run: async (room, victim, ghost)=>{
    const amt = 50 + Math.floor(Math.random()*101);
    await room._payDebt(victim, amt, {ghost}, 'a ghostly toll');
    return `${victim.name} pays a $${amt} ghostly toll into ${ghost.name}'s spirit fund.`;
  }},
  {key:'skip', weight:2, run: async (room, victim)=>{
    victim.skipNextTurn = true;
    return `${victim.name} falls into a spectral slumber and will skip their next turn.`;
  }},
  {key:'jail', weight:2, run: async (room, victim)=>{
    room._sendToJail(victim);
    return `${victim.name} is dragged straight to the Crypt!`;
  }},
  {key:'cardSteal', weight:2, run: async (room, victim, ghost)=>{
    if (victim.jailCards>0){
      victim.jailCards--; ghost.spiritFund += 100;
      return `${victim.name}'s Return Home Free card vanishes into the fog! ${ghost.name}'s spirit fund grows by $100.`;
    }
    const amt = 50+Math.floor(Math.random()*51);
    await room._payDebt(victim, amt, {ghost}, 'a ghostly toll (no card to steal)');
    return `${victim.name} had no card to lose, so pays a $${amt} ghostly toll instead.`;
  }},
  {key:'cursedRent', weight:1, run: async (room, victim)=>{
    victim.nextRentMultiplier = 2;
    return `${victim.name} is cursed — their next rent payment will be doubled!`;
  }},
];

// ===========================================================================
// BOT DECISIONS — ported from the single-player client
// ===========================================================================
function botDecide(room, seat, type, payload){
  switch (type){
    // 'post_move' never reaches here — _postMoveActions() special-cases bots
    // directly so it can await maybeBotProposeTrade() alongside building.
    case 'jail_choice': return seat.jailCards>0 ? 'card' : (seat.cash>=250 ? 'pay' : 'roll');
    case 'buy_decision': return (seat.cash - payload.price) >= 150;
    case 'auction_bid': {
      const valuation = BOARD[payload.tileIndex].price * (0.6+Math.random()*0.7);
      return (payload.currentBid+10<=valuation) && (payload.currentBid+10<=seat.cash);
    }
    case 'manage_assets': return {give_up:true}; // bots use _autoRaiseCash instead; see _payDebt
    case 'revive_choice': return true;
    case 'haunt_choice': return room.chooseHauntTile(seat);
    case 'review_trade': {
      // reconstruct enough context to reuse botEvaluateTrade's shape
      const fromSeat = room.seats.find(s=>s.name===payload.fromName) || {id:-1};
      const toProps = (payload.toProps||[]).map(x=>x.i);
      const fromProps = (payload.fromProps||[]).map(x=>x.i);
      return botEvaluateTrade(room, seat, fromSeat.id, toProps, payload.toCash, fromProps, payload.fromCash);
    }
    default: return null;
  }
}

function botManageProperties(room, p){
  const reserve = 120;
  let built = true;
  while (built){
    built = false;
    const owned = room._ownedTiles(p.id).filter(i=>BOARD[i].type==='property');
    for (const i of owned){
      const t=BOARD[i], ts=room.tileState[i];
      if (room._ownerHasFullGroup(p.id,t.group) && !groupTiles(t.group).some(j=>room.tileState[j].mortgaged) &&
          ts.houses<5 && ts.houses===Math.min(...groupTiles(t.group).map(j=>room.tileState[j].houses)) &&
          p.cash-GROUPS[t.group].houseCost>=reserve){
        ts.houses++; p.cash-=GROUPS[t.group].houseCost;
        room.log_(`${p.name} builds on ${t.name} (now ${ts.houses>=5?'a hotel':ts.houses+' house(s)'}).`);
        built = true; break;
      }
    }
  }
}

function botEvaluateTrade(room, bot, otherSeatId, botGives, botGivesCash, botGets, botGetsCash){
  if (botGivesCash > bot.cash-50) return false;
  const received = room._tradeSideValue(bot.id, botGets, botGetsCash);
  let given = botGivesCash;
  for (const i of botGives){
    let pv = room._propertyValue(i);
    if (room._wouldCompleteGroup(otherSeatId, i, botGives)) pv = Math.round(pv*2.0);
    given += pv;
  }
  return received >= given*0.82;
}

module.exports = { Room };
