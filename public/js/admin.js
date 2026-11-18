(() => {
  const ttStatusEl = document.getElementById('tt-status');
  const ttUsernameInput = document.getElementById('tt-username');
  const btnConnect = document.getElementById('btn-connect');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const btnReset = document.getElementById('btn-reset');
  const adminChatInput = document.getElementById('admin-chat-input');
  const adminChatSend = document.getElementById('admin-chat-send');
  const simTeamsEl = document.getElementById('sim-teams');
  const logBoxEl = document.getElementById('log-box');

  let ws = null;
  let config = null;
  const adminToken = new URLSearchParams(location.search).get('token') || '';

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  function addLog(level, message, timestamp) {
    const item = document.createElement('div');
    item.className = `log-item ${level}`;
    const time = timestamp || new Date().toLocaleTimeString('tr-TR');
    item.textContent = `[${time}] ${message}`;
    logBoxEl.prepend(item);
    while (logBoxEl.children.length > 80) {
      logBoxEl.removeChild(logBoxEl.lastChild);
    }
  }

  function updateStatusBadge(status) {
    if (!status) return;
    ttStatusEl.classList.remove('connected', 'connecting');
    if (status.connected) {
      ttStatusEl.textContent = `Bağlı: @${status.username}`;
      ttStatusEl.classList.add('connected');
    } else if (status.connecting) {
      ttStatusEl.textContent = `Bağlanıyor (@${status.username})...`;
      ttStatusEl.classList.add('connecting');
    } else {
      ttStatusEl.textContent = status.error ? `Hata: ${status.error}` : 'Bağlı Değil';
    }
  }

  function renderSimulator() {
    if (!config) return;
    simTeamsEl.innerHTML = '';
    for (const team of config.teams) {
      const card = document.createElement('div');
      card.className = 'sim-card';
      const safeColor = escapeHtml(team.accentColor || team.secondaryColor || '#38bdf8');
      const safeId = escapeHtml(team.id);
      const safeName = escapeHtml(team.name);
      card.style.borderColor = team.accentColor || team.secondaryColor;
      card.innerHTML = `
        <h3 style="color:${safeColor}">${safeName} (${safeId})</h3>
        <div class="sim-btns">
          <button data-team="${safeId}" data-diamonds="0">💬 Yorum (+1)</button>
          <button data-team="${safeId}" data-diamonds="1">🌹 Gül (+3)</button>
          <button data-team="${safeId}" data-diamonds="5">🫰 Parmak Kalp (+10)</button>
          <button data-team="${safeId}" data-diamonds="30">🍩 Donut (+35)</button>
          <button data-team="${safeId}" data-diamonds="100">🫶 El Kalbi (+81)</button>
          <button data-team="${safeId}" data-diamonds="500">🔫 Para Tabancası (+201)</button>
          <button data-team="${safeId}" data-diamonds="1000" style="grid-column: span 2; background:#7c3aed;">🌌 Galaksi (+351)</button>
        </div>
      `;
      simTeamsEl.appendChild(card);
    }

    simTeamsEl.querySelectorAll('button[data-team]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!ws || ws.readyState !== 1) return;
        const teamId = btn.dataset.team;
        const diamonds = Number(btn.dataset.diamonds) || 0;
        ws.send(
          JSON.stringify({
            type: 'SIMULATE_SPAWN',
            teamId,
            diamonds,
            count: 1,
            nickname: `${teamId}_Taraftar`,
            token: adminToken
          })
        );
      });
    });
  }

  function sendChatSimulation() {
    const comment = adminChatInput.value.trim();
    if (!comment || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'SIMULATE_CHAT', comment, nickname: 'Test_İzleyici', token: adminToken }));
    adminChatInput.value = '';
  }

  adminChatSend.addEventListener('click', sendChatSimulation);
  adminChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatSimulation();
  });

  btnConnect.addEventListener('click', async () => {
    const username = ttUsernameInput.value.trim();
    if (!username) {
      addLog('error', 'Lütfen bir TikTok kullanıcı adı girin.');
      return;
    }
    updateStatusBadge({ connecting: true, username });
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken ? { 'x-admin-token': adminToken } : {})
        },
        body: JSON.stringify({ username })
      });
      const data = await res.json();
      if (!data.ok) {
        addLog('error', data.error || 'Bağlanılamadı');
      }
    } catch (err) {
      addLog('error', err.message);
    }
  });

  btnDisconnect.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/disconnect', {
        method: 'POST',
        headers: adminToken ? { 'x-admin-token': adminToken } : {}
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        addLog('error', data.error || 'Bağlantı kesilemedi');
      }
    } catch (err) {
      addLog('error', err.message || 'Bağlantı kesme hatası');
    }
  });

  btnReset.addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'RESET_GAME', token: adminToken }));
    }
  });

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => addLog('success', 'Sunucuya bağlanıldı.');
    ws.onclose = () => {
      addLog('warn', 'Sunucu bağlantısı koptu, yeniden bağlanılıyor...');
      setTimeout(connectWs, 2000);
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'INIT') {
        config = msg.config;
        updateStatusBadge(msg.status);
        renderSimulator();
      } else if (msg.type === 'TIKTOK_STATUS') {
        updateStatusBadge(msg.status);
      } else if (msg.type === 'LOG') {
        addLog(msg.level, msg.message, msg.timestamp);
      }
    };
  }

  connectWs();
})();
