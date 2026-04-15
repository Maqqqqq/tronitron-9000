import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Game constants
const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;
const TRAIL_THICKNESS = 10;
const HALF_TRAIL = TRAIL_THICKNESS / 2;
const PLAYER_SIZE = 12;
const HALF_PLAYER = PLAYER_SIZE / 2;
const PLAYER_SPEED = 240; // pixels per second
const TRAIL_LIFETIME_MS = 2000;
const POWERUP_SPAWN_INTERVAL = 5000;
const POWERUP_LIFETIME_MS = 8000;
const MAX_POWERUPS = 2;
const POWERUP_RADIUS = 18;
const SPEED_BOOST_MULTIPLIER = 1.65;
const SPEED_BOOST_DURATION_MS = 3000;
const POWERUP_TYPES = ['speed', 'trailCleanse'];
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const TICK_RATE = 60;
const MAX_ROUND_TIME_MS = 3 * 60 * 1000; // 3 minutes

const PLAYER_COLORS = ['#00f6ff', '#ff2277', '#29ff4f', '#ffc400'];
const INITIAL_POSITIONS = [
  { x: GAME_WIDTH * 0.18, y: GAME_HEIGHT * 0.28, dir: 'right' },
  { x: GAME_WIDTH * 0.82, y: GAME_HEIGHT * 0.72, dir: 'left' },
  { x: GAME_WIDTH * 0.82, y: GAME_HEIGHT * 0.28, dir: 'left' },
  { x: GAME_WIDTH * 0.18, y: GAME_HEIGHT * 0.72, dir: 'right' },
];

const DIRECTION_VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITES = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

let lobbyPlayers = new Map(); // socketId -> lobby info
let hostId = null;

const gameState = {
  status: 'waiting', // waiting | running | paused | ended
  players: new Map(), // socketId -> player state
  timerMs: 0,
  loopHandle: null,
  lastTick: null,
  powerUps: [],
  lastPowerUpSpawn: 0,
};

function broadcastLobbyUpdate() {
  const players = Array.from(lobbyPlayers.values()).map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    isHost: player.id === hostId,
  }));
  io.emit('lobbyUpdate', {
    players,
    hostId,
    status: gameState.status,
  });
}

function resetGameState() {
  if (gameState.loopHandle) {
    clearInterval(gameState.loopHandle);
    gameState.loopHandle = null;
  }
  gameState.status = 'waiting';
  gameState.players.clear();
  gameState.timerMs = 0;
  gameState.lastTick = null;
  gameState.powerUps = [];
  gameState.lastPowerUpSpawn = 0;
}

function createPlayerState(lobbyPlayer, index, timestamp) {
  const start = INITIAL_POSITIONS[index];
  const dir = start.dir;
  const vector = { ...DIRECTION_VECTORS[dir] };
  const position = { x: start.x, y: start.y };
  const segment = {
    x1: position.x,
    y1: position.y,
    x2: position.x,
    y2: position.y,
    startTime: timestamp,
    endTime: timestamp,
  };
  return {
    id: lobbyPlayer.id,
    name: lobbyPlayer.name,
    color: lobbyPlayer.color,
    alive: true,
    position,
    lastPosition: { ...position },
    direction: dir,
    vector,
    pendingDirection: null,
    segments: [segment],
    score: 0,
    deaths: 0,
    speedMultiplier: 1,
    speedBoostUntil: 0,
    bonusScore: 0,
  };
}

function startMatch() {
  const activeLobbyPlayers = Array.from(lobbyPlayers.values());
  if (activeLobbyPlayers.length < MIN_PLAYERS) {
    sendSystemMessage(`Need at least ${MIN_PLAYERS} players to start`);
    gameState.status = 'waiting';
    return;
  }

  const startTimestamp = Date.now();
  gameState.status = 'running';
  gameState.timerMs = 0;
  gameState.lastTick = startTimestamp;
  gameState.powerUps = [];
  gameState.lastPowerUpSpawn = startTimestamp;
  gameState.players.clear();

  activeLobbyPlayers.forEach((player, index) => {
    gameState.players.set(player.id, createPlayerState(player, index, startTimestamp));
  });

  io.emit('matchStarted', {
    arena: { width: GAME_WIDTH, height: GAME_HEIGHT },
    players: serializePlayers(),
    powerUps: serializePowerUps(),
  });

  sendSystemMessage('Match started');

  if (gameState.loopHandle) {
    clearInterval(gameState.loopHandle);
  }
  gameState.loopHandle = setInterval(gameTick, 1000 / TICK_RATE);
}

