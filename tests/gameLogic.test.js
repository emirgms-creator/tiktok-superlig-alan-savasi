const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const config = require('../server/config.json');
const {
  calculateBallsForGift,
  resolveTeamFromChat
} = require('../server/giftCalculator');
const {
  server,
  computeGiftDelta,
  extractTikTokUser,
  extractTikTokGift
} = require('../server/index');

test('calculateBallsForGift scales ball count with real TikTok gift prices', () => {
  const rose = calculateBallsForGift(1, 1);
  const fingerHeart = calculateBallsForGift(5, 1);
  const doughnut = calculateBallsForGift(30, 1);
  const handHeart = calculateBallsForGift(100, 1);
  const moneyGun = calculateBallsForGift(500, 1);
  const galaxy = calculateBallsForGift(1000, 1);

  assert.equal(rose.count, 3);
  assert.equal(fingerHeart.count, 10);
  assert.equal(doughnut.count, 35);
  assert.equal(handHeart.count, 81);
  assert.equal(moneyGun.count, 201);
  assert.equal(galaxy.count, 351);
});

test('calculateBallsForGift multiplies diamondCount by repeatCount and rejects invalid/zero inputs', () => {
  const streak5 = calculateBallsForGift(1, 5);
  assert.equal(streak5.totalDiamonds, 5);
  assert.equal(streak5.count, 10);

  assert.deepEqual(calculateBallsForGift(0, 1), { count: 0, totalDiamonds: 0 });
  assert.deepEqual(calculateBallsForGift(10, 0), { count: 0, totalDiamonds: 0 });
  assert.deepEqual(calculateBallsForGift(-5, 2), { count: 0, totalDiamonds: 0 });
  assert.deepEqual(calculateBallsForGift(undefined, 1), { count: 0, totalDiamonds: 0 });
});

test('resolveTeamFromChat detects only team codes', () => {
  assert.equal(resolveTeamFromChat('GS şampiyon!', config.chatKeywords), 'GS');
  assert.equal(resolveTeamFromChat('haydi fb', config.chatKeywords), 'FB');
  assert.equal(resolveTeamFromChat('bjk', config.chatKeywords), 'BJK');
  assert.equal(resolveTeamFromChat('TS!', config.chatKeywords), 'TS');
  assert.equal(resolveTeamFromChat('haydi fenerbahçe', config.chatKeywords), null);
  assert.equal(resolveTeamFromChat('kartal geliyor', config.chatKeywords), null);
  assert.equal(resolveTeamFromChat('merhaba arkadaşlar', config.chatKeywords), null);
});

test('computeGiftDelta tracks streaks and recovers if repeatEnd was missed', () => {
  const streaks = new Map();
  const key = 'user1_5655';

  // Normal streak: 1 -> 3 -> 5 (repeatEnd)
  assert.equal(computeGiftDelta(streaks, key, 1, 1, false, 1000), 1);
  assert.equal(computeGiftDelta(streaks, key, 1, 3, false, 1100), 2);
  assert.equal(computeGiftDelta(streaks, key, 1, 5, true, 1200), 2);
  assert.equal(streaks.has(key), false);

  // Missed repeatEnd recovery: previous streak stopped at 4, new streak starts at 1
  assert.equal(computeGiftDelta(streaks, key, 1, 4, false, 2000), 4);
  assert.equal(computeGiftDelta(streaks, key, 1, 1, false, 5000), 1);
  assert.equal(computeGiftDelta(streaks, key, 1, 2, true, 5100), 1);
  assert.equal(streaks.has(key), false);

  // Non-streakable gift returns full repeatCount
  assert.equal(computeGiftDelta(streaks, key, 0, 3, true, 6000), 3);
});

