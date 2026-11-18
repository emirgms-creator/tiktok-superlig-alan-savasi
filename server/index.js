const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const {
  calculateBallsForGift,
  resolveTeamFromChat
} = require('./giftCalculator');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const WINS_PATH = path.join(__dirname, 'wins.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const validTeamIds = new Set((config.teams || []).map((t) => t.id));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function loadWins() {
  const initial = {};
  for (const id of validTeamIds) {
    initial[id] = 0;
  }
  try {
    if (fs.existsSync(WINS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(WINS_PATH, 'utf8'));
      for (const id of validTeamIds) {
        const val = Number(saved?.[id]);
        if (Number.isFinite(val) && val >= 0) {
          initial[id] = Math.floor(val);
        }
      }
    }
  } catch (_e) {
    // Bozuk/okunamayan dosya olursa varsayılan 0 ile devam et
  }
  return initial;
}

function saveWins() {
  try {
    fs.writeFileSync(WINS_PATH, JSON.stringify(wins, null, 2), 'utf8');
  } catch (_e) {
    // ignore write errors
  }
}

const wins = loadWins();
let lastWinRecordedAt = 0;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireAdminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.headers['x-admin-token'] || req.query.token || req.body?.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Yetkisiz erişim' });
  }
  return next();
}

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/api/config', (_req, res) => {
  res.json(config);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let tiktokConnection = null;
let connectInFlight = null;
let connectionState = {
  connected: false,
  connecting: false,
  username: '',
  roomId: null,
  error: null
};

// İzleyicinin seçtiği takımı yayın bitene kadar, aktif hediye serilerini (2 dakika) RAM'de tutar
const STREAK_TTL_MS = 2 * 60 * 1000;
const userTeams = new Map();
const activeStreaks = new Map();

