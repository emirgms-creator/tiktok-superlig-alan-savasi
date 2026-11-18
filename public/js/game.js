(() => {
  const canvas = document.getElementById('arena-canvas');
  const ctx = canvas.getContext('2d');
  const scoreboardEl = document.getElementById('scoreboard');
  const toastContainerEl = document.getElementById('toast-container');
  const tickerEl = document.getElementById('ticker');
  const teamWarningCodesEl = document.getElementById('team-warning-codes');

  const gridCanvas = document.createElement('canvas');
  const gridCtx = gridCanvas.getContext('2d');
  const CELL_PX = 10;
  const MAX_AVATAR_CACHE = 300;
  const MAX_PENDING_SPAWNS = 200;

  const victoryOverlay = document.getElementById('victory-overlay');
  const victoryLogo = document.getElementById('victory-logo');
  const victoryBadge = document.getElementById('victory-badge');
  const victoryTitle = document.getElementById('victory-title');
  const victoryTimerEl = document.getElementById('victory-timer');

  let config = null;
  let teamsById = {};
  let teamOrder = [];
  let cols = 48;
  let rows = 64;
  let grid = [];
  let teamCellCounts = {};
  let balls = [];
  let particles = [];
  let pendingSpawns = [];
  let wins = {};
  let roundOver = false;
  let victoryTimerId = null;
  let socket = null;
  const clientToken = new URLSearchParams(location.search).get('token') || '';
  let audioCtx = null;
  let lastCaptureSoundAt = 0;

  const teamLogos = new Map();
  const avatarCache = new Map();

  window.addEventListener('pointerdown', () => ensureAudio(), { once: true });

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playPopSound() {
    const now = performance.now();
    if (now - lastCaptureSoundAt < 75) return;
    lastCaptureSoundAt = now;

    const ac = ensureAudio();
    if (!ac) return;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(480 + Math.random() * 140, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(220, ac.currentTime + 0.06);
    gain.gain.setValueAtTime(0.03, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.06);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.065);
  }

  function playVictorySound() {
    const ac = ensureAudio();
    if (!ac) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const start = ac.currentTime + idx * 0.11;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.12, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(start);
      osc.stop(start + 0.36);
    });
  }

  function preloadTeamLogos() {
    for (const team of config.teams) {
      if (!team.logoPath) continue;
      const img = new Image();
      img.onload = () => {
        teamLogos.set(team.id, img);
        renderHudStructure();
      };
      img.onerror = () => {
        // Logo yüklenemezse stilize arma fallback'i kullanılır
      };
      img.src = team.logoPath;
    }
  }

  function getCachedAvatar(url) {
    if (!url) return null;
    if (avatarCache.has(url)) {
      const entry = avatarCache.get(url);
      return entry.loaded ? entry.img : null;
    }
    if (avatarCache.size >= MAX_AVATAR_CACHE) {
      const oldestKey = avatarCache.keys().next().value;
      avatarCache.delete(oldestKey);
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const entry = { img, loaded: false };
    avatarCache.set(url, entry);
    img.onload = () => {
      entry.loaded = true;
    };
    img.onerror = () => {
      avatarCache.delete(url);
    };
    img.src = url;
    return null;
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(200, canvas.clientWidth || 200);
    const h = Math.max(260, canvas.clientHeight || 260);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getCornerOrigin(corner) {
    const midX = Math.floor(cols / 2);
    const midY = Math.floor(rows / 2);
    switch (corner) {
      case 'topLeft':
        return { gx: Math.floor(midX * 0.45), gy: Math.floor(midY * 0.45) };
      case 'topRight':
        return { gx: Math.floor(midX + midX * 0.55), gy: Math.floor(midY * 0.45) };
      case 'bottomLeft':
        return { gx: Math.floor(midX * 0.45), gy: Math.floor(midY + midY * 0.55) };
      case 'bottomRight':
      default:
        return { gx: Math.floor(midX + midX * 0.55), gy: Math.floor(midY + midY * 0.55) };
    }
  }

  function resolveQuadrantTeams() {
    const byCorner = {};
    for (const team of config.teams) {
      if (team.corner) byCorner[team.corner] = team.id;
    }
    return {
      topLeft: byCorner.topLeft || teamOrder[0],
      topRight: byCorner.topRight || teamOrder[1] || teamOrder[0],
      bottomLeft: byCorner.bottomLeft || teamOrder[2] || teamOrder[0],
      bottomRight: byCorner.bottomRight || teamOrder[3] || teamOrder[0]
    };
  }

  function initGridAndRound() {
    if (victoryTimerId !== null) {
      clearInterval(victoryTimerId);
      victoryTimerId = null;
    }

    roundOver = false;
    victoryOverlay.classList.add('hidden');
    cols = config.arena.cols || 48;
    rows = config.arena.rows || 64;
    gridCanvas.width = cols * CELL_PX;
    gridCanvas.height = rows * CELL_PX;
    grid = new Array(rows);
    teamCellCounts = {};
    for (const id of teamOrder) {
      teamCellCounts[id] = 0;
    }

    const midX = Math.floor(cols / 2);
    const midY = Math.floor(rows / 2);
    const quadrants = resolveQuadrantTeams();

    for (let r = 0; r < rows; r++) {
      grid[r] = new Array(cols);
      for (let c = 0; c < cols; c++) {
        let teamId;
        if (r < midY && c < midX) teamId = quadrants.topLeft;
        else if (r < midY && c >= midX) teamId = quadrants.topRight;
        else if (r >= midY && c < midX) teamId = quadrants.bottomLeft;
        else teamId = quadrants.bottomRight;

        grid[r][c] = teamId;
        teamCellCounts[teamId]++;
        drawGridCell(r, c, teamId);
      }
    }

    balls = [];
    particles = [];

    const initialCount = config.arena.initialBallsPerTeam ?? 0;
    for (const team of config.teams) {
      for (let i = 0; i < initialCount; i++) {
        spawnBall(team.id, { permanent: true });
      }
    }

    // Tur bitişinde kuyruğa alınan hediye/sohbet toplarını yeni tura aktar
    if (pendingSpawns.length > 0) {
      const queued = pendingSpawns;
      pendingSpawns = [];
      for (const msg of queued) {
        applySpawnMessage(msg);
      }
    }

    updateHudValues();
  }

  function spawnBall(teamId, options = {}) {
    const team = teamsById[teamId];
    if (!team) return;

    const origin = getCornerOrigin(team.corner);
    const permanent = Boolean(options.permanent);
    const speed = 0.34 + Math.random() * 0.14;
    const angle = Math.random() * Math.PI * 2;

    const maxBalls = config.arena.maxBalls ?? 0;
    if (maxBalls > 0 && !permanent && balls.length >= maxBalls) {
      const idx = balls.findIndex((b) => !b.permanent);
      if (idx !== -1) balls.splice(idx, 1);
    }

    balls.push({
      teamId,
      x: origin.gx + (Math.random() - 0.5) * 6,
      y: origin.gy + (Math.random() - 0.5) * 6,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 0.85,
      permanent,
      avatarUrl: options.avatarUrl || '',
      nickname: options.nickname || ''
    });
  }

  function applySpawnMessage(msg) {
    const avatarUrl = msg.user?.avatarUrl || '';
    const nickname = msg.user?.nickname || '';
    const count = Math.max(1, Number(msg.count) || 1);
    for (let i = 0; i < count; i++) {
      spawnBall(msg.teamId, { permanent: false, avatarUrl, nickname, source: msg.source });
    }
    showTicker(msg);
  }

  function drawGridCell(r, c, teamId) {
    const team = teamsById[teamId];
    if (!team) return;
    const x = c * CELL_PX;
    const y = r * CELL_PX;
    gridCtx.fillStyle = team.primaryColor;
    gridCtx.fillRect(x, y, CELL_PX, CELL_PX);
    gridCtx.fillStyle = 'rgba(255,255,255,0.04)';
    gridCtx.fillRect(x, y, CELL_PX, 1);
    gridCtx.fillRect(x, y, 1, CELL_PX);
  }

  function paintCell(r, c, newTeamId) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
    const oldTeamId = grid[r][c];
    if (oldTeamId === newTeamId) return false;

    grid[r][c] = newTeamId;
    teamCellCounts[oldTeamId]--;
    teamCellCounts[newTeamId]++;
    drawGridCell(r, c, newTeamId);
    return true;
  }

  function spawnParticles(gx, gy, color, count = 4) {
    if (particles.length > 180) return;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.08 + Math.random() * 0.18;
      particles.push({
        x: gx,
        y: gy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: 1,
        color
      });
    }
  }

  function stepPhysics() {
    if (roundOver || !config) return;

    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      const nextX = b.x + b.vx;
      const nextY = b.y + b.vy;

      // Duvar sekmesi
      if (nextX - b.radius < 0) {
        b.x = b.radius;
        b.vx = Math.abs(b.vx);
      } else if (nextX + b.radius >= cols) {
        b.x = cols - b.radius - 0.01;
        b.vx = -Math.abs(b.vx);
      } else {
        b.x = nextX;
      }

      if (nextY - b.radius < 0) {
        b.y = b.radius;
        b.vy = Math.abs(b.vy);
      } else if (nextY + b.radius >= rows) {
        b.y = rows - b.radius - 0.01;
        b.vy = -Math.abs(b.vy);
      } else {
        b.y = nextY;
      }

      // Hücre çarpışması ve ele geçirme
      const centerC = Math.max(0, Math.min(cols - 1, Math.floor(b.x)));
      const centerR = Math.max(0, Math.min(rows - 1, Math.floor(b.y)));

      if (paintCell(centerR, centerC, b.teamId)) {
        const team = teamsById[b.teamId];
        spawnParticles(b.x, b.y, team.secondaryColor, 2);
        playPopSound();

        // Hafif açı sapmasıyla sektir
        const jitter = (Math.random() - 0.5) * 0.25;
        const speed = Math.hypot(b.vx, b.vy);
        const newAngle = Math.atan2(-b.vy, -b.vx) + jitter;
        b.vx = Math.cos(newAngle) * speed;
        b.vy = Math.sin(newAngle) * speed;
      }
    }

    // Rakip toplar çarpışınca birbirini yok etsin (O(N) uzamsal ızgara kontrolü)
    if (balls.length > 1) {
      const cellOccupant = new Int32Array(rows * cols).fill(-1);
      const dead = new Uint8Array(balls.length);
      let anyDead = false;

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        const c = Math.max(0, Math.min(cols - 1, Math.floor(b.x)));
        const r = Math.max(0, Math.min(rows - 1, Math.floor(b.y)));
        const idx = r * cols + c;
        const otherIdx = cellOccupant[idx];

        if (otherIdx === -1) {
          cellOccupant[idx] = i;
        } else if (!dead[otherIdx] && balls[otherIdx].teamId !== b.teamId) {
          dead[i] = 1;
          dead[otherIdx] = 1;
          cellOccupant[idx] = -1;
          anyDead = true;
          spawnParticles(b.x, b.y, '#ffffff', 2);
        }
      }

      if (anyDead) {
        balls = balls.filter((_, idx) => !dead[idx]);
      }
    }

    // Parçacıkları güncelle
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.05;
      if (p.life <= 0) particles.splice(i, 1);
    }

    // %100 Kazanma Kontrolü
    const totalCells = cols * rows;
    for (const id of teamOrder) {
      if (teamCellCounts[id] >= totalCells) {
        declareWinner(id);
        break;
      }
    }
  }

  function declareWinner(teamId) {
    if (victoryTimerId !== null) {
      clearInterval(victoryTimerId);
      victoryTimerId = null;
    }

    roundOver = true;
    wins[teamId] = (wins[teamId] || 0) + 1;
    updateHudValues();
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'ROUND_WIN', teamId, token: clientToken }));
    }
    playVictorySound();

    const team = teamsById[teamId];
    victoryTitle.textContent = `${team.name.toUpperCase()} KAZANDI!`;
    victoryTitle.style.color = team.secondaryColor;

    const logoImg = teamLogos.get(teamId);
    if (logoImg) {
      victoryLogo.src = logoImg.src;
      victoryLogo.classList.remove('hidden');
      victoryBadge.classList.add('hidden');
    } else {
      victoryLogo.classList.add('hidden');
      victoryBadge.classList.remove('hidden');
      victoryBadge.textContent = team.id;
      victoryBadge.style.background = team.primaryColor;
      victoryBadge.style.color = team.secondaryColor;
      victoryBadge.style.borderColor = team.secondaryColor;
    }

    victoryOverlay.classList.remove('hidden');

    let remaining = 5;
    victoryTimerEl.textContent = remaining;
    victoryTimerId = setInterval(() => {
      remaining--;
      victoryTimerEl.textContent = Math.max(0, remaining);
      if (remaining <= 0) {
        clearInterval(victoryTimerId);
        victoryTimerId = null;
        initGridAndRound();
      }
    }, 1000);
  }

  function drawContainedImage(context, img, cx, cy, maxSize) {
    const iw = img.naturalWidth || img.width || 1;
    const ih = img.naturalHeight || img.height || 1;
    const scale = Math.min(maxSize / iw, maxSize / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    context.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  }

  function renderArena() {
    if (!config) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    const cellW = w / cols;
    const cellH = h / rows;

    // 1. Önbelleğe alınmış Grid çizimi
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(gridCanvas, 0, 0, w, h);
    ctx.imageSmoothingEnabled = true;

    // 2. Köşe Takım Armaları
    for (const team of config.teams) {
      if (teamCellCounts[team.id] <= 0) continue;
      const origin = getCornerOrigin(team.corner);
      const cx = origin.gx * cellW;
      const cy = origin.gy * cellH;
      const badgeR = Math.min(w, h) * 0.085;

      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(cx, cy, badgeR * 1.15, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = team.secondaryColor;
      ctx.stroke();

      const logoImg = teamLogos.get(team.id);
      if (logoImg) {
        drawContainedImage(ctx, logoImg, cx, cy, badgeR * 1.65);
      } else {
        ctx.fillStyle = team.primaryColor;
        ctx.font = `900 ${Math.round(badgeR * 0.85)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(team.id, cx, cy);
      }
      ctx.restore();
    }

    // 3. Parçacıklar
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x * cellW, p.y * cellH, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 4. Toplar
    for (const b of balls) {
      const team = teamsById[b.teamId];
      const px = b.x * cellW;
      const py = b.y * cellH;
      const rPx = b.radius * Math.min(cellW, cellH);

      ctx.save();
      // Dış halka
      ctx.beginPath();
      ctx.arc(px, py, rPx, 0, Math.PI * 2);
      ctx.fillStyle = team.secondaryColor;
      ctx.fill();

      // İç dolgu / Avatar / Logo
      const innerR = Math.max(2, rPx * 0.78);
      const avatarImg = getCachedAvatar(b.avatarUrl);
      const logoImg = teamLogos.get(b.teamId);

      if (avatarImg) {
        ctx.beginPath();
        ctx.arc(px, py, innerR, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(avatarImg, px - innerR, py - innerR, innerR * 2, innerR * 2);
      } else if (logoImg) {
        ctx.beginPath();
        ctx.arc(px, py, innerR, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.clip();
        drawContainedImage(ctx, logoImg, px, py, innerR * 1.55);
      } else {
        ctx.beginPath();
        ctx.arc(px, py, innerR, 0, Math.PI * 2);
        ctx.fillStyle = team.primaryColor;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function renderHudStructure() {
    if (!config) return;
    scoreboardEl.innerHTML = '';

    if (teamWarningCodesEl) {
      teamWarningCodesEl.innerHTML = config.teams
        .map((t) => `<b>${escapeHtml(t.id)}</b>`)
        .join(' • ');
    }

    const defaultPct = (100 / Math.max(1, config.teams.length)).toFixed(1);

    for (const team of config.teams) {
      const card = document.createElement('div');
      card.className = 'team-card';
      card.id = `card-${team.id}`;
      card.style.setProperty('--team-accent', team.accentColor || team.secondaryColor);

      const logoImg = teamLogos.get(team.id);
      const logoHtml = logoImg
        ? `<div class="team-logo-wrap"><img class="team-logo-img" src="${logoImg.src}" alt="${escapeHtml(team.id)}" /></div>`
        : `<span class="team-logo-fallback" style="background:${team.primaryColor};color:${team.secondaryColor}">${escapeHtml(team.id)}</span>`;

      card.innerHTML = `
        <div class="team-card-top">
          ${logoHtml}
          <span class="team-id">${escapeHtml(team.id)}</span>
        </div>
        <div class="team-pct" id="pct-${team.id}">${defaultPct}%</div>
        <div class="team-wins" id="wins-${team.id}">🏆 ${wins[team.id] || 0} Şamp.</div>
      `;
      scoreboardEl.appendChild(card);
    }
  }

  function updateHudValues() {
    if (!config) return;
    const total = cols * rows;
    for (const id of teamOrder) {
      const pct = ((teamCellCounts[id] || 0) / total) * 100;
      const pctEl = document.getElementById(`pct-${id}`);
      const winsEl = document.getElementById(`wins-${id}`);
      const cardEl = document.getElementById(`card-${id}`);

      if (pctEl) pctEl.textContent = `${pct.toFixed(1)}%`;
      if (winsEl) winsEl.textContent = `🏆 ${wins[id] || 0} Şamp.`;
      if (cardEl) {
        if (teamCellCounts[id] === 0) cardEl.classList.add('eliminated');
        else cardEl.classList.remove('eliminated');
      }
    }
  }

  function showToast(htmlContent, accentColor) {
    if (!toastContainerEl) return;
    const item = document.createElement('div');
    item.className = 'toast-item';
    if (accentColor) item.style.setProperty('--toast-accent', accentColor);
    item.innerHTML = htmlContent;
    toastContainerEl.appendChild(item);

    while (toastContainerEl.children.length > 3) {
      toastContainerEl.removeChild(toastContainerEl.firstChild);
    }
    setTimeout(() => {
      item.remove();
    }, 2200);
  }

  function showTicker(msg) {
    const team = teamsById[msg.teamId];
    if (!team) return;

    const accent = team.accentColor || team.secondaryColor;
    const avatarHtml = msg.user?.avatarUrl
      ? `<img class="ticker-avatar" src="${escapeHtml(msg.user.avatarUrl)}" alt="" />`
      : `<span class="team-logo-fallback" style="background:${team.primaryColor};color:${accent}">${escapeHtml(team.id)}</span>`;

    const actionText =
      msg.source === 'gift'
        ? `<b>${escapeHtml(msg.giftName || 'Hediye')}</b> → <b style="color:${accent}">${escapeHtml(team.name)}</b> <b>+${msg.count} top</b>`
        : `→ <b style="color:${accent}">${escapeHtml(team.name)}</b> (+1 top)`;

    const contentHtml = `${avatarHtml}<span class="ticker-text"><b>${escapeHtml(msg.user?.nickname || 'İzleyici')}</b> ${actionText}</span>`;

    showToast(contentHtml, accent);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);
    socket = ws;

    ws.onclose = () => {
      if (socket === ws) socket = null;
      setTimeout(connectWebSocket, 2000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'INIT') {
        config = msg.config;
        teamsById = {};
        teamOrder = [];
        if (msg.wins && typeof msg.wins === 'object') {
          wins = { ...msg.wins };
        }
        for (const t of config.teams) {
          teamsById[t.id] = t;
          teamOrder.push(t.id);
          if (wins[t.id] === undefined) wins[t.id] = 0;
        }
        preloadTeamLogos();
        renderHudStructure();
        resizeCanvas();
        initGridAndRound();
      } else if (msg.type === 'WINS_UPDATE') {
        if (msg.wins && typeof msg.wins === 'object') {
          wins = { ...wins, ...msg.wins };
          updateHudValues();
        }
      } else if (msg.type === 'SPAWN_BALL') {
        if (roundOver) {
          if (pendingSpawns.length < MAX_PENDING_SPAWNS) {
            pendingSpawns.push(msg);
          }
          return;
        }
        applySpawnMessage(msg);
      } else if (msg.type === 'NOTICE') {
        const avatarHtml = msg.avatarUrl
          ? `<img class="ticker-avatar" src="${escapeHtml(msg.avatarUrl)}" alt="" />`
          : '';
        showToast(`${avatarHtml}<span class="ticker-text" style="color:#fbbf24">${escapeHtml(msg.message)}</span>`, '#fbbf24');
      } else if (msg.type === 'RESET_GAME') {
        pendingSpawns = [];
        initGridAndRound();
      }
    };
  }

  let frameCounter = 0;
  function physicsTick() {
    stepPhysics();
    frameCounter++;
    if (frameCounter % 6 === 0) {
      updateHudValues();
    }
  }

  function startPhysicsLoop() {
    try {
      const workerCode = 'setInterval(() => postMessage(0), 1000 / 60);';
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);
      let urlRevoked = false;
      worker.onmessage = () => {
        if (!urlRevoked) {
          urlRevoked = true;
          URL.revokeObjectURL(workerUrl);
        }
        physicsTick();
      };
      return;
    } catch (_e) {
      // Web Worker desteklenmezse setInterval ile devam et
    }
    setInterval(physicsTick, 1000 / 60);
  }

  function renderLoop() {
    renderArena();
    requestAnimationFrame(renderLoop);
  }

  window.addEventListener('resize', resizeCanvas);
  connectWebSocket();
  startPhysicsLoop();
  requestAnimationFrame(renderLoop);
})();
