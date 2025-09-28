// backend/server.js (ESM)
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const startedAt = new Date();

// ---- HTTP handler for health + simple debug ----
function requestHandler(req, res) {
  // Let Socket.IO handle its own path
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  const path = url.pathname;

  if (path.startsWith('/socket.io')) {
    // socket.io will respond
    return;
  }

  // Compute quick stats
  const roomsCount = rooms.size;
  const usersCount = [...rooms.values()].reduce((sum, r) => sum + r.users.size, 0);
  const socketsCount = io ? io.of('/').sockets.size : 0;
  const upSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);

  if (path === '/healthz') {
    const payload = {
      status: 'ok',
      startedAt: startedAt.toISOString(),
      upSeconds,
      rooms: roomsCount,
      users: usersCount,
      sockets: socketsCount,
      pid: process.pid,
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (path === '/' || path === '/health') {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Server Health</title>
  <meta http-equiv="refresh" content="3" />
  <style>
    body{font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 24px; color:#111}
    .ok{display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;vertical-align:middle;margin-right:8px}
    .card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;max-width:640px}
    h1{font-size:20px;margin:0 0 8px}
    table{border-collapse:collapse;width:100%;margin-top:8px}
    td{padding:6px 0;border-bottom:1px solid #f1f5f9}
    td:first-child{color:#64748b;width:180px}
    small{color:#64748b}
    code{background:#f8fafc;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <div class="card">
    <h1><span class="ok"></span>Server is running</h1>
    <table>
      <tr><td>Started</td><td>${startedAt.toISOString()}</td></tr>
      <tr><td>Uptime</td><td>${upSeconds}s</td></tr>
      <tr><td>PID</td><td>${process.pid}</td></tr>
      <tr><td>Rooms</td><td>${roomsCount}</td></tr>
      <tr><td>Users</td><td>${usersCount}</td></tr>
      <tr><td>Sockets</td><td>${socketsCount}</td></tr>
      <tr><td>Memory (MB)</td><td>${toMB(process.memoryUsage().rss)} rss / ${toMB(process.memoryUsage().heapUsed)} heap</td></tr>
    </table>
    <p><small>JSON probe: <code>/healthz</code></small></p>
  </div>
</body>
</html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function toMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

const httpServer = createServer(requestHandler);
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET','POST'] } });

/**
 * rooms: Map<roomId, {
 *   users: Map<socketId, { id,name,joinedAt }>
 *   hostId: string
 *   spins: number
 *   lockUntil?: number | null
 *   pendingHostId?: string | null
 * }>
 */
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }, cb) => {
    const roomId = genCode();
    const room = { users: new Map(), hostId: socket.id, spins: 0, lockUntil: null, pendingHostId: null };
    rooms.set(roomId, room);
    const clean = uniqueName(room, sanitizeName(name));
    room.users.set(socket.id, { id: socket.id, name: clean, joinedAt: Date.now() });
    socket.join(roomId);
    cb?.({ ok: true, roomId });
    emitState(roomId);
  });

  socket.on('join_room', ({ roomId, name }, cb) => {
    const room = rooms.get(roomId);
    if (!room) { cb?.({ ok: false, error: 'ROOM_NOT_FOUND' }); socket.emit('join_error', { reason: 'Room not found' }); return; }
    const clean = uniqueName(room, sanitizeName(name));
    room.users.set(socket.id, { id: socket.id, name: clean, joinedAt: Date.now() });
    socket.join(roomId);
    cb?.({ ok: true, roomId });
    emitState(roomId);
  });

  // leave_room
  socket.on('leave_room', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) { cb?.({ ok: true }); return; }
    room.users.delete(socket.id);
    socket.leave(roomId);

    // If the leaver was host, promote next; if room empty, delete
    if (room.hostId === socket.id) {
      const next = [...room.users.keys()][0];
      if (next) room.hostId = next; else { rooms.delete(roomId); cb?.({ ok: true }); return; }
    }
    // If the leaver was pending winner, keep the lock but fallback on switch
    if (room.pendingHostId === socket.id) {
      // Will resolve on switch time to whoever is first in room
    }

    emitState(roomId);
    cb?.({ ok: true });
  });

  socket.on('set_name', ({ roomId, name }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false });
    const user = room.users.get(socket.id);
    if (!user) return cb?.({ ok: false });
    const clean = uniqueName(room, sanitizeName(name));
    user.name = clean;
    emitState(roomId);
    cb?.({ ok: true, name: clean });
  });

  socket.on('spin_request', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const now = Date.now();
    const finished = !room.lockUntil || now >= room.lockUntil;
    const isCurrentHost = room.hostId === socket.id;
    const isPendingWinnerNowHost = room.pendingHostId === socket.id && finished;

    if (!isCurrentHost && !isPendingWinnerNowHost) return;

    if (room.lockUntil && now < room.lockUntil) {
      io.to(socket.id).emit('spin_denied', { reason: 'A spin is already in progress.' });
      return;
    }

    const order = [...room.users.values()].sort((a,b)=>a.joinedAt-b.joinedAt).slice(0, 10);
    if (order.length < 2) {
      io.to(socket.id).emit('spin_denied', { reason: 'Need at least 2 players.' });
      return;
    }

    room.spins += 1;

    const seed = Date.now();
    const targetIndex = seededPick(seed, order.length);
    const winnerId = order[targetIndex].id;

    const turns = 4 + Math.floor(Math.random() * 2);
    const durationMs = 3400 + Math.floor(Math.random() * 400);
    const startAt = now + 600;
    const hostSwitchAt = startAt + durationMs + 250;

    room.lockUntil = hostSwitchAt;
    room.pendingHostId = winnerId;

    io.to(roomId).emit('spin_start', {
      orderIds: order.map(u => u.id),
      targetIndex,
      durationMs,
      turns,
      startAt,
      nextHostId: winnerId,
      hostSwitchAt,
      spins: room.spins,
    });

    setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r) return;
      const stillHere = r.users.has(r.pendingHostId);
      r.hostId = stillHere ? r.pendingHostId : ([...r.users.keys()][0] || r.hostId);
      r.pendingHostId = null;
      r.lockUntil = null;
      emitState(roomId);
    }, Math.max(0, hostSwitchAt - Date.now()));
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms) {
      if (!room.users.delete(socket.id)) continue;

      if (room.hostId === socket.id) {
        const next = [...room.users.keys()][0];
        if (next) room.hostId = next; else { rooms.delete(roomId); continue; }
      }
      emitState(roomId);
    }
  });
});

function emitState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const users = [...room.users.values()].sort((a,b)=>a.joinedAt-b.joinedAt);
  io.to(roomId).emit('room_state', {
    roomId,
    users,
    hostId: room.hostId,
    spins: room.spins,
    lockUntil: room.lockUntil || null,
  });
}

function seededPick(seed, n) {
  let x = seed ^ 0x9e3779b9;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  return Math.abs(x) % n;
}

function genCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I,O,1,0
  let code = '';
  for (let i=0;i<6;i++) code += alphabet[(Math.random()*alphabet.length)|0];
  if (rooms.has(code)) return genCode();
  return code;
}

function sanitizeName(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  const capped = s.slice(0, 20);
  return capped || `Player ${Math.floor(100 + Math.random() * 900)}`;
}

function uniqueName(room, baseName) {
  const taken = new Set([...room.users.values()].map(u => u.name.toLowerCase()));
  if (!taken.has(baseName.toLowerCase())) return baseName;
  for (let i = 2; i < 99; i++) {
    const cand = `${baseName} ${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return `${baseName} *`;
}

httpServer.listen(80, () => console.log('Socket server on :80'));
