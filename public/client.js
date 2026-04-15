const socket = io({ reconnection: true, reconnectionAttempts: 5 });

const joinScreen = document.getElementById('join-screen');
const joinForm = document.getElementById('join-form');
const joinError = document.getElementById('join-error');
const nameInput = document.getElementById('player-name');
const lobbyScreen = document.getElementById('lobby-screen');
const lobbyList = document.getElementById('lobby-list');
const lobbyStatus = document.getElementById('lobby-status');
const joinLobbyList = document.getElementById('join-lobby-list');
const joinLobbyStatus = document.getElementById('join-lobby-status');
const startButton = document.getElementById('start-button');
const gameScreen = document.getElementById('game-screen');
const connectionIndicator = document.getElementById('connection-indicator');
const timerDisplay = document.getElementById('timer-display');
const scoreboard = document.getElementById('scoreboard');
const messageFeed = document.getElementById('message-feed');
const fpsIndicator = document.getElementById('fps-indicator');
const arena = document.getElementById('arena');
const menuButton = document.getElementById('menu-button');
const menuOverlay = document.getElementById('menu-overlay');
const pauseBtn = document.getElementById('pause-btn');
const resumeBtn = document.getElementById('resume-btn');
const quitBtn = document.getElementById('quit-btn');
const menuStatus = document.getElementById('menu-status');
const returnBtn = document.getElementById('return-btn');
const restartBtn = document.getElementById('restart-btn');

const state = {
  playerId: null,
  hostId: null,
  lobbyPlayers: [],
  gameStatus: 'waiting',
  arena: { width: 1280, height: 720 },
  scaleX: 1,
  scaleY: 1,
  runtimePlayers: new Map(),
  latestSnapshot: new Map(),
  timerMs: 0,
  lastDirectionSent: null,
  menuOpen: false,
  audioContext: null,
  lastSoundAt: 0,
  powerUps: new Map(),
  powerUpLayer: null,
  fps: {
    lastFrameTime: performance.now(),
    frameCount: 0,
    lastReport: performance.now(),
  },
};

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const HALF_TRAIL = 5;
const PLAYER_HEAD_SIZE = 12;
const HALF_HEAD = PLAYER_HEAD_SIZE / 2;

function initArena() {
  arena.classList.add('grid-lines');
  updateArenaScale();
}

function updateArenaScale() {
  const rect = arena.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }
  state.scaleX = rect.width / state.arena.width;
  state.scaleY = rect.height / state.arena.height;

  state.latestSnapshot.forEach((player, id) => {
    const runtime = state.runtimePlayers.get(id);
    if (!runtime) return;
    // Snap current position to avoid drift when resizing
    runtime.current.x = player.position.x;
    runtime.current.y = player.position.y;
    runtime.target = { x: player.position.x, y: player.position.y };
    updateTrail(runtime, player.segments);
    positionHeadAndLabel(runtime);
  });

  state.powerUps.forEach((entry) => {
    positionPowerUp(entry);
  });
}

window.addEventListener('resize', updateArenaScale);
initArena();

function setConnectionStatus(online) {
  connectionIndicator.textContent = online ? 'Online' : 'Offline';
  connectionIndicator.classList.toggle('online', online);
  connectionIndicator.classList.toggle('offline', !online);
}

socket.on('connect', () => {
  setConnectionStatus(true);
});

socket.on('disconnect', () => {
  setConnectionStatus(false);
});

socket.on('lobbySnapshot', ({ players, hostId, status }) => {
  state.lobbyPlayers = players || [];
  state.hostId = hostId || null;
  state.gameStatus = status || 'waiting';
  renderLobby();
  updateMenuState();
});

socket.on('lobbyUpdate', ({ players, hostId, status }) => {
  state.lobbyPlayers = players;
  state.hostId = hostId;
  state.gameStatus = status;
  renderLobby();
  updateMenuState();
});

socket.on('systemMessage', ({ message }) => {
  addMessage(message);
});

socket.on('errorMessage', ({ message }) => {
  addMessage(message, true);
});

