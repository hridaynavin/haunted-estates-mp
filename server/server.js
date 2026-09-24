'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');
const { Room } = require('./gameEngine');

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 1000 * 60 * 60 * 6; // reap rooms idle for 6h so memory doesn't grow forever

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);

// Explicit CORS allow-list for the socket.io handshake (polling + WS upgrade).
// - Render URL: this backend's own origin (harmless to include, but the static
//   public/ site itself is now hosted separately, so it's mostly a safety net).
// - CrazyGames serves uploaded HTML5 games from a per-game subdomain of
//   game-files.crazygames.com (e.g. https://cubes-2048-io.game-files.crazygames.com),
//   not from crazygames.com directly, so the allow-list matches that pattern.
//   Confirmed against CrazyGames' own docs: https://docs.crazygames.com/resources/html5/sitelock/
const ALLOWED_ORIGINS = [
  'https://haunted-estates.onrender.com',
  /^https:\/\/[a-z0-9-]+\.game-files\.crazygames\.com$/,
];
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS } });

/** @type {Map<string, Room>} */
const rooms = new Map();
const nanoRoomCode = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 6);

function makeRoomCode(){
  let code;
  do { code = nanoRoomCode(); } while (rooms.has(code));
  return code;
}

function broadcastRoom(room, events){
  for (const seat of room.seats){
    if (seat.socketId){
      const sock = io.sockets.sockets.get(seat.socketId);
      if (sock) sock.emit('state', room.viewFor(seat.id));
    }
  }
  for (const sockId of room.spectatorSocketIds){
    const sock = io.sockets.sockets.get(sockId);
    if (sock) sock.emit('state', room.viewFor(null));
  }
  if (events && events.length) io.to(room.code).emit('events', events);
  if (room.pendingIntent){
    const seat = room.seats[room.pendingIntent.seatId];
    if (seat && !seat.isBot && seat.socketId){
      const sock = io.sockets.sockets.get(seat.socketId);
      if (sock) sock.emit('prompt', {type: room.pendingIntent.type, payload: room._pendingIntentPayload});
    }
  }
}

function findRoom(code){ return rooms.get(String(code||'').toLowerCase()); }
function seatByToken(room, token){ return room && room.seats.find(s=>s.token===token); }