setInterval(() => {
  const streakCutoff = Date.now() - STREAK_TTL_MS;
  for (const [key, entry] of activeStreaks.entries()) {
    if (entry.updatedAt < streakCutoff) {
      activeStreaks.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

function emitLog(level, message) {
  broadcast({
    type: 'LOG',
    level,
    message,
    timestamp: new Date().toLocaleTimeString('tr-TR')
  });
}

function updateTikTokStatus(patch) {
  connectionState = { ...connectionState, ...patch };
  broadcast({ type: 'TIKTOK_STATUS', status: connectionState });
}

function spawnForTeam({ teamId, count = 1, user = null, source = 'sim', giftName = null, diamonds = 0 }) {
  if (!validTeamIds.has(teamId) || count <= 0) return;
  broadcast({
    type: 'SPAWN_BALL',
    teamId,
    count,
    user: user || { nickname: 'Yayın', avatarUrl: '' },
    source,
    giftName,
    diamonds
  });
}

function extractTikTokUser(data = {}) {
  const u = data.user || {};
  const uniqueId =
    data.uniqueId ||
    u.displayId ||
    u.uniqueId ||
    (u.idStr ? String(u.idStr) : '') ||
    (u.userId ? String(u.userId) : '') ||
    (data.userId ? String(data.userId) : '');
  const nickname = data.nickname || u.nickname || uniqueId || 'İzleyici';
  const avatarUrl =
    data.profilePictureUrl ||
    u.avatarThumb?.url?.[0] ||
    u.avatarThumb?.urlList?.[0] ||
    u.avatarLarge?.url?.[0] ||
    u.avatarLarge?.urlList?.[0] ||
    '';
  return { uniqueId, nickname, avatarUrl };
}

function extractTikTokGift(data = {}) {
  // v2.x (tiktok-live-proto v3): hediye bilgisi `data.gift` (id, name, diamondCount, type) içinde
  const gift = data.gift || {};
  const details = data.giftDetails || {};
  const ext = data.extendedGiftInfo || {};
  const giftId = data.giftId || gift.id || details.giftId || ext.id || 'unknown';
  const giftName = data.giftName || gift.name || details.giftName || ext.name || 'Hediye';
  const diamondCount =
    Number(data.diamondCount || gift.diamondCount || details.diamondCount || ext.diamond_count || 0) || 0;
  const giftType = Number(data.giftType || gift.type || details.giftType || ext.type || 0) || 0;
  const repeatCount = Number(data.repeatCount ?? 1) || 1;
  const repeatEnd = Boolean(data.repeatEnd);
  return { giftId, giftName, diamondCount, giftType, repeatCount, repeatEnd };
}

function computeGiftDelta(streakMap, streakKey, giftType, repeatCount, repeatEnd, now = Date.now()) {
  const currentRepeat = Math.max(0, Number(repeatCount) || 0);
  if (currentRepeat <= 0) return 0;

  if (giftType !== 1) {
    return currentRepeat;
  }

  const prevEntry = streakMap.get(streakKey);
  const prevRepeat = prevEntry ? prevEntry.repeatCount : 0;
  // Eğer önceki serinin bitiş paketi kaçtıysa ve yeni seri 1'den başladıysa yeni seri kabul et
  const deltaRepeat = currentRepeat < prevRepeat ? currentRepeat : currentRepeat - prevRepeat;

  if (repeatEnd) {
    streakMap.delete(streakKey);
  } else {
    streakMap.set(streakKey, { repeatCount: currentRepeat, updatedAt: now });
  }

  return deltaRepeat;
}

async function connectToTikTok(username) {
  const cleanUsername = String(username || '').replace(/^@/, '').trim();
  if (!cleanUsername) {
    throw new Error('Geçerli bir TikTok kullanıcı adı girin.');
  }

  if (connectInFlight) {
    throw new Error('Halihazırda bir bağlantı denemesi devam ediyor.');
  }

  connectInFlight = (async () => {
    await disconnectFromTikTok();

    updateTikTokStatus({
      connected: false,
      connecting: true,
      username: cleanUsername,
      roomId: null,
      error: null
    });

    const conn = new TikTokLiveConnection(cleanUsername, {
      processInitialData: false,
      enableExtendedGiftInfo: false
    });
    tiktokConnection = conn;

    conn.on('chat', (data) => {
      // v2.x (tiktok-live-proto v3): metin `content` alanında; eski sürümlerde `comment`
      const comment = String(data.content ?? data.comment ?? '');
      const teamId = resolveTeamFromChat(comment, config.chatKeywords);
      if (!teamId) return;

      const { uniqueId, nickname, avatarUrl } = extractTikTokUser(data);
      const userKey = uniqueId || nickname;
      const prev = userTeams.get(userKey);
      userTeams.set(userKey, { teamId, updatedAt: Date.now() });
      const user = { nickname, avatarUrl };

      spawnForTeam({
        teamId,
        count: 1,
        user,
        source: 'chat'
      });
      const switchedText = prev && prev.teamId !== teamId ? ` (${prev.teamId} -> ${teamId} geçiş)` : '';
      emitLog('chat', `${user.nickname} sohbete "${comment}" yazdı -> ${teamId} (+1 top)${switchedText}`);
    });

    conn.on('gift', (data) => {
      const { uniqueId, nickname, avatarUrl } = extractTikTokUser(data);
      const { giftId, giftName, diamondCount, giftType, repeatCount, repeatEnd } = extractTikTokGift(data);
      const userKey = uniqueId || nickname;
      const streakKey = `${userKey}_${giftId}`;
      const deltaRepeat = computeGiftDelta(
        activeStreaks,
        streakKey,
        giftType,
        repeatCount,
        repeatEnd
      );
      if (deltaRepeat <= 0) return;

      const userEntry = userTeams.get(userKey);
      const teamId = userEntry ? userEntry.teamId : null;

      if (!teamId) {
        broadcast({
          type: 'NOTICE',
          message: `⚠️ ${nickname} (${giftName}) attı ama takım seçmedi! Önce sohbete BJK/FB/GS/TS yaz!`,
          avatarUrl
        });
        emitLog('warn', `${nickname} (${giftName}) attı fakat henüz takım seçmedi.`);
        return;
      }

      userEntry.updatedAt = Date.now();
      const { count, totalDiamonds } = calculateBallsForGift(diamondCount, deltaRepeat);
      if (count <= 0) {
        emitLog('warn', `${nickname} (${giftName}) 0 jetonlu/geçersiz hediye gönderdi, yoksayıldı.`);
        return;
      }

      const user = { nickname, avatarUrl };

      spawnForTeam({
        teamId,
        count,
        user,
        source: 'gift',
        giftName,
        diamonds: totalDiamonds
      });

      emitLog(
        'gift',
        `${user.nickname} -> ${giftName} (${totalDiamonds} jeton) -> ${teamId} (+${count} top)`
      );
    });

    conn.on('streamEnd', () => {
      if (tiktokConnection !== conn) return;
      userTeams.clear();
      activeStreaks.clear();
      updateTikTokStatus({ connected: false, connecting: false, roomId: null });
      emitLog('warn', 'TikTok canlı yayını sona erdi. İzleyici verileri temizlendi.');
    });

    conn.on('disconnected', () => {
      if (tiktokConnection !== conn) return;
      userTeams.clear();
      activeStreaks.clear();
      updateTikTokStatus({ connected: false, connecting: false, roomId: null });
      emitLog('warn', 'TikTok canlı yayın bağlantısı kesildi. İzleyici verileri temizlendi.');
    });

    conn.on('error', (err) => {
      if (tiktokConnection !== conn) return;
      emitLog('error', `TikTok hata: ${err.message || err}`);
    });

    try {
      const state = await conn.connect();
      updateTikTokStatus({
        connected: true,
        connecting: false,
        roomId: state.roomId || null,
        error: null
      });
      emitLog('success', `@${cleanUsername} canlı yayınına bağlanıldı (Room: ${state.roomId}).`);
    } catch (err) {
      if (tiktokConnection === conn) {
        tiktokConnection = null;
      }
      updateTikTokStatus({
        connected: false,
        connecting: false,
        error: err.message || 'Bağlantı başarısız'
      });
      emitLog('error', `Bağlanılamadı: ${err.message || err}`);
      throw err;
    }
  })();

  try {
    return await connectInFlight;
  } finally {
    connectInFlight = null;
  }
}

async function disconnectFromTikTok() {
  if (tiktokConnection) {
    const conn = tiktokConnection;
    tiktokConnection = null;
    try {
      conn.disconnect();
    } catch (_e) {
      // ignore
    }
  }
  userTeams.clear();
  activeStreaks.clear();
  updateTikTokStatus({ connected: false, connecting: false, roomId: null });
}

app.get('/api/status', (_req, res) => {
  res.json(connectionState);
});

app.post('/api/connect', requireAdminAuth, async (req, res) => {
  try {
    await connectToTikTok(req.body?.username);
    res.json({ ok: true, status: connectionState });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Bağlantı hatası' });
  }
});

app.post('/api/disconnect', requireAdminAuth, async (_req, res) => {
  await disconnectFromTikTok();
  res.json({ ok: true, status: connectionState });
});

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'INIT',
      config,
      status: connectionState,
      wins
    })
  );

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (ADMIN_TOKEN && msg.token !== ADMIN_TOKEN) {
        return;
      }

      if (msg.type === 'ROUND_WIN') {
        if (!validTeamIds.has(msg.teamId)) return;
        const now = Date.now();
        if (now - lastWinRecordedAt < 3000) return;
        lastWinRecordedAt = now;
        wins[msg.teamId] = (wins[msg.teamId] || 0) + 1;
        saveWins();
        broadcast({ type: 'WINS_UPDATE', wins });
        emitLog('success', `🏆 ${msg.teamId} şampiyon oldu! (Toplam: ${wins[msg.teamId]})`);
        return;
      }

      if (msg.type === 'SIMULATE_SPAWN') {
        if (!validTeamIds.has(msg.teamId)) return;
        const diamonds = Number(msg.diamonds) || 0;
        if (diamonds > 0) {
          const { count } = calculateBallsForGift(diamonds, 1);
          spawnForTeam({
            teamId: msg.teamId,
            count,
            user: { nickname: msg.nickname || 'Test Taraftarı', avatarUrl: '' },
            source: 'gift',
            giftName: `${diamonds} Jetonluk Hediye`,
            diamonds
          });
          emitLog('gift', `[TEST] ${msg.teamId} için ${diamonds} jeton simüle edildi (+${count} top)`);
        } else {
          spawnForTeam({
            teamId: msg.teamId,
            count: Math.max(1, Number(msg.count) || 1),
            user: { nickname: msg.nickname || 'Test Taraftarı', avatarUrl: '' },
            source: 'chat'
          });
          emitLog('chat', `[TEST] ${msg.teamId} sohbet kodu simüle edildi (+1 top)`);
        }
      } else if (msg.type === 'SIMULATE_CHAT') {
        const comment = String(msg.comment || '');
        const teamId = resolveTeamFromChat(comment, config.chatKeywords);
        if (teamId) {
          spawnForTeam({
            teamId,
            count: 1,
            user: { nickname: msg.nickname || 'Test İzleyici', avatarUrl: '' },
            source: 'chat'
          });
          emitLog('chat', `[TEST] Yorum "${comment}" -> ${teamId} (+1 top)`);
        } else {
          emitLog('info', `[TEST] Yorum "${comment}" içinde takım kodu bulunamadı.`);
        }
      } else if (msg.type === 'RESET_GAME') {
        broadcast({ type: 'RESET_GAME' });
        emitLog('info', 'Oyun yöneticisi tarafından yeni tur başlatıldı.');
      }
    } catch (_e) {
      // ignore malformed messages
    }
  });
});

if (require.main === module) {
  const PORT = Number(process.env.PORT) || config.port || 3000;
  server.listen(PORT, () => {
    console.log(`Süper Lig Territory War sunucusu çalışıyor:`);
    console.log(`  Oyun Ekranı (9:16): http://localhost:${PORT}`);
    console.log(`  Yönetim & Test Paneli: http://localhost:${PORT}/admin`);
  });
}

module.exports = {
  app,
  server,
  computeGiftDelta,
  extractTikTokUser,
  extractTikTokGift
};