socket.on('matchStarted', ({ arena: arenaConfig, players, powerUps }) => {
  state.gameStatus = 'running';
  state.arena = arenaConfig;
  state.timerMs = 0;
  updateArenaScale();
  prepareMatch(players);
  addMessage('The match has begun!');
  playTone(420, 0.15);
  syncPowerUps(powerUps || []);
});

socket.on('stateUpdate', ({ timerMs, players, status, powerUps }) => {
  state.timerMs = timerMs;
  if (status) state.gameStatus = status;
  updateTimerDisplay(timerMs);
  applySnapshot(players);
  updateScoreboard(players);
  if (powerUps) {
    syncPowerUps(powerUps);
  }
});

socket.on('pauseState', ({ status, timerMs }) => {
  state.gameStatus = status;
  if (typeof timerMs === 'number') {
    state.timerMs = timerMs;
    updateTimerDisplay(timerMs);
  }
  updateMenuState();
});

socket.on('matchEnded', ({ reason, players, timerMs, winner }) => {
  state.gameStatus = 'ended';
  state.timerMs = timerMs;
  updateTimerDisplay(timerMs);
  updateScoreboard(players);
  applySnapshot(players);
  syncPowerUps([]);
  if (winner) {
    addMessage(`${winner.name} wins the match!`);
    playTone(660, 0.2);
  } else {
    addMessage('Round ended. No clear winner.');
  }
  if (state.playerId === state.hostId) {
    addMessage('Host: choose Restart or Return to Lobby from the menu.');
    if (!state.menuOpen) {
      toggleMenu(true);
    } else {
      updateMenuState();
    }
  } else {
    updateMenuState();
    if (state.menuOpen) {
      toggleMenu(false);
    }
  }
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) {
    joinError.textContent = 'Enter a player name.';
    return;
  }

  socket.emit('joinLobby', { name }, (response) => {
    if (!response?.ok) {
      joinError.textContent = response?.error ?? 'Unable to join lobby';
      return;
    }
    joinError.textContent = '';
    state.playerId = response.player.id;
    state.hostId = response.hostId;
    joinScreen.classList.add('hidden');
    lobbyScreen.classList.remove('hidden');
    addMessage(`You joined as ${response.player.name}`);
    playTone(560, 0.1);
  });
});

startButton.addEventListener('click', () => {
  socket.emit('startGame');
});

menuButton.addEventListener('click', () => {
  if (!state.menuOpen) {
    toggleMenu(true);
    if (state.gameStatus === 'running') {
      socket.emit('pauseGame');
      playTone(300, 0.15);
    }
  }
});

pauseBtn.addEventListener('click', () => {
  if (state.gameStatus === 'running') {
    socket.emit('pauseGame');
    playTone(300, 0.15);
  }
});

resumeBtn.addEventListener('click', () => {
  if (state.gameStatus === 'paused') {
    socket.emit('resumeGame');
    playTone(520, 0.12);
  }
  toggleMenu(false);
});

quitBtn.addEventListener('click', () => {
  socket.emit('quitGame');
  toggleMenu(false);
});

returnBtn.addEventListener('click', () => {
  if (state.gameStatus === 'ended' && state.playerId === state.hostId) {
    socket.emit('returnToLobby');
    toggleMenu(false);
    playTone(260, 0.12);
  }
});

restartBtn.addEventListener('click', () => {
  const isHost = state.playerId && state.playerId === state.hostId;
  if (!isHost) return;
  socket.emit('restartGame');
  toggleMenu(false);
  playTone(640, 0.1);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!state.menuOpen) {
      toggleMenu(true);
      if (state.gameStatus === 'running') {
        socket.emit('pauseGame');
        playTone(300, 0.15);
      }
    } else {
      toggleMenu(false);
      if (state.gameStatus === 'paused') {
        socket.emit('resumeGame');
        playTone(520, 0.12);
      }
    }
    return;
  }

  if (event.repeat) {
    return;
  }

  if (state.menuOpen) {
    return;
  }

  if (state.gameStatus !== 'running') {
    return;
  }

  const direction = mapKeyToDirection(event.key);
  if (!direction) {
    return;
  }

  event.preventDefault();
  if (direction === state.lastDirectionSent) {
    return;
  }

  socket.emit('changeDirection', direction);
  state.lastDirectionSent = direction;
});