function resumeMatch(resumerId) {
  if (gameState.status !== 'paused') return;
  gameState.status = 'running';
  gameState.lastTick = Date.now();
  gameState.lastPowerUpSpawn = Date.now();
  sendSystemMessage(`${getPlayerName(resumerId)} resumed the game`);
}

function pauseMatch(pauserId) {
  if (gameState.status !== 'running') return;
  gameState.status = 'paused';
  sendSystemMessage(`${getPlayerName(pauserId)} paused the game`);
}

function quitMatch(quitterId) {
  if (gameState.status === 'waiting') return;
  sendSystemMessage(`${getPlayerName(quitterId)} quit the match`);
  endMatch({ reason: 'quit' });
}

function restartMatch(requesterId) {
  if (requesterId !== hostId) return;
  if (lobbyPlayers.size < MIN_PLAYERS) {
    io.to(requesterId).emit('errorMessage', {
      message: `Need at least ${MIN_PLAYERS} players to restart`,
    });
    return;
  }
  sendSystemMessage(`${getPlayerName(requesterId)} restarted the match`);
  resetGameState();
  startMatch();
}

function getPlayerName(socketId) {
  return lobbyPlayers.get(socketId)?.name || 'Someone';
}

function gameTick() {
  if (gameState.status !== 'running') {
    gameState.lastTick = Date.now();
    return;
  }

  const now = Date.now();
  const deltaMs = now - gameState.lastTick;
  const deltaSeconds = deltaMs / 1000;
  gameState.lastTick = now;
  gameState.timerMs += deltaMs;

  if (gameState.timerMs >= MAX_ROUND_TIME_MS) {
    endMatch({ reason: 'timer' });
    return;
  }

  const alivePlayers = Array.from(gameState.players.values()).filter((p) => p.alive);

  alivePlayers.forEach((player) => {
    if (player.pendingDirection && player.pendingDirection !== player.direction) {
      finalizePlayerSegment(player, now);
      player.direction = player.pendingDirection;
      player.vector = { ...DIRECTION_VECTORS[player.direction] };
      player.pendingDirection = null;
    }

    if (player.speedBoostUntil && now > player.speedBoostUntil) {
      player.speedMultiplier = 1;
      player.speedBoostUntil = 0;
    }

    player.lastPosition = { ...player.position };
    const effectiveSpeed = PLAYER_SPEED * (player.speedMultiplier || 1);
    player.position.x += player.vector.x * effectiveSpeed * deltaSeconds;
    player.position.y += player.vector.y * effectiveSpeed * deltaSeconds;

    const currentSegment = player.segments[player.segments.length - 1];
    currentSegment.x2 = player.position.x;
    currentSegment.y2 = player.position.y;
    currentSegment.endTime = now;

    trimPlayerTrail(player, now);
  });

  gameState.players.forEach((player) => {
    if (!alivePlayers.includes(player)) {
      trimPlayerTrail(player, now);
    }
  });

  updatePowerUps(now);

  alivePlayers.forEach((player) => {
    if (!player.alive) return;
    checkPowerUpCollisions(player, now);
    if (detectCollision(player)) {
      player.alive = false;
      player.score = Math.floor(gameState.timerMs / 1000) + (player.bonusScore || 0);
      sendSystemMessage(`${player.name} crashed!`);
    }
  });

  const survivors = Array.from(gameState.players.values()).filter((p) => p.alive);
  if (survivors.length <= 1) {
    endMatch({ reason: 'elimination' });
    return;
  }

  alivePlayers.forEach((player) => {
    if (player.alive) {
      player.score = Math.floor(gameState.timerMs / 1000) + (player.bonusScore || 0);
    }
  });

  io.emit('stateUpdate', {
    timerMs: gameState.timerMs,
    players: serializePlayers(),
    status: gameState.status,
    powerUps: serializePowerUps(),
  });
}