test('extractTikTokUser and extractTikTokGift support tiktok-live-connector v2 nested payloads', () => {
  const v2Payload = {
    user: {
      idStr: '999',
      displayId: 'ahmet_gs',
      nickname: 'Ahmet',
      avatarThumb: { url: ['https://cdn.example.com/a.jpg'] }
    },
    giftId: 5655,
    repeatCount: 3,
    repeatEnd: 0,
    giftDetails: {
      giftName: 'Rose',
      diamondCount: 1,
      giftType: 1
    }
  };

  assert.deepEqual(extractTikTokUser(v2Payload), {
    uniqueId: 'ahmet_gs',
    nickname: 'Ahmet',
    avatarUrl: 'https://cdn.example.com/a.jpg'
  });

  assert.deepEqual(extractTikTokGift(v2Payload), {
    giftId: 5655,
    giftName: 'Rose',
    diamondCount: 1,
    giftType: 1,
    repeatCount: 3,
    repeatEnd: false
  });
});

test('extractTikTokGift supports real tiktok-live-connector 2.5 (proto v3) payload with data.gift', () => {
  const realPayload = {
    giftId: '5655',
    repeatCount: 4,
    repeatEnd: 1,
    user: { displayId: 'ayse_fb', nickname: 'Ayşe', avatarThumb: { urlList: ['https://x/y.jpg'] } },
    gift: { id: '5655', name: 'Rose', diamondCount: 1, type: 1 }
  };
  assert.deepEqual(extractTikTokGift(realPayload), {
    giftId: '5655',
    giftName: 'Rose',
    diamondCount: 1,
    giftType: 1,
    repeatCount: 4,
    repeatEnd: true
  });
  assert.equal(extractTikTokUser(realPayload).uniqueId, 'ayse_fb');
  assert.equal(extractTikTokUser(realPayload).avatarUrl, 'https://x/y.jpg');
});

test('HTTP and WebSocket server integration works end-to-end', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  let ws = null;
  t.after(async () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.terminate();
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  // 1. /api/config and /api/status
  const cfgRes = await fetch(`${baseUrl}/api/config`);
  assert.equal(cfgRes.status, 200);
  const cfgJson = await cfgRes.json();
  assert.equal(cfgJson.teams.length, 4);

  const statusRes = await fetch(`${baseUrl}/api/status`);
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.connected, false);

  // 2. /api/connect rejects empty username
  const badConnectRes = await fetch(`${baseUrl}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '   ' })
  });
  assert.equal(badConnectRes.status, 500);
  const badConnectJson = await badConnectRes.json();
  assert.equal(badConnectJson.ok, false);

  // 3. WebSocket INIT, SIMULATE_CHAT, SIMULATE_SPAWN, RESET_GAME
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === 'INIT') resolve();
    });
  });

  assert.equal(messages[0].type, 'INIT');
  assert.equal(messages[0].config.teams.length, 4);

  const waitForType = (type) =>
    new Promise((resolve) => {
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === type) {
          ws.off('message', handler);
          resolve(msg);
        }
      };
      ws.on('message', handler);
    });

  // SIMULATE_CHAT -> SPAWN_BALL
  const chatSpawnPromise = waitForType('SPAWN_BALL');
  ws.send(JSON.stringify({ type: 'SIMULATE_CHAT', comment: 'Haydi GS!' }));
  const chatSpawn = await chatSpawnPromise;
  assert.equal(chatSpawn.teamId, 'GS');
  assert.equal(chatSpawn.count, 1);
  assert.equal(chatSpawn.source, 'chat');

  // SIMULATE_SPAWN (5 diamonds = 10 balls) -> SPAWN_BALL
  const giftSpawnPromise = waitForType('SPAWN_BALL');
  ws.send(JSON.stringify({ type: 'SIMULATE_SPAWN', teamId: 'FB', diamonds: 5 }));
  const giftSpawn = await giftSpawnPromise;
  assert.equal(giftSpawn.teamId, 'FB');
  assert.equal(giftSpawn.count, 10);
  assert.equal(giftSpawn.source, 'gift');

  // RESET_GAME -> RESET_GAME
  const resetPromise = waitForType('RESET_GAME');
  ws.send(JSON.stringify({ type: 'RESET_GAME' }));
  const resetMsg = await resetPromise;
  assert.equal(resetMsg.type, 'RESET_GAME');
});