window.addEventListener('keyup', (event) => {
  const direction = mapKeyToDirection(event.key);
  if (direction && direction === state.lastDirectionSent) {
    state.lastDirectionSent = null;
  }
});

function renderLobby() {
  populateLobbyList(lobbyList);
  populateLobbyList(joinLobbyList);

  const playerCount = state.lobbyPlayers.length;
  const statusText = `${playerCount} / ${MAX_PLAYERS} players in lobby`;
  if (lobbyStatus) {
    lobbyStatus.textContent = statusText;
  }
  if (joinLobbyStatus) {
    joinLobbyStatus.textContent = statusText;
  }
  const isHost = state.playerId && state.playerId === state.hostId;
  startButton.classList.toggle('hidden', !isHost);
  startButton.disabled = !(isHost && playerCount >= MIN_PLAYERS && state.gameStatus === 'waiting');

  if (state.gameStatus === 'waiting' && state.playerId) {
    gameScreen.classList.add('hidden');
    lobbyScreen.classList.remove('hidden');
  }
}

function populateLobbyList(targetList) {
  if (!targetList) return;
  targetList.innerHTML = '';

  if (!state.lobbyPlayers.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Waiting for players...';
    targetList.appendChild(empty);
    return;
  }

  state.lobbyPlayers.forEach((player) => {
    const li = document.createElement('li');
    const nameRow = document.createElement('div');
    nameRow.className = 'player-name';

    const chip = document.createElement('span');
    chip.className = 'color-chip';
    chip.style.color = player.color;

    const name = document.createElement('span');
    name.textContent = player.name;

    nameRow.append(chip, name);

    const badge = document.createElement('span');
    badge.className = 'badge';
    if (player.id === state.hostId) {
      badge.textContent = 'Host';
      badge.style.backgroundColor = 'rgba(18, 225, 255, 0.18)';
    } else {
      badge.textContent = 'Ready';
      badge.style.backgroundColor = 'rgba(62, 255, 162, 0.15)';
    }

    li.append(nameRow, badge);
    targetList.appendChild(li);
  });
}

function prepareMatch(players) {
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  scoreboard.innerHTML = '';
  messageFeed.innerHTML = '';
  state.runtimePlayers.clear();
  state.latestSnapshot.clear();
  state.powerUps.clear();
  state.powerUpLayer = null;

  while (arena.firstChild) {
    arena.removeChild(arena.firstChild);
  }

  const powerLayer = document.createElement('div');
  powerLayer.className = 'powerup-layer';
  arena.appendChild(powerLayer);
  state.powerUpLayer = powerLayer;

  players.forEach((player) => {
    const trailContainer = document.createElement('div');
    trailContainer.className = 'trail-container';
    trailContainer.style.position = 'absolute';
    trailContainer.style.inset = '0';
    trailContainer.style.color = player.color;
    trailContainer.style.mixBlendMode = 'normal';
    trailContainer.style.opacity = '0.9';
    trailContainer.style.zIndex = '1';

    const head = document.createElement('div');
    head.className = 'player-head';
    head.style.color = player.color;
    head.style.mixBlendMode = 'normal';
    head.style.zIndex = '2';

    const label = document.createElement('div');
    label.className = 'player-label';
    label.style.color = player.color;
    label.textContent = player.name;
    label.style.zIndex = '3';

    arena.append(trailContainer, head, label);

    state.runtimePlayers.set(player.id, {
      head,
      label,
      trailContainer,
      trailSegments: [],
      target: { x: player.position.x, y: player.position.y },
      current: { x: player.position.x, y: player.position.y },
      alive: true,
      color: player.color,
      name: player.name,
    });
  });

  updateScoreboard(players);
  applySnapshot(players);
  updateMenuState();

  requestAnimationFrame(() => {
    updateArenaScale();
    refreshRuntimeTransforms();
  });
}