io.on('connection', (socket)=>{
  let joinedRoomCode = null;
  let joinedSeatId = null;
  let isSpectator = false;

  socket.on('create_room', (opts={}, ack)=>{
    const code = makeRoomCode();
    const room = new Room(code, {
      maxSeats: opts.maxSeats, startingCash: opts.startingCash, reviveThreshold: opts.reviveThreshold,
    }, broadcastRoom);
    rooms.set(code, room);
    const seat = room.claimSeatForNewPlayer(opts.name || 'Host');
    seat.socketId = socket.id;
    room.hostSeatId = seat.id;
    joinedRoomCode = code; joinedSeatId = seat.id;
    socket.join(code);
    if (typeof ack==='function') ack({ok:true, roomCode:code, token:seat.token, seatId:seat.id, hostSeatId: room.hostSeatId});
    broadcastRoom(room, []);
  });

  socket.on('join_room', ({roomCode, name}={}, ack)=>{
    const room = findRoom(roomCode);
    if (!room){ if (typeof ack==='function') ack({ok:false, error:'Room not found.'}); return; }
    socket.join(room.code);
    const seat = room.started ? null : room.claimSeatForNewPlayer(name);
    if (seat){
      seat.socketId = socket.id;
      joinedRoomCode = room.code; joinedSeatId = seat.id;
      if (typeof ack==='function') ack({ok:true, roomCode:room.code, token:seat.token, seatId:seat.id, hostSeatId: room.hostSeatId, started: room.started});
      broadcastRoom(room, []);
    } else {
      room.spectatorSocketIds.add(socket.id);
      joinedRoomCode = room.code; isSpectator = true;
      if (typeof ack==='function') ack({ok:true, roomCode:room.code, spectator:true, started: room.started});
      socket.emit('state', room.viewFor(null));
    }
  });

  socket.on('reconnect_room', ({roomCode, token}={}, ack)=>{
    const room = findRoom(roomCode);
    if (!room){ if (typeof ack==='function') ack({ok:false, error:'Room not found.'}); return; }
    const seat = seatByToken(room, token);
    if (!seat){ if (typeof ack==='function') ack({ok:false, error:'That seat no longer exists.'}); return; }
    socket.join(room.code);
    room.reclaimSeat(token);
    seat.socketId = socket.id;
    joinedRoomCode = room.code; joinedSeatId = seat.id;
    if (typeof ack==='function') ack({ok:true, roomCode:room.code, token:seat.token, seatId:seat.id, hostSeatId: room.hostSeatId, started: room.started});
    room.log_(`${seat.name} reconnected.`);
    broadcastRoom(room, []);
  });

  socket.on('start_game', ({roomCode, token}={})=>{
    const room = findRoom(roomCode);
    const seat = seatByToken(room, token);
    if (!room || !seat || seat.id!==room.hostSeatId || room.started) return;
    room.start();
  });

  function requireSeat(roomCode, token){
    const room = findRoom(roomCode);
    const seat = seatByToken(room, token);
    if (!room || !seat || seat.socketId!==socket.id) return {};
    return {room, seat};
  }

  socket.on('intent', ({roomCode, token, type, payload}={})=>{
    const {room, seat} = requireSeat(roomCode, token);
    if (!room || !seat) return;
    room.resolveIntent(seat.id, type, payload);
  });
  socket.on('build', ({roomCode, token, tileIndex}={})=>{
    const {room, seat} = requireSeat(roomCode, token);
    if (room && seat) room.build(seat.id, tileIndex);
  });
  socket.on('sell_house', ({roomCode, token, tileIndex}={})=>{
    const {room, seat} = requireSeat(roomCode, token);
    if (room && seat) room.sellHouse(seat.id, tileIndex);
  });
  socket.on('mortgage', ({roomCode, token, tileIndex}={})=>{
    const {room, seat} = requireSeat(roomCode, token);
    if (room && seat) room.mortgage(seat.id, tileIndex);
  });
  socket.on('unmortgage', ({roomCode, token, tileIndex}={})=>{
    const {room, seat} = requireSeat(roomCode, token);
    if (room && seat) room.unmortgage(seat.id, tileIndex);
  });
  socket.on('end_turn', ({roomCode, token}={})=>{
    const {room, seat} = requireSeat(roomCode, token);
    if (room && seat) room.endTurn(seat.id);
  });
  socket.on('concede', ({roomCode, token}={})=>{
    const {room, seat} = requireSeat(roomCode, token);
    if (room && seat) room.concede(seat.id);
  });
  socket.on('propose_trade', ({roomCode, token, toSeatId, fromProps, fromCash, toProps, toCash}={})=>{
    const {room, seat} = requireSeat(roomCode, token);
    if (room && seat) room.proposeTrade(seat.id, toSeatId, fromProps||[], fromCash||0, toProps||[], toCash||0);
  });

  socket.on('disconnect', ()=>{
    if (!joinedRoomCode) return;
    const room = rooms.get(joinedRoomCode);
    if (!room) return;
    if (isSpectator){ room.spectatorSocketIds.delete(socket.id); return; }
    const seat = room.seats[joinedSeatId];
    if (seat && seat.socketId===socket.id){
      room.onSeatDisconnected(seat);
      room.log_(`${seat.name} disconnected — a ghostly hand takes the wheel.`);
      broadcastRoom(room, []);
    }
  });
});

// periodic sweep for abandoned rooms (nobody connected and idle for a while)
setInterval(()=>{
  const now = Date.now();
  for (const [code, room] of rooms){
    const anyoneConnected = room.seats.some(s=>s.socketId) || room.spectatorSocketIds.size>0;
    if (!anyoneConnected && now - room.lastActivityAt > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 1000*60*30);

server.listen(PORT, ()=>{
  console.log(`Haunted Estates multiplayer server listening on :${PORT}`);
});
