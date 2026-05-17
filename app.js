(function () {
  'use strict';

  // ---------- Constants ----------
  const USERS = {
    CJ: { name: 'CJ', region: '澳大利亚', countries: ['AU'] },
    Katrina: { name: 'Katrina', region: '中国', countries: ['CN'] },
  };
  const DEFAULT_THRESHOLD = 2000;
  const KJ_TO_KCAL = 1 / 4.184;
  const STORAGE_PREFIX = 'calorie_calc_v1_';
  const CURRENT_USER_KEY = 'calorie_calc_v1_current_user';

  // ---------- State ----------
  let currentUser = null;
  let data = null; // { threshold, currentDay: {date, entries[]}, history: {date: total} }
  let statsRange = 'week';
  let inputMode = 'direct';
  let midnightTimer = null;

  // ---------- Utils ----------
  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function formatDateLong(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    return `${y}年${m}月${d}日 周${weekdays[dt.getDay()]}`;
  }
  function formatDateShort(dateStr) {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${m}/${d}`;
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  // ---------- Storage ----------
  function storageKey(user) { return STORAGE_PREFIX + user; }
  function loadUserData(user) {
    try {
      const raw = localStorage.getItem(storageKey(user));
      if (!raw) return defaultUserData();
      const parsed = JSON.parse(raw);
      // Backfill missing fields
      if (typeof parsed.threshold !== 'number') parsed.threshold = DEFAULT_THRESHOLD;
      if (!parsed.currentDay) parsed.currentDay = { date: todayStr(), entries: [] };
      if (!parsed.history) parsed.history = {};
      return parsed;
    } catch (e) {
      console.warn('Failed to load user data', e);
      return defaultUserData();
    }
  }
  function defaultUserData() {
    return {
      threshold: DEFAULT_THRESHOLD,
      currentDay: { date: todayStr(), entries: [] },
      history: {},
    };
  }
  function saveUserData() {
    if (!currentUser || !data) return;
    localStorage.setItem(storageKey(currentUser), JSON.stringify(data));
  }
  function setCurrentUser(user) {
    currentUser = user;
    localStorage.setItem(CURRENT_USER_KEY, user);
    data = loadUserData(user);
    rolloverIfNeeded();
    scheduleMidnight();
    renderAll();
  }
  function getStoredUser() {
    return localStorage.getItem(CURRENT_USER_KEY);
  }

  // ---------- Daily rollover ----------
  function entriesTotal(entries) {
    return entries.reduce((s, e) => s + (e.calories || 0), 0);
  }
  function rolloverIfNeeded() {
    const today = todayStr();
    if (data.currentDay.date !== today) {
      const total = entriesTotal(data.currentDay.entries);
      // Only write to history if there was activity
      if (total > 0 || data.currentDay.entries.length > 0) {
        data.history[data.currentDay.date] = round1(total);
      }
      data.currentDay = { date: today, entries: [] };
      saveUserData();
    }
  }
  function scheduleMidnight() {
    if (midnightTimer) clearTimeout(midnightTimer);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const ms = next - now;
    midnightTimer = setTimeout(() => {
      rolloverIfNeeded();
      renderAll();
      scheduleMidnight();
    }, ms);
  }

  // ---------- IP detection ----------
  async function detectUserByIP() {
    // Try multiple providers in case one is blocked / rate-limited
    const providers = [
      { url: 'https://ipapi.co/json/', field: 'country_code' },
      { url: 'https://ipwho.is/', field: 'country_code' },
    ];
    for (const p of providers) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(p.url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) continue;
        const j = await r.json();
        const code = (j[p.field] || '').toUpperCase();
        if (!code) continue;
        for (const [uname, info] of Object.entries(USERS)) {
          if (info.countries.includes(code)) return { user: uname, code };
        }
        return { user: null, code };
      } catch (e) {
        // try next
      }
    }
    return { user: null, code: null };
  }

  // ---------- User picker ----------
  function showUserPicker(hintText, recommended) {
    const overlay = $('#userPickerOverlay');
    const hint = $('#pickerHint');
    if (hintText) hint.textContent = hintText;
    $$('#userPickerOverlay .user-btn').forEach(btn => {
      btn.classList.toggle('recommended', btn.dataset.user === recommended);
    });
    overlay.classList.remove('hidden');
  }
  function hideUserPicker() {
    $('#userPickerOverlay').classList.add('hidden');
  }

  async function bootUserSelection() {
    const stored = getStoredUser();
    if (stored && USERS[stored]) {
      setCurrentUser(stored);
      return;
    }
    showUserPicker('正在识别您的位置…', null);
    const { user, code } = await detectUserByIP();
    if (user) {
      $('#pickerHint').textContent = `已识别地区：${code}。点击确认或重新选择。`;
      $$('#userPickerOverlay .user-btn').forEach(btn => {
        btn.classList.toggle('recommended', btn.dataset.user === user);
      });
    } else {
      $('#pickerHint').textContent = code
        ? `识别地区为 ${code}，请手动选择用户。`
        : '无法识别位置，请手动选择用户。';
    }
  }

  // ---------- Adding entries ----------
  function addEntry(entry) {
    entry.id = Date.now() + Math.random().toString(36).slice(2, 7);
    entry.time = new Date().toISOString();
    data.currentDay.entries.push(entry);
    saveUserData();
    renderToday();
    showLastEntryToast(entry);
  }
  function deleteEntry(id) {
    const idx = data.currentDay.entries.findIndex(e => e.id === id);
    if (idx >= 0) {
      data.currentDay.entries.splice(idx, 1);
      saveUserData();
      renderToday();
    }
  }

  function handleAddDirect() {
    const name = $('#d_name').value.trim();
    const amount = parseFloat($('#d_amount').value);
    const unit = $('#d_unit').value;
    if (!name) { alert('请输入食物名称'); return; }
    if (!isFinite(amount) || amount <= 0) { alert('请输入有效数值'); return; }
    const kcal = unit === 'kj' ? amount * KJ_TO_KCAL : amount;
    const detail = unit === 'kj' ? `${round1(amount)} kJ` : `${round1(amount)} 大卡`;
    addEntry({ name, calories: round1(kcal), mode: 'direct', detail });
    // clear inputs
    $('#d_name').value = '';
    $('#d_amount').value = '';
    $('#d_name').focus();
  }
  function handleAddQuantity() {
    const name = $('#q_name').value.trim();
    const amount = parseFloat($('#q_amount').value);
    const unit = $('#q_unit').value;
    const per100 = parseFloat($('#q_per100').value);
    if (!name) { alert('请输入食物名称'); return; }
    if (!isFinite(amount) || amount <= 0) { alert('请输入有效摄入量'); return; }
    if (!isFinite(per100) || per100 < 0) { alert('请输入每 100 单位的卡路里'); return; }
    const kcal = (amount / 100) * per100;
    const detail = `${round1(amount)}${unit} × ${round1(per100)} 大卡/100${unit}`;
    addEntry({ name, calories: round1(kcal), mode: 'quantity', detail });
    $('#q_name').value = '';
    $('#q_amount').value = '';
    $('#q_per100').value = '';
    updateQuantityPreview();
    $('#q_name').focus();
  }
  function updateQuantityPreview() {
    const amount = parseFloat($('#q_amount').value);
    const per100 = parseFloat($('#q_per100').value);
    const unit = $('#q_unit').value;
    $('#q_per_unit').textContent = unit === 'ml' ? '毫升' : '克';
    if (isFinite(amount) && isFinite(per100) && amount > 0 && per100 >= 0) {
      const kcal = (amount / 100) * per100;
      $('#q_preview').textContent = `≈ ${round1(kcal)} 大卡`;
    } else {
      $('#q_preview').textContent = '≈ 0 大卡';
    }
  }

  // ---------- Rendering ----------
  function renderAll() {
    renderHeader();
    renderToday();
    renderStats();
    renderSettings();
  }
  function renderHeader() {
    $('#currentUserBadge').textContent = currentUser || '--';
    $('#settingsUserName').textContent = currentUser
      ? `${currentUser} · ${USERS[currentUser].region}`
      : '--';
  }
  function renderToday() {
    $('#dateLine').textContent = formatDateLong(data.currentDay.date);
    const total = entriesTotal(data.currentDay.entries);
    const threshold = data.threshold || DEFAULT_THRESHOLD;
    const remaining = threshold - total;
    $('#totalToday').textContent = round1(total);
    $('#remaining').textContent = round1(remaining);
    const pct = threshold > 0 ? Math.min(100, (total / threshold) * 100) : 0;
    $('#progressBar').style.width = pct + '%';
    $('#progressText').textContent = `${round1(total)} / ${round1(threshold)} 大卡`;
    const over = total > threshold;
    $('#progressBar').classList.toggle('over', over);
    document.querySelector('.summary-card').classList.toggle('over', over);

    const list = $('#entryList');
    list.innerHTML = '';
    if (data.currentDay.entries.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还没有记录，添加第一项吧';
      list.appendChild(li);
      return;
    }
    // newest first
    const sorted = [...data.currentDay.entries].slice().reverse();
    for (const e of sorted) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = e.name;
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = e.detail || '';
      left.appendChild(name);
      left.appendChild(detail);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      const kcal = document.createElement('span');
      kcal.className = 'kcal';
      kcal.textContent = `${round1(e.calories)} 大卡`;
      const del = document.createElement('button');
      del.className = 'delete';
      del.textContent = '×';
      del.title = '删除';
      del.addEventListener('click', () => deleteEntry(e.id));
      right.appendChild(kcal);
      right.appendChild(del);

      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    }
  }

  function showLastEntryToast(entry) {
    const total = entriesTotal(data.currentDay.entries);
    const threshold = data.threshold || DEFAULT_THRESHOLD;
    const remaining = threshold - total;
    const toast = $('#lastEntryToast');
    const remText = remaining >= 0
      ? `剩余 ${round1(remaining)} 大卡。`
      : `已超出 ${round1(-remaining)} 大卡。`;
    toast.innerHTML = `已添加 <b>${entry.name}</b>：${round1(entry.calories)} 大卡。今日累计 ${round1(total)} 大卡，${remText}`;
    toast.classList.remove('hidden');
    toast.style.background = remaining < 0 ? '#fef2f2' : '#ecfdf5';
    toast.style.borderColor = remaining < 0 ? '#fecaca' : '#a7f3d0';
    toast.style.color = remaining < 0 ? '#991b1b' : '#065f46';
  }

  function renderStats() {
    const days = statsRange === 'week' ? 7 : 30;
    const todayTotal = entriesTotal(data.currentDay.entries);
    const today = todayStr();
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      let total = 0;
      if (dateStr === today) total = todayTotal;
      else total = data.history[dateStr] || 0;
      series.push({ date: dateStr, total });
    }

    // summary
    const nonZero = series.filter(s => s.total > 0);
    const sum = series.reduce((a, b) => a + b.total, 0);
    const avg = nonZero.length ? sum / nonZero.length : 0;
    const max = series.reduce((a, b) => Math.max(a, b.total), 0);
    const threshold = data.threshold || DEFAULT_THRESHOLD;
    const overCount = series.filter(s => s.total > threshold).length;
    $('#statsSummary').innerHTML = `
      <div class="item"><div class="num">${round1(avg)}</div><div class="lab">日均 (有记录)</div></div>
      <div class="item"><div class="num">${round1(sum)}</div><div class="lab">总计</div></div>
      <div class="item"><div class="num">${overCount}</div><div class="lab">超额天数</div></div>
    `;

    // chart
    const chart = $('#chart');
    chart.innerHTML = '';
    const maxScale = Math.max(max, threshold, 1) * 1.1;
    for (const s of series) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      if (s.total === 0) bar.classList.add('empty');
      else if (s.total > threshold) bar.classList.add('over');
      const h = s.total > 0 ? (s.total / maxScale) * 100 : 1;
      bar.style.height = h + '%';
      const lab = document.createElement('span');
      lab.className = 'bar-label';
      lab.textContent = formatDateShort(s.date);
      bar.appendChild(lab);
      if (s.total > 0 && days <= 7) {
        const val = document.createElement('span');
        val.className = 'bar-value';
        val.textContent = round1(s.total);
        bar.appendChild(val);
      }
      bar.title = `${s.date}: ${round1(s.total)} 大卡`;
      chart.appendChild(bar);
    }

    // history list (only days with data, newest first)
    const list = $('#historyList');
    list.innerHTML = '';
    const withData = series.filter(s => s.total > 0).slice().reverse();
    if (withData.length === 0) {
      const li = document.createElement('li');
      li.style.color = 'var(--muted)';
      li.style.textAlign = 'center';
      li.style.padding = '12px 0';
      li.textContent = '暂无历史记录';
      list.appendChild(li);
    } else {
      for (const s of withData) {
        const li = document.createElement('li');
        const dateSpan = document.createElement('span');
        dateSpan.className = 'date';
        dateSpan.textContent = formatDateLong(s.date);
        const totalSpan = document.createElement('span');
        totalSpan.className = 'total' + (s.total > threshold ? ' over' : '');
        totalSpan.textContent = `${round1(s.total)} 大卡`;
        li.appendChild(dateSpan);
        li.appendChild(totalSpan);
        list.appendChild(li);
      }
    }
  }

  function renderSettings() {
    $('#thresholdInput').value = data.threshold || DEFAULT_THRESHOLD;
  }

  // ---------- Event wiring ----------
  function setupEvents() {
    // Tabs
    $$('.tab').forEach(t => {
      t.addEventListener('click', () => {
        $$('.tab').forEach(x => x.classList.remove('active'));
        $$('.tab-panel').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        $('#tab-' + t.dataset.tab).classList.add('active');
        if (t.dataset.tab === 'stats') renderStats();
      });
    });
    // Mode switch
    $$('.mode-btn').forEach(b => {
      b.addEventListener('click', () => {
        $$('.mode-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        inputMode = b.dataset.mode;
        $('#mode-direct').classList.toggle('hidden', inputMode !== 'direct');
        $('#mode-quantity').classList.toggle('hidden', inputMode !== 'quantity');
      });
    });
    // Range
    $$('.range-btn').forEach(b => {
      b.addEventListener('click', () => {
        $$('.range-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        statsRange = b.dataset.range;
        renderStats();
      });
    });
    // Add buttons
    $('#addDirectBtn').addEventListener('click', handleAddDirect);
    $('#addQuantityBtn').addEventListener('click', handleAddQuantity);
    // Live preview
    ['q_amount', 'q_per100', 'q_unit'].forEach(id => {
      $('#' + id).addEventListener('input', updateQuantityPreview);
      $('#' + id).addEventListener('change', updateQuantityPreview);
    });
    // Threshold
    $('#saveThresholdBtn').addEventListener('click', () => {
      const v = parseFloat($('#thresholdInput').value);
      if (!isFinite(v) || v <= 0) { alert('请输入有效数值'); return; }
      data.threshold = round1(v);
      saveUserData();
      renderToday();
      renderStats();
      alert('已保存');
    });
    // User switch
    $('#switchUserBtn').addEventListener('click', () => {
      showUserPicker('选择要切换的用户', currentUser);
    });
    $('#changeUserBtn').addEventListener('click', () => {
      showUserPicker('选择要切换的用户', currentUser);
    });
    $$('#userPickerOverlay .user-btn').forEach(b => {
      b.addEventListener('click', () => {
        const u = b.dataset.user;
        if (!USERS[u]) return;
        hideUserPicker();
        setCurrentUser(u);
      });
    });
    // Clear data
    $('#clearDataBtn').addEventListener('click', () => {
      if (!currentUser) return;
      if (!confirm(`确定清除 ${currentUser} 的全部数据？此操作无法恢复。`)) return;
      localStorage.removeItem(storageKey(currentUser));
      data = defaultUserData();
      saveUserData();
      renderAll();
      alert('已清除');
    });
    // Re-check rollover when tab regains focus
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && data) {
        rolloverIfNeeded();
        renderAll();
      }
    });
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', () => {
    setupEvents();
    bootUserSelection();
  });
})();