function applySnapshot(players) {
  state.latestSnapshot.clear();
  players.forEach((player) => {
    state.latestSnapshot.set(player.id, player);
    const runtime = state.runtimePlayers.get(player.id);
    if (!runtime) return;
    const wasAlive = runtime.alive;
    runtime.target = { x: player.position.x, y: player.position.y };
    runtime.alive = player.alive;
    if (runtime.label) {
      runtime.label.textContent = player.name;
    }
    updateTrail(runtime, player.segments);
    positionHeadAndLabel(runtime);
    if (wasAlive && !player.alive) {
      playTone(240, 0.18);
    }
  });

  Array.from(state.runtimePlayers.keys()).forEach((id) => {
    if (!state.latestSnapshot.has(id)) {
      const runtime = state.runtimePlayers.get(id);
      runtime?.head.remove();
      runtime?.label.remove();
      runtime?.trailContainer.remove();
      state.runtimePlayers.delete(id);
    }
  });
}

function updateTrail(runtime, segments) {
  if (!segments) return;
  const { trailContainer } = runtime;
  const existing = runtime.trailSegments;

  for (let i = existing.length; i < segments.length; i += 1) {
    const segmentEl = document.createElement('div');
    segmentEl.className = 'trail-segment';
    segmentEl.style.color = trailContainer.style.color;
    trailContainer.appendChild(segmentEl);
    existing.push(segmentEl);
  }

  while (existing.length > segments.length) {
    const el = existing.pop();
    el?.remove();
  }

  segments.forEach((segment, index) => {
    const segmentEl = existing[index];
    if (!segmentEl) return;
    const { x1, y1, x2, y2 } = segment;
    const left = Math.min(x1, x2) * state.scaleX;
    const top = Math.min(y1, y2) * state.scaleY;
    const width = Math.max(Math.abs(x2 - x1) * state.scaleX, state.scaleX);
    const height = Math.max(Math.abs(y2 - y1) * state.scaleY, state.scaleY);

    segmentEl.style.left = `${left - HALF_TRAIL * state.scaleX}px`;
    segmentEl.style.top = `${top - HALF_TRAIL * state.scaleY}px`;
    segmentEl.style.width = `${width + HALF_TRAIL * 2 * state.scaleX}px`;
    segmentEl.style.height = `${height + HALF_TRAIL * 2 * state.scaleY}px`;
  });
}

function positionHeadAndLabel(runtime) {
  const x = runtime.current.x * state.scaleX;
  const y = runtime.current.y * state.scaleY;
  runtime.head.style.transform = `translate3d(${x - HALF_HEAD}px, ${y - HALF_HEAD}px, 0)`;
  runtime.head.style.opacity = runtime.alive ? '1' : '0.3';

  if (runtime.label) {
    const labelWidth = runtime.label.offsetWidth || runtime.label.textContent.length * 8;
    const labelHeight = runtime.label.offsetHeight || 16;
    const labelX = x - labelWidth / 2;
    const labelY = y - HALF_HEAD - (labelHeight + 6);
    runtime.label.style.transform = `translate3d(${labelX}px, ${labelY}px, 0)`;
    runtime.label.style.opacity = runtime.alive ? '0.95' : '0.4';
  }
}

function refreshRuntimeTransforms() {
  state.runtimePlayers.forEach((runtime, id) => {
    const snapshot = state.latestSnapshot.get(id);
    if (snapshot) {
      runtime.current = { x: snapshot.position.x, y: snapshot.position.y };
      runtime.target = { x: snapshot.position.x, y: snapshot.position.y };
      runtime.alive = snapshot.alive;
      updateTrail(runtime, snapshot.segments);
    }
    positionHeadAndLabel(runtime);
  });
}

function syncPowerUps(powerUps) {
  if (!state.powerUpLayer) return;
  const seen = new Set();

  powerUps.forEach((powerUp) => {
    seen.add(powerUp.id);
    let entry = state.powerUps.get(powerUp.id);
    if (!entry) {
      const el = document.createElement('div');
      el.className = `power-up power-up--${powerUp.type}`;
      el.innerHTML = '<span></span>';
      state.powerUpLayer.appendChild(el);
      entry = { el, data: powerUp };
      state.powerUps.set(powerUp.id, entry);
      playTone(powerUp.type === 'speed' ? 720 : 340, 0.08);
    }
    entry.data = powerUp;
    entry.el.className = `power-up power-up--${powerUp.type}`;
    positionPowerUp(entry);
  });

  state.powerUps.forEach((entry, id) => {
    if (!seen.has(id)) {
      entry.el.remove();
      state.powerUps.delete(id);
    }
  });
}

