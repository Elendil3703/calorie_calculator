(function () {
  'use strict';

  // ====================================================================
  //  Supabase 配置 — 把下面两个值填好后 push 就启用
  //  Supabase 项目 → Project Settings → API
  //  这两个值可以公开（anon key 设计给前端用，权限由 RLS 控制）
  // ====================================================================
  const SUPABASE_URL = 'https://exirxesaxbqhfxddgocf.supabase.co/rest/v1/';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4aXJ4ZXNheGJxaGZ4ZGRnb2NmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMjAyMTIsImV4cCI6MjA5NDU5NjIxMn0.wCbbj_amBhkU9wFZkW2OKYhfsd6R3LZTd6XZ4NItV1E';
  // ====================================================================

  // ---------- Constants ----------
  const USERS = {
    cj:      { name: 'CJ',      region: '澳大利亚', email: 'cj@example.com' },
    katrina: { name: 'Katrina', region: '中国',     email: 'katrina@example.com' },
  };
  const EMAIL_TO_USER = {};
  for (const k in USERS) EMAIL_TO_USER[USERS[k].email] = USERS[k];
  const DEFAULT_THRESHOLD = 2000;
  const KJ_TO_KCAL = 1 / 4.184;
  const LAST_LOGIN_KEY = 'calorie_calc_last_login_user';

  // ---------- State ----------
  let sb = null;
  let session = null;
  let userName = null;
  let threshold = DEFAULT_THRESHOLD;
  let todayEntries = [];
  let historyData = {};
  let statsRange = 'week';
  let inputMode = 'direct';
  let midnightTimer = null;
  let currentDate = null;

  // ---------- Utils ----------
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function daysAgoStr(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

  // ---------- Auth ----------
  function showLogin(msg) {
    $('#loginOverlay').classList.remove('hidden');
    $('#loginError').textContent = msg || '';
    const last = localStorage.getItem(LAST_LOGIN_KEY);
    if (last && USERS[last]) $('#loginUser').value = last;
    $('#loginPassword').focus();
  }
  function hideLogin() {
    $('#loginOverlay').classList.add('hidden');
    $('#loginPassword').value = '';
  }
  async function handleLogin() {
    const key = $('#loginUser').value;
    const password = $('#loginPassword').value;
    const user = USERS[key];
    if (!user) return;
    if (!password) { $('#loginError').textContent = '请输入密码'; return; }
    $('#loginError').textContent = '';
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const { error } = await sb.auth.signInWithPassword({ email: user.email, password });
      if (error) throw error;
      localStorage.setItem(LAST_LOGIN_KEY, key);
    } catch (e) {
      $('#loginError').textContent = '登录失败：' + (e.message || '未知错误');
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  }
  async function handleLogout() {
    if (!confirm('确定登出？')) return;
    await sb.auth.signOut();
  }

  // ---------- Data ----------
  async function loadAll() {
    currentDate = todayStr();
    const userId = session.user.id;

    const { data: settings, error: e1 } = await sb
      .from('settings')
      .select('threshold')
      .eq('user_id', userId)
      .maybeSingle();
    if (e1) throw e1;
    threshold = settings ? Number(settings.threshold) : DEFAULT_THRESHOLD;

    const { data: entries, error: e2 } = await sb
      .from('entries')
      .select('*')
      .eq('date', currentDate)
      .order('created_at', { ascending: false });
    if (e2) throw e2;
    todayEntries = entries || [];

    const startStr = daysAgoStr(30);
    const { data: hist, error: e3 } = await sb
      .from('entries')
      .select('date, calories')
      .gte('date', startStr)
      .lt('date', currentDate);
    if (e3) throw e3;
    historyData = {};
    for (const row of (hist || [])) {
      historyData[row.date] = (historyData[row.date] || 0) + Number(row.calories);
    }
  }

  async function addEntry(payload) {
    payload.date = todayStr();
    payload.user_id = session.user.id;
    const { data, error } = await sb.from('entries').insert(payload).select().single();
    if (error) { alert('添加失败：' + error.message); return null; }
    if (data.date === currentDate) todayEntries.unshift(data);
    return data;
  }
  async function removeEntry(id) {
    const { error } = await sb.from('entries').delete().eq('id', id);
    if (error) { alert('删除失败：' + error.message); return; }
    todayEntries = todayEntries.filter(e => e.id !== id);
    renderToday();
  }
  async function saveThreshold(value) {
    const { error } = await sb.from('settings').upsert({
      user_id: session.user.id,
      threshold: value,
      updated_at: new Date().toISOString(),
    });
    if (error) { alert('保存失败：' + error.message); return false; }
    threshold = value;
    return true;
  }

  // ---------- Midnight rollover ----------
  function scheduleMidnight() {
    if (midnightTimer) clearTimeout(midnightTimer);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    midnightTimer = setTimeout(async () => {
      try { await loadAll(); renderAll(); } catch (e) { console.warn(e); }
      scheduleMidnight();
    }, next - now);
  }

  // ---------- Rendering ----------
  function entriesTotal(entries) {
    return entries.reduce((s, e) => s + Number(e.calories), 0);
  }
  function renderAll() {
    renderHeader();
    renderToday();
    renderStats();
    renderSettings();
  }
  function renderHeader() {
    $('#currentUserBadge').textContent = userName || '--';
    $('#settingsUserName').textContent = userName
      ? `${userName} · ${session && session.user ? session.user.email : ''}`
      : '--';
  }
  function renderToday() {
    $('#dateLine').textContent = formatDateLong(currentDate || todayStr());
    const total = entriesTotal(todayEntries);
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
    if (todayEntries.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还没有记录，添加第一项吧';
      list.appendChild(li);
      return;
    }
    for (const e of todayEntries) {
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
      del.addEventListener('click', () => removeEntry(e.id));
      right.appendChild(kcal);
      right.appendChild(del);

      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    }
  }
  function showLastEntryToast(entry) {
    const total = entriesTotal(todayEntries);
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
    const todayTotal = entriesTotal(todayEntries);
    const today = todayStr();
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const total = dateStr === today ? todayTotal : (historyData[dateStr] || 0);
      series.push({ date: dateStr, total });
    }
    const nonZero = series.filter(s => s.total > 0);
    const sum = series.reduce((a, b) => a + b.total, 0);
    const avg = nonZero.length ? sum / nonZero.length : 0;
    const max = series.reduce((a, b) => Math.max(a, b.total), 0);
    const overCount = series.filter(s => s.total > threshold).length;
    $('#statsSummary').innerHTML = `
      <div class="item"><div class="num">${round1(avg)}</div><div class="lab">日均 (有记录)</div></div>
      <div class="item"><div class="num">${round1(sum)}</div><div class="lab">总计</div></div>
      <div class="item"><div class="num">${overCount}</div><div class="lab">超额天数</div></div>
    `;

    const chart = $('#chart');
    chart.innerHTML = '';
    const maxScale = Math.max(max, threshold, 1) * 1.1;
    for (const s of series) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      if (s.total === 0) bar.classList.add('empty');
      else if (s.total > threshold) bar.classList.add('over');
      bar.style.height = (s.total > 0 ? (s.total / maxScale) * 100 : 1) + '%';
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
    $('#thresholdInput').value = threshold || DEFAULT_THRESHOLD;
  }

  // ---------- Form handlers ----------
  async function handleAddDirect() {
    const name = $('#d_name').value.trim();
    const amount = parseFloat($('#d_amount').value);
    const unit = $('#d_unit').value;
    if (!name) { alert('请输入食物名称'); return; }
    if (!isFinite(amount) || amount <= 0) { alert('请输入有效数值'); return; }
    const kcal = unit === 'kj' ? amount * KJ_TO_KCAL : amount;
    const detail = unit === 'kj' ? `${round1(amount)} kJ` : `${round1(amount)} 大卡`;
    const btn = $('#addDirectBtn');
    btn.disabled = true; const old = btn.textContent; btn.textContent = '添加中…';
    const entry = await addEntry({ name, calories: round1(kcal), mode: 'direct', detail });
    btn.disabled = false; btn.textContent = old;
    if (entry) {
      $('#d_name').value = '';
      $('#d_amount').value = '';
      $('#d_name').focus();
      renderToday();
      showLastEntryToast(entry);
    }
  }
  async function handleAddQuantity() {
    const name = $('#q_name').value.trim();
    const amount = parseFloat($('#q_amount').value);
    const unit = $('#q_unit').value;
    const per100 = parseFloat($('#q_per100').value);
    if (!name) { alert('请输入食物名称'); return; }
    if (!isFinite(amount) || amount <= 0) { alert('请输入有效摄入量'); return; }
    if (!isFinite(per100) || per100 < 0) { alert('请输入每 100 单位的卡路里'); return; }
    const kcal = (amount / 100) * per100;
    const detail = `${round1(amount)}${unit} × ${round1(per100)} 大卡/100${unit}`;
    const btn = $('#addQuantityBtn');
    btn.disabled = true; const old = btn.textContent; btn.textContent = '添加中…';
    const entry = await addEntry({ name, calories: round1(kcal), mode: 'quantity', detail });
    btn.disabled = false; btn.textContent = old;
    if (entry) {
      $('#q_name').value = '';
      $('#q_amount').value = '';
      $('#q_per100').value = '';
      updateQuantityPreview();
      $('#q_name').focus();
      renderToday();
      showLastEntryToast(entry);
    }
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

  // ---------- Setup events ----------
  function setupEvents() {
    $('#loginBtn').addEventListener('click', handleLogin);
    $('#loginPassword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });
    $('#logoutBtn').addEventListener('click', handleLogout);
    $('#settingsLogoutBtn').addEventListener('click', handleLogout);

    $$('.tab').forEach(t => {
      t.addEventListener('click', () => {
        $$('.tab').forEach(x => x.classList.remove('active'));
        $$('.tab-panel').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        $('#tab-' + t.dataset.tab).classList.add('active');
        if (t.dataset.tab === 'stats') renderStats();
      });
    });
    $$('.mode-btn').forEach(b => {
      b.addEventListener('click', () => {
        $$('.mode-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        inputMode = b.dataset.mode;
        $('#mode-direct').classList.toggle('hidden', inputMode !== 'direct');
        $('#mode-quantity').classList.toggle('hidden', inputMode !== 'quantity');
      });
    });
    $$('.range-btn').forEach(b => {
      b.addEventListener('click', () => {
        $$('.range-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        statsRange = b.dataset.range;
        renderStats();
      });
    });
    $('#addDirectBtn').addEventListener('click', handleAddDirect);
    $('#addQuantityBtn').addEventListener('click', handleAddQuantity);
    ['q_amount', 'q_per100', 'q_unit'].forEach(id => {
      $('#' + id).addEventListener('input', updateQuantityPreview);
      $('#' + id).addEventListener('change', updateQuantityPreview);
    });
    $('#saveThresholdBtn').addEventListener('click', async () => {
      const v = parseFloat($('#thresholdInput').value);
      if (!isFinite(v) || v <= 0) { alert('请输入有效数值'); return; }
      const btn = $('#saveThresholdBtn');
      btn.disabled = true; const old = btn.textContent; btn.textContent = '保存中…';
      const ok = await saveThreshold(round1(v));
      btn.disabled = false; btn.textContent = old;
      if (ok) { renderToday(); renderStats(); alert('已保存'); }
    });
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden || !session) return;
      try { await loadAll(); renderAll(); } catch (e) { console.warn(e); }
    });
  }

  async function afterAuth() {
    const email = session.user.email;
    const u = EMAIL_TO_USER[email];
    userName = u ? u.name : email.split('@')[0];
    try {
      await loadAll();
      hideLogin();
      renderAll();
      scheduleMidnight();
    } catch (e) {
      console.warn(e);
      alert('加载数据失败：' + (e.message || e));
    }
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', async () => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      $('#loginError').textContent = '请先在 app.js 顶部配置 SUPABASE_URL 和 SUPABASE_ANON_KEY';
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      $('#loginError').textContent = 'Supabase SDK 加载失败，请检查网络';
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    setupEvents();

    sb.auth.onAuthStateChange(async (event, sess) => {
      if (event === 'SIGNED_IN' && sess) {
        session = sess;
        await afterAuth();
      } else if (event === 'SIGNED_OUT') {
        session = null;
        userName = null;
        if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
        showLogin();
      }
    });

    const { data: { session: existing } } = await sb.auth.getSession();
    if (existing) {
      session = existing;
      await afterAuth();
    } else {
      showLogin();
    }
  });
})();