function finalizePlayerSegment(player, timestamp) {
  const { position } = player;
  const segment = {
    x1: position.x,
    y1: position.y,
    x2: position.x,
    y2: position.y,
    startTime: timestamp,
    endTime: timestamp,
  };
  player.segments.push(segment);
}

function detectCollision(player) {
  const { position } = player;
  if (
    position.x < HALF_PLAYER ||
    position.x > GAME_WIDTH - HALF_PLAYER ||
    position.y < HALF_PLAYER ||
    position.y > GAME_HEIGHT - HALF_PLAYER
  ) {
    return true;
  }

  const headRect = {
    left: position.x - HALF_PLAYER,
    right: position.x + HALF_PLAYER,
    top: position.y - HALF_PLAYER,
    bottom: position.y + HALF_PLAYER,
  };

  // Build a flattened list of segments and remember ownership for collision checks
  const segmentEntries = Array.from(gameState.players.values()).flatMap((p) =>
    p.segments.map((segment, idx, arr) => ({
      ownerId: p.id,
      segment,
      skip: p.id === player.id && idx === arr.length - 1,
    }))
  );

  return segmentEntries.some(({ ownerId, segment, skip }) => {
    if (skip) return false;
    const rect = segmentToRect(segment);
    if (!rect) return false;
    if (ownerId === player.id && isAtSegmentEndpoint(position, segment)) {
      return false;
    }
    const buffer = ownerId === player.id ? HALF_PLAYER : 0;
    return isRectOverlap(headRect, rect, buffer);
  });
}

function segmentToRect(segment) {
  const { x1, y1, x2, y2 } = segment;
  if (x1 === x2 && y1 === y2) return null;
  if (x1 === x2) {
    const top = Math.min(y1, y2) - HALF_TRAIL;
    const bottom = Math.max(y1, y2) + HALF_TRAIL;
    return {
      left: x1 - HALF_TRAIL,
      right: x1 + HALF_TRAIL,
      top,
      bottom,
    };
  }
  if (y1 === y2) {
    const left = Math.min(x1, x2) - HALF_TRAIL;
    const right = Math.max(x1, x2) + HALF_TRAIL;
    return {
      left,
      right,
      top: y1 - HALF_TRAIL,
      bottom: y1 + HALF_TRAIL,
    };
  }
  return null;
}

function isRectOverlap(a, b, buffer = 0) {
  return (
    a.left + buffer < b.right &&
    a.right - buffer > b.left &&
    a.top + buffer < b.bottom &&
    a.bottom - buffer > b.top
  );
}

function isAtSegmentEndpoint(position, segment) {
  const dxEnd = position.x - segment.x2;
  const dyEnd = position.y - segment.y2;
  if (dxEnd * dxEnd + dyEnd * dyEnd <= PLAYER_SIZE * PLAYER_SIZE) {
    return true;
  }
  const dxStart = position.x - segment.x1;
  const dyStart = position.y - segment.y1;
  return dxStart * dxStart + dyStart * dyStart <= PLAYER_SIZE * PLAYER_SIZE;
}

function trimPlayerTrail(player, timestamp) {
  const cutoff = timestamp - TRAIL_LIFETIME_MS;
  const segments = player.segments;
  if (segments.length === 0) return;

  for (let i = 0; i < segments.length; ) {
    const segment = segments[i];
    const startTime = segment.startTime ?? timestamp;
    const endTime = segment.endTime ?? timestamp;

    if (endTime < cutoff && segments.length > 1) {
      segments.splice(i, 1);
      continue;
    }

    if (startTime < cutoff && endTime > cutoff) {
      const duration = endTime - startTime || 1;
      const ratio = (cutoff - startTime) / duration;
      if (segment.x1 === segment.x2) {
        const delta = segment.y2 - segment.y1;
        segment.y1 = segment.y1 + delta * ratio;
      } else {
        const delta = segment.x2 - segment.x1;
        segment.x1 = segment.x1 + delta * ratio;
      }
      segment.startTime = cutoff;
    } else if (startTime >= cutoff) {
      segment.startTime = Math.max(segment.startTime ?? cutoff, cutoff);
    }

    i += 1;
  }

  while (segments.length > 1) {
    const oldest = segments[0];
    const endTime = oldest.endTime ?? timestamp;
    if (endTime < cutoff) {
      segments.shift();
    } else {
      break;
    }
  }

  if (segments.length === 1) {
    const segment = segments[0];
    const endTime = segment.endTime ?? timestamp;
    if (endTime < cutoff) {
      segment.x1 = segment.x2;
      segment.y1 = segment.y2;
      segment.startTime = endTime;
    }
  }
}