function positionPowerUp(entry) {
  if (!entry?.data) return;
  const { x, y } = entry.data;
  const size = 32;
  const left = x * state.scaleX - size / 2;
  const top = y * state.scaleY - size / 2;
  entry.el.style.left = `${left}px`;
  entry.el.style.top = `${top}px`;
}

function updateScoreboard(players) {
  scoreboard.innerHTML = '';
  const sorted = [...players].sort((a, b) => b.score - a.score);
  sorted.forEach((player) => {
    const card = document.createElement('div');
    card.className = 'score-card';

    const nameRow = document.createElement('div');
    nameRow.className = 'name-row';
    const chip = document.createElement('span');
    chip.className = 'color-chip';
    chip.style.color = player.color;

    const name = document.createElement('span');
    name.textContent = player.name;

    nameRow.append(chip, name);

    const stats = document.createElement('div');
    stats.className = 'stats';
    const status = player.alive ? 'Alive' : 'Out';
    const bonus = player.bonusScore ? ` (+${player.bonusScore})` : '';
    stats.textContent = `Score: ${player.score}${bonus} · ${status}`;

    card.append(nameRow, stats);
    scoreboard.appendChild(card);
  });
}

function updateTimerDisplay(timerMs) {
  const totalSeconds = Math.floor(timerMs / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  timerDisplay.textContent = `${minutes}:${seconds}`;
}

function addMessage(message, isError = false) {
  const item = document.createElement('div');
  item.className = 'message';
  if (isError) {
    item.style.color = 'var(--danger)';
  }
  item.textContent = message;
  messageFeed.prepend(item);
  while (messageFeed.children.length > 8) {
    messageFeed.removeChild(messageFeed.lastChild);
  }
}

function toggleMenu(open) {
  state.menuOpen = open;
  menuOverlay.classList.toggle('hidden', !open);
  updateMenuState();
}

function updateMenuState() {
  menuStatus.textContent = `Match is ${state.gameStatus}`;
  resumeBtn.disabled = state.gameStatus !== 'paused';
  pauseBtn.disabled = state.gameStatus !== 'running';
  const isHost = state.playerId && state.playerId === state.hostId;
  const showReturn = state.gameStatus === 'ended' && isHost;
  returnBtn.classList.toggle('hidden', !showReturn);
  returnBtn.disabled = !showReturn;
  const restartAvailable = isHost && (state.gameStatus === 'running' || state.gameStatus === 'paused' || state.gameStatus === 'ended');
  restartBtn.classList.toggle('hidden', !restartAvailable);
  restartBtn.disabled = !restartAvailable;
}

function mapKeyToDirection(key) {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'up';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'down';
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'left';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'right';
    default:
      return null;
  }
}

function animationLoop() {
  const now = performance.now();
  state.runtimePlayers.forEach((runtime) => {
    const { target, current } = runtime;
    current.x += (target.x - current.x) * 0.45;
    current.y += (target.y - current.y) * 0.45;

    positionHeadAndLabel(runtime);
  });

  updateFps(now);

  requestAnimationFrame(animationLoop);
}

requestAnimationFrame(animationLoop);

function playTone(frequency = 440, duration = 0.12) {
  const now = performance.now();
  if (now - state.lastSoundAt < 80) {
    return;
  }

  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  const ctx = state.audioContext;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sawtooth';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

  oscillator.connect(gain);
  gain.connect(ctx.destination);

  oscillator.start();
  oscillator.stop(ctx.currentTime + duration);
  state.lastSoundAt = now;
}

function updateFps(now) {
  if (!fpsIndicator) return;
  const fpsState = state.fps;
  fpsState.frameCount += 1;
  const elapsed = now - fpsState.lastReport;
  if (elapsed >= 250) {
    const fps = Math.round((fpsState.frameCount / elapsed) * 1000);
    fpsIndicator.textContent = `FPS: ${fps}`;
    fpsState.frameCount = 0;
    fpsState.lastReport = now;
  }
}
