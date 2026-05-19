(function () {
  'use strict';

  // ====================================================================
  //  Supabase 配置 — 把下面两个值填好后 push 就启用
  //  Supabase 项目 → Project Settings → API
  //  这两个值可以公开（anon key 设计给前端用，权限由 RLS 控制）
  // ====================================================================
  const SUPABASE_URL = 'https://exirxesaxbqhfxddgocf.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4aXJ4ZXNheGJxaGZ4ZGRnb2NmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMjAyMTIsImV4cCI6MjA5NDU5NjIxMn0.wCbbj_amBhkU9wFZkW2OKYhfsd6R3LZTd6XZ4NItV1E';
  // ====================================================================

  // ---------- Constants ----------
  const USERS = {
    cj:      { name: 'CJ',      region: '澳大利亚', email: 'juntaochen718@foxmail.com' },
    katrina: { name: 'Katrina', region: '中国',     email: '1huangkat@hdsb.ca' },
  };
  // 写死的身体数据 / 每日基础支出 / 计划运动量（默认值）。
  // CJ 的 BMR 1900 来自手表实测；Katrina 1358 由 Mifflin-St Jeor 公式算得。
  const USER_PROFILES = {
    cj:      { gender: '男', age: 22, height: 176, weight: 79, bmr: 1900, exercise: 800 },
    katrina: { gender: '女', age: 25, height: 167, weight: 60, bmr: 1358, exercise: 200 },
  };
  const EMAIL_TO_USER = {};
  const EMAIL_TO_KEY = {};
  for (const k in USERS) { EMAIL_TO_USER[USERS[k].email] = USERS[k]; EMAIL_TO_KEY[USERS[k].email] = k; }
  const DEFAULT_DEFICIT = 500;
  // settings.threshold 列被复用为「热量缺口」；老数据通常是 1500+ 的摄入阈值，遇到就回退默认值。
  const MAX_PLAUSIBLE_DEFICIT = 1500;
  const MAX_PLAUSIBLE_EXERCISE = 3000;
  const KJ_TO_KCAL = 1 / 4.184;
  const LAST_LOGIN_KEY = 'calorie_calc_last_login_user';
  // 用户改运动量时，每按一下键都打一次库太浪费——攒 600ms 没新输入再写。
  const EXERCISE_SAVE_DEBOUNCE_MS = 600;

  // ---------- State ----------
  let sb = null;
  let session = null;
  let userName = null;
  let userKey = null;
  let profile = null;
  let deficit = DEFAULT_DEFICIT;
  let dailyExercise = 0;
  let todayEntries = [];
  let historyData = {};
  let statsRange = 'week';
  let inputMode = 'direct';
  let midnightTimer = null;
  let currentDate = null;
  let aiEstimate = null;
  let exerciseSaveTimer = null;

  function targetIntake() {
    if (!profile) return 0;
    return profile.bmr + dailyExercise - deficit;
  }
  // 每日运动量：以 daily_exercise 表为唯一真相。
  //   - 当天没行 → 用 profile.exercise 默认值（也就是次日"自动回默认"的来源）
  //   - 当天有行 → 用那个值（跨设备/浏览器一致）
  // 错误一律吞掉走默认值，避免表还没建好时整个 loadAll 挂掉。
  async function fetchDailyExerciseFromDb(date) {
    if (!profile || !session) return null;
    try {
      const { data, error } = await withTimeout(
        sb.from('daily_exercise')
          .select('kcal')
          .eq('user_id', session.user.id)
          .eq('date', date)
          .maybeSingle(),
        6000,
        'fetchDailyExercise'
      );
      if (error) throw error;
      if (!data) return null;
      const v = Number(data.kcal);
      return (isFinite(v) && v >= 0 && v <= MAX_PLAUSIBLE_EXERCISE) ? v : null;
    } catch (e) {
      console.warn('[fetchDailyExercise] failed (falling back to default):', e);
      return null;
    }
  }
  async function saveDailyExerciseToDb(date, value) {
    if (!session) return;
    try {
      const { error } = await withTimeout(
        sb.from('daily_exercise').upsert({
          user_id: session.user.id,
          date,
          kcal: value,
          updated_at: new Date().toISOString(),
        }),
        6000,
        'saveDailyExercise'
      );
      if (error) throw error;
    } catch (e) {
      console.warn('[saveDailyExercise] failed:', e);
      if (isAuthError(e)) { await forceReauth('会话已过期，请重新登录'); }
    }
  }
  async function clearDailyExerciseInDb(date) {
    if (!session) return;
    try {
      const { error } = await withTimeout(
        sb.from('daily_exercise').delete()
          .eq('user_id', session.user.id)
          .eq('date', date),
        6000,
        'clearDailyExercise'
      );
      if (error) throw error;
    } catch (e) {
      console.warn('[clearDailyExercise] failed:', e);
      if (isAuthError(e)) { await forceReauth('会话已过期，请重新登录'); }
    }
  }
  // 把还在防抖窗口里的待写值立刻冲到库里。失焦/关闭/切走时用。
  function flushPendingExerciseSave() {
    if (exerciseSaveTimer) {
      clearTimeout(exerciseSaveTimer);
      exerciseSaveTimer = null;
      saveDailyExerciseToDb(currentDate, dailyExercise);
    }
  }

  // ---------- Utils ----------
  // 给可能 hang 住的 await 加超时兜底。
  // 历史问题：关闭窗口时 supabase 的 refresh-token rotation 可能写一半，
  // 重开后 getSession() 内部 refresh 会永远 await（fetch 卡在网络层、
  // 或 navigator.locks 被节流的旧 tab 持有），UI 永远停在 login overlay。
  // 套个 timeout，超时按"会话坏了"处理即可。
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        const e = new Error(`${label} 超时（${ms}ms）`);
        e.__timeout = true;
        rej(e);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
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
  // Supabase 默认的 lock 实现会用 navigator.locks 阻塞式等另一个标签释放锁。
  // 如果有标签崩了 / 被浏览器后台节流 / OneDrive 同步把页面卡住，那把锁永远不释放，
  // 新登录请求 200 回来之后写不进 storage，SIGNED_IN 事件不发，UI 不跳转。
  // 这里用 ifAvailable 轮询 + 3 秒强制放行兜底（应用是单用户、写入是 session token，
  // 极小概率 last-write-wins 完全可接受）。
  async function authLock(name, acquireTimeout, fn) {
    if (typeof navigator === 'undefined' || !navigator.locks || !navigator.locks.request) {
      return await fn();
    }
    const tryOnce = () => navigator.locks.request(
      name,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => lock ? { ok: true, value: await fn() } : { ok: false }
    );
    const budget = Math.max(500, Math.min(acquireTimeout || 3000, 3000));
    const start = Date.now();
    while (true) {
      const r = await tryOnce();
      if (r.ok) return r.value;
      if (Date.now() - start >= budget) {
        console.warn('[authLock] timeout, proceeding without lock:', name);
        return await fn();
      }
      await new Promise(res => setTimeout(res, 80));
    }
  }
  // 识别 Supabase 抛出的「会话失效」类错误。出现这些时必须强制重新登录，
  // 否则 localStorage 里的坏 token 会一直发给后端，所有请求都 401，
  // 用户只能开无痕窗口（参见之前那个「后端连不上」的 bug）。
  function isAuthError(e) {
    if (!e) return false;
    const status = e.status || (e.context && e.context.status) || 0;
    if (status === 401 || status === 403) return true;
    const msg = String(e.message || e.error_description || e).toLowerCase();
    return /jwt|token|refresh|session|not authenticated|user.*not.*found|expired|unauthor/i.test(msg);
  }
  async function forceReauth(msg) {
    console.warn('[forceReauth]', msg);
    // signOut 自己也走 auth lock，坏 token / 锁竞争下同样会 hang，
    // 没超时的话 forceReauth 永远不返回，UI 永远卡在 loading——
    // 这就是上一版 timeout 兜底为什么没生效。这里 2 秒强制放行。
    try {
      await withTimeout(sb.auth.signOut({ scope: 'local' }), 2000, 'forceReauth/signOut');
    } catch (e) {
      console.warn('[forceReauth] signOut skipped:', e.message || e);
    }
    // 兜底：signOut 自己也可能因坏 token 出错或刚刚被超时跳过，直接铲掉所有 sb-* 键。
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-')) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch (_) {}
    session = null;
    userName = null;
    userKey = null;
    profile = null;
    deficit = DEFAULT_DEFICIT;
    if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
    showLogin(msg || '会话已过期，请重新登录');
  }
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
      // 套超时，否则锁/网络卡死时按钮永远停在"登录中…"。
      const { error } = await withTimeout(
        sb.auth.signInWithPassword({ email: user.email, password }),
        10000,
        'signInWithPassword'
      );
      if (error) throw error;
      localStorage.setItem(LAST_LOGIN_KEY, key);
    } catch (e) {
      if (e.__timeout) {
        // 登录请求卡住，多半 auth 锁/storage 坏了，硬清理 sb-* 后让用户再点一次。
        console.warn('[handleLogin] timeout — purging sb-* and prompting retry');
        try {
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('sb-')) keys.push(k);
          }
          for (const k of keys) localStorage.removeItem(k);
        } catch (_) {}
        $('#loginError').textContent = '登录请求超时，已清理本地会话，请再点一次登录';
      } else {
        $('#loginError').textContent = '登录失败：' + (e.message || '未知错误');
      }
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
    const exFromDb = await fetchDailyExerciseFromDb(currentDate);
    dailyExercise = exFromDb != null ? exFromDb : (profile ? profile.exercise : 0);

    const { data: settings, error: e1 } = await withTimeout(
      sb.from('settings').select('threshold').eq('user_id', userId).maybeSingle(),
      8000,
      'loadAll/settings'
    );
    if (e1) throw e1;
    const stored = settings != null ? Number(settings.threshold) : null;
    deficit = (stored != null && isFinite(stored) && stored >= 0 && stored <= MAX_PLAUSIBLE_DEFICIT)
      ? stored
      : DEFAULT_DEFICIT;

    const { data: entries, error: e2 } = await withTimeout(
      sb.from('entries').select('*').eq('date', currentDate).order('created_at', { ascending: false }),
      8000,
      'loadAll/entries'
    );
    if (e2) throw e2;
    todayEntries = entries || [];

    const startStr = daysAgoStr(30);
    const { data: hist, error: e3 } = await withTimeout(
      sb.from('entries').select('date, calories').gte('date', startStr).lt('date', currentDate),
      8000,
      'loadAll/history'
    );
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
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return null; }
      alert('添加失败：' + error.message);
      return null;
    }
    if (data.date === currentDate) todayEntries.unshift(data);
    return data;
  }
  async function removeEntry(id) {
    const { error } = await sb.from('entries').delete().eq('id', id);
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return; }
      alert('删除失败：' + error.message);
      return;
    }
    todayEntries = todayEntries.filter(e => e.id !== id);
    renderToday();
  }
  async function saveDeficit(value) {
    const { error } = await sb.from('settings').upsert({
      user_id: session.user.id,
      threshold: value,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return false; }
      alert('保存失败：' + error.message);
      return false;
    }
    deficit = value;
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
    const target = targetIntake();
    const total = entriesTotal(todayEntries);
    const remaining = target - total;
    $('#totalToday').textContent = round1(total);
    $('#remaining').textContent = round1(remaining);
    const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
    $('#progressBar').style.width = pct + '%';
    $('#progressText').textContent = `${round1(total)} / ${round1(target)} 大卡`;
    const over = total > target;
    $('#progressBar').classList.toggle('over', over);
    document.querySelector('.summary-card').classList.toggle('over', over);

    if (profile) {
      $('#bdBmr').textContent = round1(profile.bmr);
      const exInput = $('#bdExerciseInput');
      if (document.activeElement !== exInput) exInput.value = round1(dailyExercise);
      $('#bdDeficit').textContent = round1(deficit);
      $('#bdTarget').textContent = round1(target);
    }

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
    const remaining = targetIntake() - total;
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
    const target = targetIntake();
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
    const overCount = series.filter(s => s.total > target).length;
    $('#statsSummary').innerHTML = `
      <div class="item"><div class="num">${round1(avg)}</div><div class="lab">日均 (有记录)</div></div>
      <div class="item"><div class="num">${overCount}</div><div class="lab">超额天数</div></div>
    `;

    const chart = $('#chart');
    chart.innerHTML = '';
    const maxScale = Math.max(max, target, 1) * 1.1;
    for (const s of series) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      if (s.total === 0) bar.classList.add('empty');
      else if (s.total > target) bar.classList.add('over');
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
        totalSpan.className = 'total' + (s.total > target ? ' over' : '');
        totalSpan.textContent = `${round1(s.total)} 大卡`;
        li.appendChild(dateSpan);
        li.appendChild(totalSpan);
        list.appendChild(li);
      }
    }
  }
  function renderSettings() {
    $('#deficitInput').value = round1(deficit);
    if (profile) {
      $('#settingsBmr').textContent = round1(profile.bmr);
      const exLabel = round1(profile.exercise);
      const exNow = round1(dailyExercise);
      $('#settingsExercise').textContent = exNow === exLabel
        ? exLabel
        : `${exNow}（默认 ${exLabel}）`;
      $('#settingsDeficit').textContent = round1(deficit);
      $('#settingsTarget').textContent = round1(targetIntake());
      $('#settingsBodyInfo').textContent =
        `${profile.gender} · ${profile.age} 岁 · ${profile.height} cm · ${profile.weight} kg`;
    }
  }

  // ---------- Form handlers ----------
  async function handleAddDirect() {
    const name = $('#d_name').value.trim() || '未命名';
    const amount = parseFloat($('#d_amount').value);
    const unit = $('#d_unit').value;
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
    const name = $('#q_name').value.trim() || '未命名';
    const amount = parseFloat($('#q_amount').value);
    const unit = $('#q_unit').value;
    const per100 = parseFloat($('#q_per100').value);
    const energyUnit = $('#q_energy_unit').value;
    if (!isFinite(amount) || amount <= 0) { alert('请输入有效摄入量'); return; }
    if (!isFinite(per100) || per100 < 0) { alert('请输入每 100 单位的能量值'); return; }
    const per100Kcal = energyUnit === 'kj' ? per100 * KJ_TO_KCAL : per100;
    const kcal = (amount / 100) * per100Kcal;
    const energyLabel = energyUnit === 'kj' ? '千焦' : '大卡';
    const detail = `${round1(amount)}${unit} × ${round1(per100)} ${energyLabel}/100${unit}`;
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
  function resetAiPanel() {
    aiEstimate = null;
    $('#ai_result').classList.add('hidden');
    $('#addAiBtn').classList.add('hidden');
    $('#ai_error').classList.add('hidden');
    $('#ai_error').textContent = '';
  }
  function showAiError(msg) {
    aiEstimate = null;
    $('#ai_result').classList.add('hidden');
    $('#addAiBtn').classList.add('hidden');
    const el = $('#ai_error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  async function handleEstimateAi() {
    const description = $('#ai_description').value.trim();
    if (!description) { showAiError('请输入食物描述'); return; }
    const btn = $('#estimateBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '估算中…';
    $('#ai_error').classList.add('hidden');
    try {
      const { data, error } = await sb.functions.invoke('estimate-calories', {
        body: { description },
      });
      if (error) {
        // Edge function returned non-2xx; try to read the structured error body for the detail
        let msg = error.message || 'AI 估算失败';
        let detail = '';
        try {
          const ctx = error.context;
          if (ctx && typeof ctx.json === 'function') {
            const body = await ctx.json();
            if (body && body.error) msg = body.error;
            if (body && body.detail) detail = body.detail;
          }
        } catch (parseErr) {
          detail = '(无法读取响应体: ' + (parseErr.message || parseErr) + ')';
        }
        showAiError(detail ? `${msg}\n${detail}` : msg);
        console.error('estimate-calories failed:', msg, detail);
        return;
      }
      if (!data || typeof data.calories !== 'number') {
        showAiError('AI 返回格式异常: ' + JSON.stringify(data).slice(0, 200));
        return;
      }
      aiEstimate = { name: data.name || description, calories: round1(data.calories) };
      $('#ai_name').textContent = aiEstimate.name;
      $('#ai_kcal').textContent = round1(aiEstimate.calories);
      $('#ai_result').classList.remove('hidden');
      $('#addAiBtn').classList.remove('hidden');
    } catch (e) {
      showAiError('网络异常：' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
  async function handleAddAi() {
    if (!aiEstimate) return;
    const btn = $('#addAiBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '添加中…';
    const entry = await addEntry({
      name: aiEstimate.name,
      calories: aiEstimate.calories,
      mode: 'ai',
      detail: 'AI 估算',
    });
    btn.disabled = false;
    btn.textContent = old;
    if (entry) {
      $('#ai_description').value = '';
      resetAiPanel();
      $('#ai_description').focus();
      renderToday();
      showLastEntryToast(entry);
    }
  }

  function updateQuantityPreview() {
    const amount = parseFloat($('#q_amount').value);
    const per100 = parseFloat($('#q_per100').value);
    const unit = $('#q_unit').value;
    const energyUnit = $('#q_energy_unit').value;
    $('#q_per_unit').textContent = unit === 'ml' ? '毫升' : '克';
    if (isFinite(amount) && isFinite(per100) && amount > 0 && per100 >= 0) {
      const per100Kcal = energyUnit === 'kj' ? per100 * KJ_TO_KCAL : per100;
      const kcal = (amount / 100) * per100Kcal;
      $('#q_preview').textContent = `≈ ${round1(kcal)} 大卡`;
    } else {
      $('#q_preview').textContent = '≈ 0 大卡';
    }
  }

  // ---------- Setup events ----------
  function setupEvents() {
    $('#loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      handleLogin();
    });
    // 密码只允许数字。手机靠 inputmode=numeric 直接出数字键盘，
    // 桌面用户还能从硬键盘敲字母，这里 JS 兜底把非数字字符剔掉。
    $('#loginPassword').addEventListener('input', (e) => {
      const cleaned = e.target.value.replace(/\D/g, '');
      if (cleaned !== e.target.value) e.target.value = cleaned;
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
        $('#mode-ai').classList.toggle('hidden', inputMode !== 'ai');
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
    ['q_amount', 'q_per100', 'q_unit', 'q_energy_unit'].forEach(id => {
      $('#' + id).addEventListener('input', updateQuantityPreview);
      $('#' + id).addEventListener('change', updateQuantityPreview);
    });
    $('#estimateBtn').addEventListener('click', handleEstimateAi);
    $('#addAiBtn').addEventListener('click', handleAddAi);
    $('#ai_description').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleEstimateAi(); }
    });
    $('#ai_description').addEventListener('input', () => {
      // 描述变了就清掉旧估算，避免误添加
      if (aiEstimate) resetAiPanel();
    });
    const bdEx = $('#bdExerciseInput');
    bdEx.addEventListener('input', () => {
      const v = parseFloat(bdEx.value);
      if (!isFinite(v) || v < 0) return;
      if (v > MAX_PLAUSIBLE_EXERCISE) return;
      dailyExercise = round1(v);
      // 防抖写库：每次按键改 in-memory + 进度条；攒够 EXERCISE_SAVE_DEBOUNCE_MS
      // 没新输入再 upsert，避免一串数字打出 5 次 PATCH。
      if (exerciseSaveTimer) clearTimeout(exerciseSaveTimer);
      const dateAtEdit = currentDate;
      const valueAtEdit = dailyExercise;
      exerciseSaveTimer = setTimeout(() => {
        exerciseSaveTimer = null;
        saveDailyExerciseToDb(dateAtEdit, valueAtEdit);
      }, EXERCISE_SAVE_DEBOUNCE_MS);
      $('#bdTarget').textContent = round1(targetIntake());
      // 重算 summary + 进度条但不刷新输入框（用户正在打字）
      const total = entriesTotal(todayEntries);
      const target = targetIntake();
      const remaining = target - total;
      $('#remaining').textContent = round1(remaining);
      const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
      $('#progressBar').style.width = pct + '%';
      $('#progressText').textContent = `${round1(total)} / ${round1(target)} 大卡`;
      const over = total > target;
      $('#progressBar').classList.toggle('over', over);
      document.querySelector('.summary-card').classList.toggle('over', over);
    });
    bdEx.addEventListener('blur', () => {
      if (bdEx.value === '' || !isFinite(parseFloat(bdEx.value))) {
        // 用户清空 = 回到默认；删掉今天的 override 行（没行 = 用 profile.exercise）。
        if (exerciseSaveTimer) { clearTimeout(exerciseSaveTimer); exerciseSaveTimer = null; }
        dailyExercise = profile ? profile.exercise : 0;
        clearDailyExerciseInDb(currentDate);
        renderToday();
      } else {
        // 失焦时把还在防抖窗口里的值立刻冲到库里，别等用户切走丢数据。
        flushPendingExerciseSave();
      }
    });

    $('#saveDeficitBtn').addEventListener('click', async () => {
      const v = parseFloat($('#deficitInput').value);
      if (!isFinite(v) || v < 0) { alert('请输入有效数值'); return; }
      if (v > MAX_PLAUSIBLE_DEFICIT) {
        alert(`缺口不能超过 ${MAX_PLAUSIBLE_DEFICIT} 大卡`);
        return;
      }
      const btn = $('#saveDeficitBtn');
      btn.disabled = true; const old = btn.textContent; btn.textContent = '保存中…';
      const ok = await saveDeficit(round1(v));
      btn.disabled = false; btn.textContent = old;
      if (ok) { renderToday(); renderStats(); renderSettings(); alert('已保存'); }
    });
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden || !session) return;
      try {
        await loadAll();
        renderAll();
      } catch (e) {
        // 切回前台再 loadAll 超时，多半是 token 在后台被 rotate 出问题
        // 或者锁被节流挂住了，按会话失效处理一次性清干净。
        if (isAuthError(e) || e.__timeout) {
          await forceReauth('会话异常已重置，请重新登录');
          return;
        }
        console.warn('[visibilitychange] loadAll failed:', e);
      }
    });
  }

  async function afterAuth() {
    const email = session.user.email;
    userKey = EMAIL_TO_KEY[email] || null;
    const u = EMAIL_TO_USER[email];
    userName = u ? u.name : email.split('@')[0];
    profile = userKey ? USER_PROFILES[userKey] : null;
    try {
      await loadAll();
      hideLogin();
      renderAll();
      scheduleMidnight();
    } catch (e) {
      console.warn('[afterAuth] loadAll failed:', e);
      // 超时几乎一定意味着 token 坏了（refresh 卡死之类），按会话失效处理
      // 而不是弹 alert 让用户卡在 overlay 上无法操作。
      if (isAuthError(e) || e.__timeout) {
        await forceReauth('会话异常已重置，请重新登录');
        return;
      }
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
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // 默认 lock 跨标签共享 navigator.locks，另一个标签崩/被节流时会
        // 把锁挂死，新登录就会停在 200 之后写不进 storage，UI 不跳转。
        // 这里改成 ifAvailable 轮询 + 3 秒后强制放行（last-write-wins 兜底）。
        lock: authLock,
      }
    });
    setupEvents();

    // 终极兜底：12 秒内启动流程没走到"登录页可见"或"今日页可见"任一稳定态，
    // 就硬清 sb-* 并 reload 一次。任何 await 卡死、forceReauth 自己也卡的
    // 极端组合都能救回来。sessionStorage 防同窗口反复 reload。
    let initWatchdog = setTimeout(() => {
      initWatchdog = null;
      console.warn('[init] watchdog fired — hard reset');
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('sb-')) keys.push(k);
        }
        for (const k of keys) localStorage.removeItem(k);
      } catch (_) {}
      if (!sessionStorage.getItem('cc_emergency_reset')) {
        sessionStorage.setItem('cc_emergency_reset', '1');
        location.reload();
      } else {
        // 已经 reload 过一次还是死，就不再 reload 防循环，强行露出登录页。
        try {
          $('#loginOverlay').classList.remove('hidden');
          $('#loginError').textContent = '启动反复失败，请检查网络或浏览器拦截';
        } catch (_) {}
      }
    }, 12000);
    function clearInitWatchdog() {
      if (initWatchdog) { clearTimeout(initWatchdog); initWatchdog = null; }
      sessionStorage.removeItem('cc_emergency_reset');
    }

    sb.auth.onAuthStateChange(async (event, sess) => {
      if (event === 'SIGNED_IN' && sess) {
        session = sess;
        await afterAuth();
        clearInitWatchdog();
      } else if ((event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && sess) {
        // 保持本地 session 引用新鲜，否则 session.access_token 会过期、
        // 而 session.user.id 虽不变但拿到的整个对象越来越旧。
        session = sess;
      } else if (event === 'SIGNED_OUT') {
        session = null;
        userName = null;
        userKey = null;
        profile = null;
        deficit = DEFAULT_DEFICIT;
        if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
        showLogin();
        clearInitWatchdog();
      }
    });

    // getSession 可能因 localStorage 里残留的坏 token 而抛错，
    // 也可能因为内部 refresh 卡死（fetch hang / navigator.locks 节流）而
    // 永远不返回——后者就是"关闭窗口重开后一直加载中"的根因。
    // 抛错 → 清 sb-* 重登；超时 → 同样按"会话坏了"处理。
    let existing = null;
    try {
      const r = await withTimeout(sb.auth.getSession(), 6000, 'init/getSession');
      existing = r && r.data ? r.data.session : null;
    } catch (e) {
      console.warn('[init] getSession failed:', e);
      await forceReauth(e.__timeout ? '会话异常已重置，请重新登录' : '会话已重置，请重新登录');
      clearInitWatchdog();
      return;
    }
    if (existing) {
      session = existing;
      await afterAuth();
    } else {
      showLogin();
    }
    clearInitWatchdog();
  });
})();