function updatePowerUps(now) {
  if (now - gameState.lastPowerUpSpawn >= POWERUP_SPAWN_INTERVAL) {
    if (gameState.powerUps.length < MAX_POWERUPS) {
      spawnPowerUp(now);
    }
    gameState.lastPowerUpSpawn = now;
  }

  const cutoff = now - POWERUP_LIFETIME_MS;
  gameState.powerUps = gameState.powerUps.filter((powerUp) => powerUp.spawnedAt >= cutoff);
}

function spawnPowerUp(now) {
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  const margin = 40;
  const x = margin + Math.random() * (GAME_WIDTH - margin * 2);
  const y = margin + Math.random() * (GAME_HEIGHT - margin * 2);
  const powerUp = {
    id: `${now}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    x,
    y,
    spawnedAt: now,
  };
  gameState.powerUps.push(powerUp);
}

function checkPowerUpCollisions(player, now) {
  if (!player.alive) return;
  const { position } = player;
  const hitIndex = gameState.powerUps.findIndex((powerUp) => {
    const dx = position.x - powerUp.x;
    const dy = position.y - powerUp.y;
    const radius = POWERUP_RADIUS + HALF_PLAYER;
    return dx * dx + dy * dy <= radius * radius;
  });

  if (hitIndex === -1) return;

  const [powerUp] = gameState.powerUps.splice(hitIndex, 1);
  applyPowerUpEffect(player, powerUp, now);
}

function applyPowerUpEffect(player, powerUp, now) {
  switch (powerUp.type) {
    case 'speed':
      player.speedMultiplier = SPEED_BOOST_MULTIPLIER;
      player.speedBoostUntil = now + SPEED_BOOST_DURATION_MS;
      sendSystemMessage(`${player.name} snagged a speed boost!`);
      break;
    case 'trailCleanse':
      clearPlayerTrail(player, now);
      sendSystemMessage(`${player.name} vaporized their trail!`);
      break;
    default:
      break;
  }
  player.bonusScore = (player.bonusScore || 0) + 2;
  player.score = Math.floor(gameState.timerMs / 1000) + player.bonusScore;
}

function clearPlayerTrail(player, now) {
  const { position } = player;
  player.segments = [
    {
      x1: position.x,
      y1: position.y,
      x2: position.x,
      y2: position.y,
      startTime: now,
      endTime: now,
    },
  ];
}

function serializePowerUps() {
  return gameState.powerUps.map((powerUp) => ({
    id: powerUp.id,
    type: powerUp.type,
    x: powerUp.x,
    y: powerUp.y,
    spawnedAt: powerUp.spawnedAt,
  }));
}

function serializePlayers() {
  return Array.from(gameState.players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    alive: player.alive,
    position: { ...player.position },
    direction: player.direction,
    segments: player.segments.map((segment) => ({ ...segment })),
    score: player.score,
    bonusScore: player.bonusScore || 0,
    speedMultiplier: player.speedMultiplier || 1,
  }));
}

function endMatch({ reason }) {
  if (!['running', 'paused'].includes(gameState.status)) {
    return;
  }

  gameState.status = 'ended';
  const players = serializePlayers();
  const winner = calculateWinner(players);
  io.emit('matchEnded', {
    reason,
    players,
    timerMs: gameState.timerMs,
    winner,
    powerUps: serializePowerUps(),
  });

  sendSystemMessage(
    winner
      ? `${winner.name} wins the round!`
      : 'Round ended with no winner'
  );
}

function calculateWinner(players) {
  const alive = players.filter((p) => p.alive);
  if (alive.length === 1) {
    return alive[0];
  }
  const sorted = [...players].sort((a, b) => b.score - a.score);
  if (sorted[0] && sorted[0].score > (sorted[1]?.score ?? -1)) {
    return sorted[0];
  }
  return null;
}

function sendSystemMessage(message) {
  io.emit('systemMessage', {
    message,
    timestamp: Date.now(),
  });
}

io.on('connection', (socket) => {
  socket.emit('lobbySnapshot', {
    players: Array.from(lobbyPlayers.values()),
    hostId,
    status: gameState.status,
  });

  socket.on('joinLobby', ({ name }, callback) => {
    if (typeof name !== 'string' || !name.trim()) {
      callback?.({ ok: false, error: 'Name is required' });
      return;
    }
    const trimmed = name.trim().slice(0, 18);

    if (gameState.status !== 'waiting') {
      callback?.({ ok: false, error: 'Match already in progress' });
      return;
    }

    if (lobbyPlayers.size >= MAX_PLAYERS) {
      callback?.({ ok: false, error: 'Lobby is full' });
      return;
    }

    const exists = Array.from(lobbyPlayers.values()).some(
      (player) => player.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (exists) {
      callback?.({ ok: false, error: 'Name already taken' });
      return;
    }

    const color = PLAYER_COLORS[lobbyPlayers.size % PLAYER_COLORS.length];
    const lobbyPlayer = {
      id: socket.id,
      name: trimmed,
      color,
    };
    lobbyPlayers.set(socket.id, lobbyPlayer);

    if (!hostId) {
      hostId = socket.id;
    }

    socket.join('players');
    broadcastLobbyUpdate();
    sendSystemMessage(`${trimmed} joined the lobby`);
    callback?.({ ok: true, player: lobbyPlayer, hostId });
  });

  socket.on('startGame', () => {
    if (socket.id !== hostId) return;
    if (gameState.status !== 'waiting') return;
    if (lobbyPlayers.size < MIN_PLAYERS) {
      socket.emit('errorMessage', {
        message: `Need at least ${MIN_PLAYERS} players to start`,
      });
      return;
    }
    startMatch();
  });

  socket.on('changeDirection', (dir) => {
    if (!['up', 'down', 'left', 'right'].includes(dir)) return;
    if (!gameState.players.has(socket.id)) return;
    const player = gameState.players.get(socket.id);
    if (!player.alive) return;
    if (dir === player.direction || dir === OPPOSITES[player.direction]) {
      if (dir === player.direction) return;
      // Prevent 180-degree turn
      if (dir === OPPOSITES[player.direction]) return;
    }
    player.pendingDirection = dir;
  });

  socket.on('pauseGame', () => {
    if (!gameState.players.has(socket.id)) return;
    pauseMatch(socket.id);
    io.emit('pauseState', { status: gameState.status, timerMs: gameState.timerMs });
  });

  socket.on('resumeGame', () => {
    if (!gameState.players.has(socket.id)) return;
    resumeMatch(socket.id);
    io.emit('pauseState', { status: gameState.status, timerMs: gameState.timerMs });
  });

  socket.on('quitGame', () => {
    if (!gameState.players.has(socket.id)) return;
    quitMatch(socket.id);
  });

  socket.on('restartGame', () => {
    restartMatch(socket.id);
  });

  socket.on('returnToLobby', () => {
    if (socket.id !== hostId) return;
    if (gameState.status !== 'ended') return;
    sendSystemMessage(`${getPlayerName(socket.id)} returned everyone to the lobby`);
    resetGameState();
    broadcastLobbyUpdate();
  });

  socket.on('disconnect', () => {
    const lobbyPlayer = lobbyPlayers.get(socket.id);
    if (lobbyPlayer) {
      lobbyPlayers.delete(socket.id);
      if (hostId === socket.id) {
        hostId = lobbyPlayers.keys().next().value || null;
        if (hostId) {
          sendSystemMessage(`${getPlayerName(hostId)} is now the host`);
        }
      }
      broadcastLobbyUpdate();
      sendSystemMessage(`${lobbyPlayer.name} left the lobby`);
    }

    if (gameState.players.has(socket.id)) {
      const player = gameState.players.get(socket.id);
      player.alive = false;
      sendSystemMessage(`${player.name} disconnected`);
    }
  });
});

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0));
});
