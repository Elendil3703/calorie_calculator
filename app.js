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
    cj:      { gender: '男', age: 22, height: 177, weight: 78.4, bmr: 1900, exercise: 800 },
    katrina: { gender: '女', age: 25, height: 167, weight: 60, bmr: 1358, exercise: 350 },
  };
  const EMAIL_TO_USER = {};
  const EMAIL_TO_KEY = {};
  for (const k in USERS) { EMAIL_TO_USER[USERS[k].email] = USERS[k]; EMAIL_TO_KEY[USERS[k].email] = k; }
  const DEFAULT_DEFICIT = 500;
  // settings.threshold 列被复用为「热量缺口」；老数据通常是 1500+ 的摄入阈值，遇到就回退默认值。
  const MAX_PLAUSIBLE_DEFICIT = 1500;
  const MAX_PLAUSIBLE_EXERCISE = 3000;
  // 减 1kg 体重 ≈ 7700 大卡缺口（脂肪组织约 87% 纯脂肪 × 9 kcal/g）。
  // 民间常说的 7000 是四舍五入版，这里用文献值。
  const KCAL_PER_KG = 7700;
  // 体重输入的合理范围（kg），超出按无效处理。
  const MIN_PLAUSIBLE_WEIGHT = 20;
  const MAX_PLAUSIBLE_WEIGHT = 400;
  const KJ_TO_KCAL = 1 / 4.184;
  const LAST_LOGIN_KEY = 'calorie_calc_last_login_user';
  // 用户改运动量时，每按一下键都打一次库太浪费——攒 600ms 没新输入再写。
  const EXERCISE_SAVE_DEBOUNCE_MS = 600;
  const FRIDGE_BASIS_LABEL = { per_100g: '100g', per_serving: '份' };

  // ---------- State ----------
  let sb = null;
  let session = null;
  let userName = null;
  let userKey = null;
  let profile = null;
  let deficit = DEFAULT_DEFICIT;
  // 体重目标（settings.weight_current / weight_target）。null = 还没设置；
  // 当前体重没设置时横幅回退用 profile.weight。
  let weightCurrent = null;
  let weightTarget = null;
  let dailyExercise = 0;
  let todayEntries = [];
  let historyData = {};
  // 过去 30 天的 daily_exercise 快照（没行 = 当天用 profile.exercise 默认值）。
  let historyExercise = {};
  // 过去 30 天的 daily_deficit 快照。没行 = 那一天没快照，
  // 统计页要按"无记录"处理——别拿当前 deficit 回填历史。
  let historyDeficit = {};
  // 放纵日集合（'YYYY-MM-DD'，含今天 + 过去 30 天）。在集合里 = 放纵日：
  // 统计图用特殊颜色标出，且当天摄入不计入统计。
  let cheatDays = new Set();
  // 当前打开的「往日详情」弹窗状态。date 为 null = 弹窗没开。
  let dayDetailDate = null;
  let dayDetailEntries = [];
  let statsRange = 'week';
  let inputMode = 'fridge';
  let midnightTimer = null;
  let currentDate = null;
  let aiEstimate = null;
  // AI 估算待发送的图片，元素 { dataUrl }（data:image/...;base64,...）。
  let aiImages = [];
  let exerciseSaveTimer = null;
  // 防抖窗口里待写的运动量 {date, value}；记下编辑时的日期，别用切换后的 currentDate。
  let pendingExerciseSave = null;
  let fridgeItems = [];
  // null = 添加模式；非 null = 正在编辑那一项 id
  let editingFridgeId = null;
  // 启动兜底定时器：12s 内 init 没走到稳定态就 hardReset。提到模块作用域，
  // 让 hardReset 能从任意路径里清掉它，不只是 DOMContentLoaded 内部。
  let initWatchdog = null;

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
  // 返回是否写成功——flushPendingExerciseSave 靠它决定要不要保留待写值重试。
  async function saveDailyExerciseToDb(date, value) {
    if (!session) return false;
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
      return true;
    } catch (e) {
      console.warn('[saveDailyExercise] failed:', e);
      if (isAuthError(e)) { await forceReauth('会话已过期，请重新登录'); }
      return false;
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
  // 每日 deficit：和 daily_exercise 同模式，但语义不同——没行不能 fallback 到
  // settings.threshold，因为那只是"现在"的值。历史天没行就当作没快照、统计页跳过。
  async function saveDailyDeficitToDb(date, value) {
    if (!session) return;
    try {
      const { error } = await withTimeout(
        sb.from('daily_deficit').upsert({
          user_id: session.user.id,
          date,
          kcal: value,
          updated_at: new Date().toISOString(),
        }),
        6000,
        'saveDailyDeficit'
      );
      if (error) throw error;
    } catch (e) {
      console.warn('[saveDailyDeficit] failed:', e);
      if (isAuthError(e)) { await forceReauth('会话已过期，请重新登录'); }
    }
  }

  // 放纵日：有行 = 放纵日，没行 = 普通日。on=true upsert，on=false 删行。
  async function setCheatDayInDb(date, on) {
    if (!session) return;
    try {
      if (on) {
        const { error } = await withTimeout(
          sb.from('cheat_days').upsert({
            user_id: session.user.id,
            date,
            updated_at: new Date().toISOString(),
          }),
          6000,
          'setCheatDay'
        );
        if (error) throw error;
      } else {
        const { error } = await withTimeout(
          sb.from('cheat_days').delete()
            .eq('user_id', session.user.id)
            .eq('date', date),
          6000,
          'clearCheatDay'
        );
        if (error) throw error;
      }
    } catch (e) {
      console.warn('[setCheatDay] failed:', e);
      if (isAuthError(e)) { await forceReauth('会话已过期，请重新登录'); }
    }
  }

  // 把还在防抖窗口里的待写值立刻冲到库里。失焦/关闭/切走/loadAll 前用。
  // 返回写库的 promise，调用方可以 await 它确保读回前已落库。
  // 只有写成功才清掉 pending：会话过期/断网时（含 forceReauth 把 session 清成
  // null 后 blur 再触发的那次 flush）值留在 pending 里，重新登录后 loadAll
  // 会再 flush 一次把这笔修改补写进库——否则用户的修改会静默丢失。
  function flushPendingExerciseSave() {
    if (exerciseSaveTimer) { clearTimeout(exerciseSaveTimer); exerciseSaveTimer = null; }
    const snap = pendingExerciseSave;
    if (!snap) return Promise.resolve();
    // 防串号：重登成了另一个账号时丢弃上一个账号的待写值。
    if (session && snap.userId && session.user.id !== snap.userId) {
      if (pendingExerciseSave === snap) pendingExerciseSave = null;
      return Promise.resolve();
    }
    return saveDailyExerciseToDb(snap.date, snap.value).then((ok) => {
      // 期间用户又打了新值的话 pending 已被换成新快照，别误清。
      if (ok && pendingExerciseSave === snap) pendingExerciseSave = null;
    });
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
  // 把 created_at（ISO timestamptz）格式化成本地 HH:MM，用于今日记录显示「添加时间」。
  // 老数据如果没有 created_at 或无法解析，返回空字符串。
  function formatTime(ts) {
    if (!ts) return '';
    const dt = new Date(ts);
    if (isNaN(dt.getTime())) return '';
    return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  // 库里 / 输入框里的体重值：合理范围内返回数值，否则 null（当"没设置"处理）。
  function plausibleWeight(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return (isFinite(n) && n >= MIN_PLAUSIBLE_WEIGHT && n <= MAX_PLAUSIBLE_WEIGHT) ? n : null;
  }
  function formatSignedKcal(v) {
    const r = round1(v);
    if (r === 0) return '0';
    return r > 0 ? `+${r}` : `${r}`;
  }
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  // ---------- Auth ----------
  // Supabase 默认的 lock 实现会用 navigator.locks 阻塞式等另一个标签释放锁。
  // 如果有标签崩了 / 被浏览器后台节流 / OneDrive 同步把页面卡住，那把锁永远不释放。
  //
  // 这里只用 ifAvailable 试一次，拿不到立刻 last-write-wins 放行。
  // 历史版本是"3 秒轮询 + 强制放行"——但锁被另一个 tab 的卡死 refresh 占住时，
  // 等多久都不会回来，每个查询白付 3 秒等锁预算，外层 6-8 秒 timeout 一打满
  // UI 就看起来"会话不稳、经常断连"。这是单用户应用，并发改 session token 的
  // 概率约等于 0，单次尝试 + 直接放行的成本远小于等锁的成本。
  async function authLock(name, acquireTimeout, fn) {
    if (typeof navigator === 'undefined' || !navigator.locks || !navigator.locks.request) {
      return await fn();
    }
    const r = await navigator.locks.request(
      name,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => lock ? { ok: true, value: await fn() } : { ok: false }
    );
    if (r.ok) return r.value;
    return await fn();
  }
  // 识别 Supabase 抛出的「会话失效」类错误。出现这些时必须强制重新登录，
  // 否则 localStorage 里的坏 token 会一直发给后端，所有请求都 401，
  // 用户只能开无痕窗口（参见之前那个「后端连不上」的 bug）。
  function isAuthError(e) {
    if (!e) return false;
    const status = e.status || (e.context && e.context.status) || 0;
    if (status === 401 || status === 403) return true;
    // PostgrestError 没有 status 字段，401 的信息藏在 code/details 里：
    // 坏 token 时是 {code:"PGRST301", details:"None of the keys was able to
    // decode the JWT", message:"No suitable key or wrong key type"}——
    // 光看 message 认不出来，把 code 和 details 也拼进来一起匹配。
    const msg = [e.message, e.details, e.code, e.error_description]
      .filter(Boolean).join(' ').toLowerCase() || String(e).toLowerCase();
    return /pgrst30[12]|jwt|jws|token|refresh|session|not authenticated|user.*not.*found|expired|unauthor/i.test(msg);
  }
  // 重连/会话恢复失败时的终极兜底：清 sb-* + reload 一次。
  // 为什么不能光 forceReauth？supabase 客户端实例内部可能挂着卡死的
  // refresh promise / navigator.locks 引用，光清 localStorage 不掉，
  // 下一次 signInWithPassword 也会被同一把卡死的锁拖垮——用户只能手动
  // 刷新整个页面才好。这里替用户做了那次刷新。
  // sessionStorage 标志防循环：reload 后还触发就只 cleanup 不 reload，
  // 调用方落回 forceReauth/showLogin。成功 init 时 clearInitWatchdog
  // 会顺手把这个标志清掉，下次出错才能再 reload 一次。
  // 返回 true = 即将 reload；false = 这次不 reload，调用方自行兜底。
  function hardReset(reason) {
    console.warn('[hardReset]', reason);
    if (initWatchdog) { clearTimeout(initWatchdog); initWatchdog = null; }
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
      return true;
    }
    return false;
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
    weightCurrent = null;
    weightTarget = null;
    if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
    showLogin(msg || '会话已过期，请重新登录');
  }
  // init 期间盖在最上层的"请稍后"遮罩。HTML 默认显示，凡是走到稳定态
  // (showLogin / hideLogin / 早期错误 return) 都要把它藏掉，否则用户
  // 一直看到「正在恢复会话」转圈圈。
  function hideInitOverlay() {
    const el = document.getElementById('initOverlay');
    if (el) el.classList.add('hidden');
  }
  function showLogin(msg) {
    hideInitOverlay();
    $('#loginOverlay').classList.remove('hidden');
    $('#loginError').textContent = msg || '';
    const last = localStorage.getItem(LAST_LOGIN_KEY);
    if (last && USERS[last]) $('#loginUser').value = last;
    // init 期间按钮默认是 disabled 的「正在恢复会话…」（见 DOMContentLoaded）。
    // showLogin 说明该让用户登录了，把按钮放回可点。
    // 但要避开 handleLogin 进行中的「登录中…」——那是真正在登的状态，
    // 不能被异步事件（如 SIGNED_OUT 巧合触发 showLogin）覆盖回「登录」。
    const btn = $('#loginBtn');
    if (btn.textContent !== '登录中…') {
      btn.disabled = false;
      btn.textContent = '登录';
    }
    $('#loginPassword').focus();
  }
  function hideLogin() {
    hideInitOverlay();
    $('#loginOverlay').classList.add('hidden');
    $('#loginPassword').value = '';
  }
  async function handleLogin() {
    // init 期间按钮处于「正在恢复会话…」disabled。表单 submit 还可能
    // 从 Enter 键绕过 disabled，这里再保险一次：disabled 就不要往下走。
    // 也顺手挡住 handleLogin 自身的重入（已经 disabled=true + 登录中…）。
    if ($('#loginBtn').disabled) return;
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
    // 先把还在防抖窗口里的运动量写库，否则下面 fetch 会读回旧值/默认值，
    // 把用户刚改还没落库的数字冲掉（切回前台 / 跨午夜刷新时最容易触发）。
    await flushPendingExerciseSave();
    currentDate = todayStr();
    const userId = session.user.id;
    const exFromDb = await fetchDailyExerciseFromDb(currentDate);
    dailyExercise = exFromDb != null ? exFromDb : (profile ? profile.exercise : 0);

    const { data: settings, error: e1 } = await withTimeout(
      sb.from('settings').select('threshold, weight_current, weight_target').eq('user_id', userId).maybeSingle(),
      8000,
      'loadAll/settings'
    );
    if (e1) throw e1;
    const stored = settings != null ? Number(settings.threshold) : null;
    deficit = (stored != null && isFinite(stored) && stored >= 0 && stored <= MAX_PLAUSIBLE_DEFICIT)
      ? stored
      : DEFAULT_DEFICIT;
    weightCurrent = settings ? plausibleWeight(settings.weight_current) : null;
    weightTarget = settings ? plausibleWeight(settings.weight_target) : null;

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

    // 拉历史 daily_exercise / daily_deficit 快照。表可能还没建好（新 schema），
    // 错误吞掉走默认值，整体 loadAll 不挂。
    historyExercise = {};
    historyDeficit = {};
    try {
      const { data: hex, error: e4 } = await withTimeout(
        sb.from('daily_exercise').select('date, kcal').gte('date', startStr).lt('date', currentDate),
        8000,
        'loadAll/historyExercise'
      );
      if (e4) throw e4;
      for (const row of (hex || [])) historyExercise[row.date] = Number(row.kcal);
    } catch (e) {
      console.warn('[loadAll] historyExercise failed:', e);
    }
    try {
      const { data: hdf, error: e5 } = await withTimeout(
        sb.from('daily_deficit').select('date, kcal').gte('date', startStr).lte('date', currentDate),
        8000,
        'loadAll/historyDeficit'
      );
      if (e5) throw e5;
      for (const row of (hdf || [])) historyDeficit[row.date] = Number(row.kcal);
    } catch (e) {
      console.warn('[loadAll] historyDeficit failed:', e);
    }

    // 放纵日集合：含今天（统计页不画今天，但今日页的按钮要回显状态）。
    // 表可能还没建好，错误吞掉当作"没有放纵日"。
    cheatDays = new Set();
    try {
      const { data: hcd, error: e6 } = await withTimeout(
        sb.from('cheat_days').select('date').gte('date', startStr).lte('date', currentDate),
        8000,
        'loadAll/cheatDays'
      );
      if (e6) throw e6;
      for (const row of (hcd || [])) cheatDays.add(row.date);
    } catch (e) {
      console.warn('[loadAll] cheatDays failed:', e);
    }

    // 给今天 upsert 一个 deficit 快照，覆盖最新设定。改 deficit 也会走 saveDeficit 再写一次。
    if (historyDeficit[currentDate] !== deficit) {
      historyDeficit[currentDate] = deficit;
      saveDailyDeficitToDb(currentDate, deficit);
    }

    // fridge_items 表如果还没在 Supabase 里建好，PostgREST 会回 PGRST205/42P01。
    // 那时整个 loadAll 不应该挂掉——其余功能（今日/统计）都能继续用。
    try {
      const { data: fridge, error: e4 } = await withTimeout(
        sb.from('fridge_items').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
        8000,
        'loadAll/fridge'
      );
      if (e4) throw e4;
      fridgeItems = fridge || [];
    } catch (e) {
      console.warn('[loadAll/fridge] failed (treating as empty):', e);
      fridgeItems = [];
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
  // AI 多项一次性写入。一次 insert 走一次 PostgREST，比循环 addEntry 省 N-1 次 RTT。
  // 顺手把 AI 返回的顺序也保留——倒着 unshift，让 payloads[0] 落在 todayEntries 最前。
  async function addEntries(payloads) {
    if (!payloads || payloads.length === 0) return [];
    const today = todayStr();
    const userId = session.user.id;
    const enriched = payloads.map(p => ({ ...p, date: today, user_id: userId }));
    const { data, error } = await sb.from('entries').insert(enriched).select();
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return null; }
      alert('添加失败：' + error.message);
      return null;
    }
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i].date === currentDate) todayEntries.unshift(data[i]);
    }
    return data;
  }
  async function removeEntry(id) {
    const removed = todayEntries.find(e => e.id === id) || null;
    const { error } = await sb.from('entries').delete().eq('id', id);
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return; }
      alert('删除失败：' + error.message);
      return;
    }
    todayEntries = todayEntries.filter(e => e.id !== id);
    renderToday();
    // 这条记录来自开启了容量追踪的冰箱条目：把进度退回去（最低到 0——
    // 如果这瓶在添加后已经归零换新，退到 0 就好，不往上一瓶倒推）。
    if (removed && removed.fridge_item_id && Number(removed.amount_ml) > 0) {
      const item = fridgeItems.find(it => it.id === removed.fridge_item_id);
      const vol = volumeInfo(item);
      if (vol) {
        const newUsed = round1(Math.max(0, vol.used - Number(removed.amount_ml)));
        const updated = await updateFridgeItem(item.id, { volume_used_ml: newUsed });
        if (updated) renderFridge();
      }
    }
  }
  // ---- 往日详情弹窗用的 entries 读写。和今日的 addEntry/removeEntry 分开，
  //      因为这些操作针对任意一天，要顺手保持 todayEntries 同步（万一改的是今天）。
  async function fetchEntriesForDate(date) {
    const { data, error } = await withTimeout(
      sb.from('entries').select('*').eq('date', date).order('created_at', { ascending: false }),
      8000,
      'fetchEntriesForDate'
    );
    if (error) throw error;
    return data || [];
  }
  async function updateEntryCalories(id, calories) {
    const { data, error } = await sb.from('entries')
      .update({ calories }).eq('id', id).select().single();
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return null; }
      alert('保存失败：' + error.message);
      return null;
    }
    const idx = todayEntries.findIndex(e => e.id === id);
    if (idx >= 0) todayEntries[idx] = data;
    return data;
  }
  async function deleteEntryById(id) {
    const { error } = await sb.from('entries').delete().eq('id', id);
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return false; }
      alert('删除失败：' + error.message);
      return false;
    }
    todayEntries = todayEntries.filter(e => e.id !== id);
    return true;
  }
  async function insertEntryForDate(date, payload) {
    const enriched = { ...payload, date, user_id: session.user.id };
    const { data, error } = await sb.from('entries').insert(enriched).select().single();
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return null; }
      alert('添加失败：' + error.message);
      return null;
    }
    if (date === currentDate) todayEntries.unshift(data);
    return data;
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
    // 同步写一份当天的 daily_deficit 快照，让统计页今天起对得上。
    historyDeficit[currentDate] = value;
    saveDailyDeficitToDb(currentDate, value);
    return true;
  }

  // 体重目标：和 deficit 存同一行 settings。threshold 一并带上，
  // 免得首次 upsert（行还不存在）时落成列默认值 2000。
  async function saveWeights(current, target) {
    const { error } = await sb.from('settings').upsert({
      user_id: session.user.id,
      threshold: deficit,
      weight_current: current,
      weight_target: target,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return false; }
      alert('保存失败：' + error.message);
      return false;
    }
    weightCurrent = current;
    weightTarget = target;
    return true;
  }

  // ---------- Fridge ----------
  async function addFridgeItem(payload) {
    payload.user_id = session.user.id;
    const { data, error } = await sb.from('fridge_items').insert(payload).select().single();
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return null; }
      alert('添加失败：' + error.message);
      return null;
    }
    fridgeItems.unshift(data);
    return data;
  }
  async function updateFridgeItem(id, patch) {
    patch.updated_at = new Date().toISOString();
    const { data, error } = await sb.from('fridge_items')
      .update(patch).eq('id', id).select().single();
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return null; }
      alert('保存失败：' + error.message);
      return null;
    }
    const idx = fridgeItems.findIndex(it => it.id === id);
    if (idx >= 0) fridgeItems[idx] = data;
    return data;
  }
  async function removeFridgeItem(id) {
    const { error } = await sb.from('fridge_items').delete().eq('id', id);
    if (error) {
      if (isAuthError(error)) { await forceReauth('会话已过期，请重新登录'); return; }
      alert('删除失败：' + error.message);
      return;
    }
    fridgeItems = fridgeItems.filter(it => it.id !== id);
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
    renderFridge();
    renderStats();
    renderSettings();
  }
  function renderHeader() {
    $('#currentUserBadge').textContent = userName || '--';
    $('#settingsUserName').textContent = userName
      ? `${userName} · ${session && session.user ? session.user.email : ''}`
      : '--';
  }
  function updateCheatButton() {
    const btn = $('#cheatToggleBtn');
    if (!btn) return;
    const on = cheatDays.has(currentDate || todayStr());
    btn.classList.toggle('active', on);
    btn.textContent = on ? '🍰 今天是放纵日（点击取消）' : '🍰 标记为放纵日';
  }
  async function handleToggleCheat() {
    const date = currentDate || todayStr();
    const on = !cheatDays.has(date);
    if (on) cheatDays.add(date); else cheatDays.delete(date);
    updateCheatButton();
    await setCheatDayInDb(date, on);
    renderStats();
  }
  // 距目标体重横幅：还需缺口 = (当前体重 − 目标体重) × KCAL_PER_KG。
  // 当前体重没在设置里填过就回退到 profile 里的静态体重；
  // 目标体重没设置就提示去设置页填。
  function renderGoalBanner() {
    const el = $('#goalBanner');
    if (!el) return;
    const current = weightCurrent != null ? weightCurrent : (profile ? profile.weight : null);
    if (current == null || weightTarget == null) {
      el.classList.add('zero');
      el.innerHTML = '🎯 在「设置」里填写当前体重和目标体重，这里会显示距离目标还需的热量缺口';
    } else if (current <= weightTarget) {
      el.classList.add('zero');
      el.innerHTML = `🎉 已达到目标体重 <b>${round1(weightTarget)}</b> kg，继续保持！`;
    } else {
      el.classList.remove('zero');
      const gapKg = current - weightTarget;
      const gapKcal = gapKg * KCAL_PER_KG;
      const daysLeft = deficit > 0 ? Math.ceil(gapKcal / deficit) : 0;
      el.innerHTML = `🎯 距离目标体重 <b>${round1(weightTarget)}</b> kg 还有 <b>${round1(gapKg)}</b> kg`
        + `，需要缺口 <b>${Math.round(gapKcal)}</b> 大卡`
        + (daysLeft > 0 ? `<br>按每日缺口 ${round1(deficit)} 大卡，约还需 <b>${daysLeft}</b> 天` : '');
    }
    el.classList.remove('hidden');
  }
  function renderToday() {
    renderGoalBanner();
    $('#dateLine').textContent = formatDateLong(currentDate || todayStr());
    updateCheatButton();
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
      const time = formatTime(e.created_at);
      const detailParts = [];
      if (e.detail) detailParts.push(e.detail);
      if (time) detailParts.push(time);
      detail.textContent = detailParts.join(' · ');
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
  function fridgeKcalLabel(item) {
    return `${round1(item.kcal)} 大卡 / ${FRIDGE_BASIS_LABEL[item.basis]}`;
  }
  // 容量追踪：volume_total_ml > 0 = 开启。返回 {total, used}，未开启返回 null。
  function volumeInfo(item) {
    if (!item) return null;
    const total = Number(item.volume_total_ml);
    if (!isFinite(total) || total <= 0) return null;
    let used = Number(item.volume_used_ml);
    if (!isFinite(used) || used < 0) used = 0;
    return { total, used };
  }
  function volumeText(vol) {
    return `🥛 ${round1(vol.used)} / ${round1(vol.total)} ml`;
  }
  function buildVolumeProgress(vol) {
    const wrap = document.createElement('div');
    wrap.className = 'vol-track';
    const bar = document.createElement('div');
    bar.className = 'vol-bar';
    const fill = document.createElement('div');
    fill.className = 'vol-fill';
    fill.style.width = Math.min(100, (vol.used / vol.total) * 100) + '%';
    bar.appendChild(fill);
    const text = document.createElement('div');
    text.className = 'vol-text';
    text.textContent = volumeText(vol);
    wrap.appendChild(bar);
    wrap.appendChild(text);
    return wrap;
  }
  // 容量追踪只对「每 100g/ml」计量的条目有意义（每份的没有 ml 概念），
  // 计量方式选每份时把输入框藏掉。
  function updateVolumeFieldVisibility() {
    $('#f_volume_label').classList.toggle('hidden', $('#f_basis').value !== 'per_100g');
  }
  function renderFridge() {
    populateFridgePicker();
    const list = $('#fridgeList');
    list.innerHTML = '';
    if (fridgeItems.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '冰箱还是空的，先添加一项吧';
      list.appendChild(li);
      return;
    }
    for (const item of fridgeItems) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;
      const detail = document.createElement('div');
      detail.className = 'detail';
      let detailText = fridgeKcalLabel(item);
      if (item.expiry_date) detailText += ` · 过期 ${item.expiry_date}`;
      detail.textContent = detailText;
      left.appendChild(name);
      left.appendChild(detail);
      const vol = volumeInfo(item);
      if (vol) left.appendChild(buildVolumeProgress(vol));

      const actions = document.createElement('div');
      actions.className = 'actions';
      if (vol) {
        const resetBtn = document.createElement('button');
        resetBtn.className = 'edit';
        resetBtn.textContent = '↺';
        resetBtn.title = '进度归零（换新一瓶）';
        resetBtn.addEventListener('click', async () => {
          const updated = await updateFridgeItem(item.id, { volume_used_ml: 0 });
          if (updated) renderFridge();
        });
        actions.appendChild(resetBtn);
      }
      const editBtn = document.createElement('button');
      editBtn.className = 'edit';
      editBtn.textContent = '✎';
      editBtn.title = '编辑';
      editBtn.addEventListener('click', () => enterFridgeEdit(item));
      const delBtn = document.createElement('button');
      delBtn.className = 'delete';
      delBtn.textContent = '×';
      delBtn.title = '删除';
      delBtn.addEventListener('click', () => handleDeleteFridge(item));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      li.appendChild(left);
      li.appendChild(actions);
      list.appendChild(li);
    }
  }
  function populateFridgePicker() {
    const sel = $('#q_fridge_item');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    if (fridgeItems.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（冰箱里没有食物）';
      sel.appendChild(opt);
    } else {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '（请选择）';
      sel.appendChild(placeholder);
      for (const item of fridgeItems) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = `${item.name}（${fridgeKcalLabel(item)}）`;
        sel.appendChild(opt);
      }
    }
    if (prev && fridgeItems.some(it => it.id === prev)) {
      sel.value = prev;
    }
    updateFridgePickerInfo();
    updateFridgePreview();
  }
  function showLastEntryToast(entry, extraNote) {
    const total = entriesTotal(todayEntries);
    const remaining = targetIntake() - total;
    const toast = $('#lastEntryToast');
    const remText = remaining >= 0
      ? `剩余 ${round1(remaining)} 大卡。`
      : `已超出 ${round1(-remaining)} 大卡。`;
    toast.innerHTML = `已添加 <b>${entry.name}</b>：${round1(entry.calories)} 大卡。今日累计 ${round1(total)} 大卡，${remText}`
      + (extraNote ? `<br>${extraNote}` : '');
    toast.classList.remove('hidden');
    toast.style.background = remaining < 0 ? '#fef2f2' : '#ecfdf5';
    toast.style.borderColor = remaining < 0 ? '#fecaca' : '#a7f3d0';
    toast.style.color = remaining < 0 ? '#991b1b' : '#065f46';
  }
  // AI 一次性添加多项时的 toast：列名字 + 合计。只有一项时回退到原单项 toast。
  function showLastEntriesToast(entries) {
    if (!entries || entries.length === 0) return;
    if (entries.length === 1) { showLastEntryToast(entries[0]); return; }
    const total = entriesTotal(todayEntries);
    const remaining = targetIntake() - total;
    const itemsKcal = entries.reduce((s, e) => s + Number(e.calories), 0);
    const names = entries.map(e => e.name).join('、');
    const toast = $('#lastEntryToast');
    const remText = remaining >= 0
      ? `剩余 ${round1(remaining)} 大卡。`
      : `已超出 ${round1(-remaining)} 大卡。`;
    toast.innerHTML = `已添加 <b>${entries.length} 项</b>（${names}）共 ${round1(itemsKcal)} 大卡。今日累计 ${round1(total)} 大卡，${remText}`;
    toast.classList.remove('hidden');
    toast.style.background = remaining < 0 ? '#fef2f2' : '#ecfdf5';
    toast.style.borderColor = remaining < 0 ? '#fecaca' : '#a7f3d0';
    toast.style.color = remaining < 0 ? '#991b1b' : '#065f46';
  }
  function renderStats() {
    const days = statsRange === 'week' ? 7 : 14;
    const bmr = profile ? profile.bmr : 0;
    const defaultExercise = profile ? profile.exercise : 0;
    // 统计区间一律不含今天：循环从 i=days 取到 i=1（即昨天起向前 days 天）
    // 每天的「差额」= 当日摄入 − 当日消耗（消耗 = BMR + 当天运动）。
    // 没记录食物的天直接跳过；当天没有运动快照就回退到当前默认运动量。
    const series = [];
    for (let i = days; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const total = historyData[dateStr] || 0;
      const dExercise = historyExercise[dateStr] != null ? historyExercise[dateStr] : defaultExercise;
      const expenditure = bmr + dExercise;
      const cheat = cheatDays.has(dateStr);
      const recorded = total > 0;
      series.push({
        date: dateStr,
        total,
        expenditure,
        cheat,
        diff: recorded ? (total - expenditure) : null,
        recorded,
      });
    }
    // 放纵日不计入统计（日均差额 / 超额天数 / 参考线缩放都跳过它）。
    const recordedSeries = series.filter(s => s.recorded && !s.cheat);
    const avgDiff = recordedSeries.length
      ? recordedSeries.reduce((a, b) => a + b.diff, 0) / recordedSeries.length
      : 0;
    const overCount = recordedSeries.filter(s => s.diff > 0).length;
    // 区间内只要有放纵日，日均差额就失去参考意义：不显示平均数，
    // 改为提示存在几天放纵日。
    const cheatCount = series.filter(s => s.cheat).length;
    const avgItem = cheatCount > 0
      ? `<div class="item"><div class="num cheat">🍰</div><div class="lab">存在 ${cheatCount} 天放纵日，不显示之前的平均数</div></div>`
      : `<div class="item"><div class="num">${formatSignedKcal(avgDiff)}</div><div class="lab">日均差额 (摄入−消耗)</div></div>`;
    $('#statsSummary').innerHTML = `
      ${avgItem}
      <div class="item"><div class="num">${overCount}</div><div class="lab">超额天数</div></div>
    `;

    const chart = $('#chart');
    chart.innerHTML = '';
    // 参考线档位：±300 / ±500 / ±1000。
    // 只在数据真的越过该档位时才画 —— 例如没有任何一天 ≥ +300，就不画 +300 线。
    // 负侧（缺口）和正侧（盈余）分别判断。
    const refLevels = [300, 500, 1000];
    const maxPosDiff = recordedSeries.reduce((a, b) => Math.max(a, b.diff), 0);
    const maxNegDiff = recordedSeries.reduce((a, b) => Math.max(a, -b.diff), 0);
    const maxAbsDiff = Math.max(maxPosDiff, maxNegDiff);
    // 防 0 除：没数据时 scale 取 1，反正也没柱子要画。
    const maxScale = Math.max(maxAbsDiff, 1) * 1.1;
    const refRows = [];
    for (const lvl of refLevels) {
      if (maxNegDiff >= lvl) refRows.push({ value: -lvl, sign: '−', cls: 'neg' });
      if (maxPosDiff >= lvl) refRows.push({ value: lvl, sign: '+', cls: 'pos' });
    }
    for (const r of refRows) {
      const line = document.createElement('div');
      line.className = `chart-ref chart-ref--${r.cls}`;
      // 零线在 50%；正值往上偏移，负值往下偏移
      const offsetPct = (Math.abs(r.value) / maxScale) * 50;
      line.style.top = r.value < 0
        ? `calc(50% + ${offsetPct}%)`
        : `calc(50% - ${offsetPct}%)`;
      const titlePrefix = r.value < 0 ? '目标缺口' : '盈余参考';
      line.title = `${titlePrefix} ${r.sign}${Math.abs(r.value)} 大卡`;
      const lab = document.createElement('span');
      lab.className = 'chart-ref-label';
      lab.textContent = `${r.sign}${Math.abs(r.value)}`;
      line.appendChild(lab);
      chart.appendChild(line);
    }
    for (const s of series) {
      const slot = document.createElement('div');
      slot.className = 'bar-slot';
      // 点柱子（含空白天）打开往日详情，可查看并编辑当天摄入/运动。
      slot.addEventListener('click', () => openDayDetail(s.date));
      const posHalf = document.createElement('div');
      posHalf.className = 'bar-half pos';
      const negHalf = document.createElement('div');
      negHalf.className = 'bar-half neg';
      if (s.cheat) {
        // 放纵日：零线上画一个特殊标记，不画差额柱子。
        const mark = document.createElement('div');
        mark.className = 'bar-cheat';
        mark.title = `${s.date}: 放纵日（不计入统计）`;
        mark.textContent = '🍰';
        slot.appendChild(mark);
      } else if (s.recorded) {
        const diff = s.diff;
        const bar = document.createElement('div');
        bar.className = 'bar ' + (diff >= 0 ? 'over' : 'under');
        const heightPct = Math.min(100, Math.abs(diff) / maxScale * 100);
        bar.style.height = Math.max(2, heightPct) + '%';
        bar.title = `${s.date}: 摄入 ${round1(s.total)} − 消耗 ${round1(s.expenditure)} = ${formatSignedKcal(diff)} 大卡`;
        if (days <= 7) {
          const val = document.createElement('span');
          val.className = 'bar-value';
          val.textContent = formatSignedKcal(diff);
          bar.appendChild(val);
        }
        if (diff >= 0) posHalf.appendChild(bar);
        else negHalf.appendChild(bar);
      }
      const lab = document.createElement('span');
      lab.className = 'bar-label';
      lab.textContent = formatDateShort(s.date);
      slot.appendChild(posHalf);
      slot.appendChild(negHalf);
      slot.appendChild(lab);
      chart.appendChild(slot);
    }

    const list = $('#historyList');
    list.innerHTML = '';
    // 有摄入记录或被标为放纵日的天都列出来（放纵日单独标注，不显示差额）。
    const withData = series.filter(s => s.recorded || s.cheat).slice().reverse();
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
        li.classList.add('clickable');
        li.addEventListener('click', () => openDayDetail(s.date));
        const dateSpan = document.createElement('span');
        dateSpan.className = 'date';
        dateSpan.textContent = formatDateLong(s.date);
        const totalSpan = document.createElement('span');
        if (s.cheat) {
          totalSpan.className = 'total cheat';
          totalSpan.textContent = '🍰 放纵日';
        } else {
          const diff = s.diff;
          let cls = 'total';
          if (diff > 0) cls += ' over';
          else if (diff < 0) cls += ' under';
          totalSpan.className = cls;
          totalSpan.textContent = `${formatSignedKcal(diff)} 大卡`;
        }
        li.appendChild(dateSpan);
        li.appendChild(totalSpan);
        list.appendChild(li);
      }
    }
  }
  function renderSettings() {
    $('#deficitInput').value = round1(deficit);
    const wcInput = $('#weightCurrentInput');
    const wtInput = $('#weightTargetInput');
    if (document.activeElement !== wcInput) {
      wcInput.value = weightCurrent != null ? round1(weightCurrent) : '';
    }
    if (document.activeElement !== wtInput) {
      wtInput.value = weightTarget != null ? round1(weightTarget) : '';
    }
    if (profile) wcInput.placeholder = String(round1(profile.weight));
    if (profile) {
      $('#settingsBmr').textContent = round1(profile.bmr);
      const exLabel = round1(profile.exercise);
      const exNow = round1(dailyExercise);
      $('#settingsExercise').textContent = exNow === exLabel
        ? exLabel
        : `${exNow}（默认 ${exLabel}）`;
      $('#settingsDeficit').textContent = round1(deficit);
      $('#settingsTarget').textContent = round1(targetIntake());
      const shownWeight = weightCurrent != null ? weightCurrent : profile.weight;
      $('#settingsBodyInfo').textContent =
        `${profile.gender} · ${profile.age} 岁 · ${profile.height} cm · ${shownWeight} kg`;
    }
  }

  // ---------- Day detail (往日查看 / 编辑) ----------
  // 统计图/历史列表只画昨天往前，所以这里 date 永远是过去的某天，
  // 不会等于 currentDate；涉及今天的分支只是防御性兜底。
  function closeDayDetail() {
    dayDetailDate = null;
    dayDetailEntries = [];
    $('#dayDetailOverlay').classList.add('hidden');
  }
  function dayExerciseInfo(date) {
    const def = profile ? profile.exercise : 0;
    if (date === currentDate) {
      return { value: dailyExercise, isOverride: dailyExercise !== def, def };
    }
    if (historyExercise[date] != null) return { value: historyExercise[date], isOverride: true, def };
    return { value: def, isOverride: false, def };
  }
  function dayDetailTotal() {
    return dayDetailEntries.reduce((s, e) => s + Number(e.calories), 0);
  }
  // 把当天合计同步进统计图的数据源。今天不在图里（用 todayEntries），跳过。
  function syncHistoryTotal(date) {
    if (date === currentDate) return;
    const sum = dayDetailTotal();
    if (sum > 0) historyData[date] = sum; else delete historyData[date];
  }
  function dayExHintText(date) {
    const ex = dayExerciseInfo(date);
    return ex.isOverride
      ? `默认 ${round1(ex.def)} 大卡 · 清空输入可恢复默认`
      : `当前为默认值 ${round1(ex.def)} 大卡`;
  }
  async function openDayDetail(date) {
    dayDetailDate = date;
    const overlay = $('#dayDetailOverlay');
    $('#dayDetailDate').textContent = formatDateLong(date);
    $('#dayDetailEntries').innerHTML = '<li class="empty">加载中…</li>';
    $('#dayDetailCheat').checked = cheatDays.has(date);
    const ex = dayExerciseInfo(date);
    $('#dayDetailExercise').value = round1(ex.value);
    $('#dayDetailExHint').textContent = dayExHintText(date);
    $('#dayDetailSummary').innerHTML = '';
    overlay.classList.remove('hidden');
    try {
      dayDetailEntries = await fetchEntriesForDate(date);
    } catch (e) {
      console.warn('[openDayDetail] fetch failed:', e);
      dayDetailEntries = [];
    }
    if (dayDetailDate !== date) return; // 期间被关掉/换了天
    renderDayDetailEntries();
    updateDayDetailSummary();
  }
  function updateDayDetailSummary() {
    if (!dayDetailDate) return;
    const total = dayDetailTotal();
    const ex = dayExerciseInfo(dayDetailDate);
    const expenditure = (profile ? profile.bmr : 0) + ex.value;
    const diff = total - expenditure;
    const cheat = $('#dayDetailCheat').checked;
    const diffHtml = cheat
      ? `<div class="item"><div class="num cheat">🍰</div><div class="lab">放纵日·不计入</div></div>`
      : `<div class="item"><div class="num">${formatSignedKcal(diff)}</div><div class="lab">差额</div></div>`;
    $('#dayDetailSummary').innerHTML = `
      <div class="item"><div class="num">${round1(total)}</div><div class="lab">摄入</div></div>
      <div class="item"><div class="num">${round1(expenditure)}</div><div class="lab">消耗</div></div>
      ${diffHtml}
    `;
  }
  function renderDayDetailEntries() {
    const list = $('#dayDetailEntries');
    list.innerHTML = '';
    if (dayDetailEntries.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '当天没有摄入记录';
      list.appendChild(li);
      return;
    }
    for (const e of dayDetailEntries) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      left.className = 'dd-entry-left';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = e.name;
      left.appendChild(name);
      if (e.detail) {
        const detail = document.createElement('div');
        detail.className = 'detail';
        detail.textContent = e.detail;
        left.appendChild(detail);
      }
      const right = document.createElement('div');
      right.className = 'dd-entry-right';
      const kcalInput = document.createElement('input');
      kcalInput.type = 'number';
      kcalInput.inputMode = 'decimal';
      kcalInput.className = 'dd-kcal';
      kcalInput.value = round1(e.calories);
      kcalInput.addEventListener('change', () => handleEditEntryKcal(e, kcalInput));
      const unit = document.createElement('span');
      unit.className = 'dd-unit';
      unit.textContent = '大卡';
      const del = document.createElement('button');
      del.className = 'delete';
      del.textContent = '×';
      del.title = '删除';
      del.addEventListener('click', () => handleDeleteDayEntry(e));
      right.appendChild(kcalInput);
      right.appendChild(unit);
      right.appendChild(del);
      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    }
  }
  function refreshAfterDayEdit(date) {
    syncHistoryTotal(date);
    updateDayDetailSummary();
    renderStats();
    if (date === currentDate) renderToday();
  }
  async function handleEditEntryKcal(entry, input) {
    const v = parseFloat(input.value);
    if (!isFinite(v) || v < 0) { input.value = round1(entry.calories); return; }
    const newVal = round1(v);
    if (newVal === round1(entry.calories)) return;
    const updated = await updateEntryCalories(entry.id, newVal);
    if (!updated) { input.value = round1(entry.calories); return; }
    entry.calories = updated.calories;
    input.value = round1(updated.calories);
    refreshAfterDayEdit(dayDetailDate);
  }
  async function handleDeleteDayEntry(entry) {
    const ok = await deleteEntryById(entry.id);
    if (!ok) return;
    dayDetailEntries = dayDetailEntries.filter(e => e.id !== entry.id);
    renderDayDetailEntries();
    refreshAfterDayEdit(dayDetailDate);
  }
  async function handleAddDayEntry() {
    if (!dayDetailDate) return;
    const name = $('#dayDetailAddName').value.trim() || '未命名';
    const v = parseFloat($('#dayDetailAddKcal').value);
    if (!isFinite(v) || v <= 0) { alert('请输入有效大卡数'); return; }
    const btn = $('#dayDetailAddBtn');
    btn.disabled = true; const old = btn.textContent; btn.textContent = '补录中…';
    const entry = await insertEntryForDate(dayDetailDate, {
      name, calories: round1(v), mode: 'direct', detail: '手动补录',
    });
    btn.disabled = false; btn.textContent = old;
    if (!entry) return;
    dayDetailEntries.unshift(entry);
    $('#dayDetailAddName').value = '';
    $('#dayDetailAddKcal').value = '';
    renderDayDetailEntries();
    refreshAfterDayEdit(dayDetailDate);
  }
  async function handleDayDetailExercise() {
    const input = $('#dayDetailExercise');
    const date = dayDetailDate;
    const def = profile ? profile.exercise : 0;
    if (input.value === '' || !isFinite(parseFloat(input.value))) {
      delete historyExercise[date];
      if (date === currentDate) dailyExercise = def;
      await clearDailyExerciseInDb(date);
    } else {
      let v = round1(parseFloat(input.value));
      if (v < 0) v = 0;
      if (v > MAX_PLAUSIBLE_EXERCISE) v = MAX_PLAUSIBLE_EXERCISE;
      historyExercise[date] = v;
      if (date === currentDate) dailyExercise = v;
      await saveDailyExerciseToDb(date, v);
    }
    const ex = dayExerciseInfo(date);
    input.value = round1(ex.value);
    $('#dayDetailExHint').textContent = dayExHintText(date);
    updateDayDetailSummary();
    renderStats();
    if (date === currentDate) renderToday();
  }
  async function handleDayDetailCheat() {
    const date = dayDetailDate;
    const on = $('#dayDetailCheat').checked;
    if (on) cheatDays.add(date); else cheatDays.delete(date);
    await setCheatDayInDb(date, on);
    updateDayDetailSummary();
    renderStats();
    if (date === currentDate) updateCheatButton();
  }
  function setupDayDetailEvents() {
    $('#dayDetailClose').addEventListener('click', closeDayDetail);
    $('#dayDetailOverlay').addEventListener('click', (e) => {
      if (e.target === $('#dayDetailOverlay')) closeDayDetail();
    });
    $('#dayDetailCheat').addEventListener('change', handleDayDetailCheat);
    $('#dayDetailExercise').addEventListener('change', handleDayDetailExercise);
    $('#dayDetailAddBtn').addEventListener('click', handleAddDayEntry);
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
    const btn = $('#addQuantityBtn');
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
    const payload = { name, calories: round1(kcal), mode: 'quantity', detail };
    btn.disabled = true; const old = btn.textContent; btn.textContent = '添加中…';
    const entry = await addEntry(payload);
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
  async function handleAddFromFridge() {
    const btn = $('#addFridgeEntryBtn');
    const item = getSelectedFridgeItem();
    if (!item) { alert('请先选择冰箱里的食物'); return; }
    const amount = parseFloat($('#q_fridge_amount').value);
    if (!isFinite(amount) || amount <= 0) { alert('请输入有效摄入量'); return; }
    let kcal, detail;
    if (item.basis === 'per_serving') {
      kcal = amount * Number(item.kcal);
      detail = `${round1(amount)} 份 × ${round1(item.kcal)} 大卡/份 · 来自冰箱`;
    } else {
      const unit = $('#q_fridge_unit').value;
      kcal = (amount / 100) * Number(item.kcal);
      detail = `${round1(amount)}${unit} × ${round1(item.kcal)} 大卡/100${unit} · 来自冰箱`;
    }
    const payload = { name: item.name, calories: round1(kcal), mode: 'quantity', detail };
    // 开启了容量追踪的条目：把本次的 ml/g 量和条目 id 记在 entry 上，
    // 之后删除这条今日记录时能把进度退回去。
    const vol = item.basis === 'per_100g' ? volumeInfo(item) : null;
    if (vol) {
      payload.fridge_item_id = item.id;
      payload.amount_ml = round1(amount);
    }
    btn.disabled = true; const old = btn.textContent; btn.textContent = '添加中…';
    const entry = await addEntry(payload);
    btn.disabled = false; btn.textContent = old;
    if (entry) {
      let volNote = '';
      if (vol) {
        // 累加进度；达到总量取模归零（超出的部分算进下一瓶）。
        let newUsed = round1(vol.used + round1(amount));
        const finished = newUsed >= vol.total;
        if (finished) newUsed = round1(newUsed % vol.total);
        const updated = await updateFridgeItem(item.id, { volume_used_ml: newUsed });
        if (updated) {
          renderFridge();
          const nv = volumeInfo(updated);
          volNote = finished
            ? `🥛 这瓶喝完啦，进度已归零${nv && nv.used > 0 ? `（新一瓶 ${volumeText(nv)}）` : ''}`
            : `进度 ${volumeText(nv)}`;
        }
      }
      $('#q_fridge_amount').value = '';
      updateFridgePreview();
      $('#q_fridge_amount').focus();
      renderToday();
      showLastEntryToast(entry, volNote);
    }
  }
  function getSelectedFridgeItem() {
    const id = $('#q_fridge_item').value;
    if (!id) return null;
    return fridgeItems.find(it => it.id === id) || null;
  }
  function updateFridgePickerInfo() {
    const info = $('#q_fridge_info');
    const unitSel = $('#q_fridge_unit');
    if (!info || !unitSel) return;
    const item = getSelectedFridgeItem();
    if (!item) {
      info.textContent = '先选一项冰箱里的食物';
      info.classList.remove('has-pick');
      // 默认 g/ml 选项；没选时单位选什么都没影响。
      if (unitSel.options.length === 0 || unitSel.options[0].value !== 'g') {
        unitSel.innerHTML = '<option value="g">克 (g)</option><option value="ml">毫升 (ml)</option>';
      }
      unitSel.disabled = false;
      return;
    }
    let text = `${item.name}：${fridgeKcalLabel(item)}`;
    if (item.expiry_date) text += ` · 过期 ${item.expiry_date}`;
    const vol = volumeInfo(item);
    if (vol) text += ` · ${volumeText(vol)}`;
    info.textContent = text;
    info.classList.add('has-pick');
    // 计量是「每份」时摄入量单位只能是"份"；是「100g/ml」时让用户在 g/ml 里选。
    if (item.basis === 'per_serving') {
      unitSel.innerHTML = '<option value="份">份</option>';
      unitSel.disabled = true;
    } else {
      const prev = unitSel.value;
      unitSel.innerHTML = '<option value="g">克 (g)</option><option value="ml">毫升 (ml)</option>';
      unitSel.disabled = false;
      if (prev === 'g' || prev === 'ml') unitSel.value = prev;
    }
  }
  function resetFridgeForm() {
    editingFridgeId = null;
    $('#fridgeFormTitle').textContent = '添加到冰箱';
    $('#addFridgeBtn').textContent = '添加';
    $('#cancelFridgeEditBtn').classList.add('hidden');
    $('#f_name').value = '';
    $('#f_kcal').value = '';
    $('#f_unit').value = 'kj';
    $('#f_basis').value = 'per_serving';
    $('#f_volume').value = '';
    $('#f_expiry').value = '';
    updateVolumeFieldVisibility();
  }
  function enterFridgeEdit(item) {
    editingFridgeId = item.id;
    $('#fridgeFormTitle').textContent = '编辑食物';
    $('#addFridgeBtn').textContent = '保存修改';
    $('#cancelFridgeEditBtn').classList.remove('hidden');
    $('#f_name').value = item.name;
    // 入库一律是 kcal，所以编辑回填时单位也固定 kcal——避免回填 kJ 时再换一次算。
    $('#f_kcal').value = round1(item.kcal);
    $('#f_unit').value = 'kcal';
    $('#f_basis').value = item.basis;
    const vol = volumeInfo(item);
    $('#f_volume').value = vol ? round1(vol.total) : '';
    updateVolumeFieldVisibility();
    $('#f_expiry').value = item.expiry_date || '';
    $('#f_name').focus();
  }
  async function handleAddOrSaveFridge() {
    const name = $('#f_name').value.trim();
    const rawKcal = parseFloat($('#f_kcal').value);
    const unit = $('#f_unit').value;
    const basis = $('#f_basis').value;
    const expiry = $('#f_expiry').value || null;
    if (!name) { alert('请输入食物名称'); return; }
    if (!isFinite(rawKcal) || rawKcal <= 0) { alert('请输入有效的热量值'); return; }
    const kcal = round1(unit === 'kj' ? rawKcal * KJ_TO_KCAL : rawKcal);
    // 容量追踪：只在 per_100g 计量下生效；留空/无效 = 不追踪，顺手把已喝量归零，
    // 免得之后重新开启时冒出上一瓶的旧进度。
    const rawVol = parseFloat($('#f_volume').value);
    const volumeTotal = (basis === 'per_100g' && isFinite(rawVol) && rawVol > 0) ? round1(rawVol) : null;
    const btn = $('#addFridgeBtn');
    btn.disabled = true; const old = btn.textContent;
    btn.textContent = editingFridgeId ? '保存中…' : '添加中…';
    let ok = null;
    if (editingFridgeId) {
      const patch = { name, kcal, basis, expiry_date: expiry, volume_total_ml: volumeTotal };
      if (volumeTotal == null) patch.volume_used_ml = 0;
      ok = await updateFridgeItem(editingFridgeId, patch);
    } else {
      ok = await addFridgeItem({ name, kcal, basis, expiry_date: expiry, volume_total_ml: volumeTotal });
    }
    btn.disabled = false; btn.textContent = old;
    if (ok) {
      resetFridgeForm();
      renderFridge();
    }
  }
  async function handleDeleteFridge(item) {
    if (!confirm(`确定从冰箱里删除「${item.name}」？`)) return;
    await removeFridgeItem(item.id);
    // 删的恰好是正在编辑那项，退出编辑态。
    if (editingFridgeId === item.id) resetFridgeForm();
    renderFridge();
  }
  // 只清掉上一次估算结果（结果区/推理/添加按钮），不动图片和报错。
  function invalidateAiEstimate() {
    aiEstimate = null;
    $('#ai_result').classList.add('hidden');
    $('#ai_items').innerHTML = '';
    $('#ai_total').classList.add('hidden');
    $('#ai_reasoning').classList.add('hidden');
    $('#ai_reasoning_text').textContent = '';
    $('#addAiBtn').classList.add('hidden');
  }
  function resetAiPanel() {
    invalidateAiEstimate();
    $('#ai_error').classList.add('hidden');
    $('#ai_error').textContent = '';
  }
  // 估算结果旁边展示「用了哪个模型 + 它是怎么算的」。
  function renderAiReasoning(model, text) {
    const box = $('#ai_reasoning');
    if (!text) { box.classList.add('hidden'); return; }
    $('#ai_model').textContent = model || '未知模型';
    $('#ai_reasoning_text').textContent = text;
    box.classList.remove('hidden');
  }
  // ---------- AI 图片输入 ----------
  const MAX_AI_IMAGES = 4;
  function renderAiThumbs() {
    const wrap = $('#ai_thumbs');
    wrap.innerHTML = '';
    aiImages.forEach((img, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'ai-thumb';
      const im = document.createElement('img');
      im.src = img.dataUrl;
      im.alt = '食物图片';
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ai-thumb-remove';
      rm.textContent = '×';
      rm.setAttribute('aria-label', '移除图片');
      rm.addEventListener('click', () => {
        aiImages.splice(idx, 1);
        renderAiThumbs();
        invalidateAiEstimate();
      });
      thumb.appendChild(im);
      thumb.appendChild(rm);
      wrap.appendChild(thumb);
    });
  }
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('读取失败'));
      reader.readAsDataURL(file);
    });
  }
  async function addAiImageFiles(files) {
    const imgs = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    let hitLimit = false;
    for (const f of imgs) {
      if (aiImages.length >= MAX_AI_IMAGES) { hitLimit = true; break; }
      try {
        const dataUrl = await fileToDataUrl(f);
        aiImages.push({ dataUrl });
      } catch (e) {
        showAiError('图片读取失败：' + (e.message || e));
      }
    }
    renderAiThumbs();
    invalidateAiEstimate();
    if (hitLimit) showAiError(`最多添加 ${MAX_AI_IMAGES} 张图片`);
  }
  async function handleAiPasteImageBtn() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      showAiError('当前浏览器不支持读取剪贴板，请直接用 Ctrl/⌘+V 粘贴');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const files = [];
      for (const it of items) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          files.push(new File([blob], 'clipboard', { type }));
        }
      }
      if (files.length === 0) { showAiError('剪贴板里没有图片'); return; }
      addAiImageFiles(files);
    } catch (e) {
      showAiError('读取剪贴板失败：' + (e.message || e) + '（可改用 Ctrl/⌘+V）');
    }
  }
  function handleAiPaste(e) {
    if (inputMode !== 'ai') return;
    const clip = e.clipboardData;
    if (!clip || !clip.items) return;
    const files = [];
    for (const it of clip.items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); addAiImageFiles(files); }
  }
  function renderAiItems(items) {
    const ul = $('#ai_items');
    ul.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = it.name;
      const kcal = document.createElement('span');
      kcal.className = 'kcal';
      kcal.textContent = round1(it.calories);
      li.appendChild(name);
      li.appendChild(kcal);
      ul.appendChild(li);
    }
    // 只有一项时合计行是冗余的，藏起来；两项及以上才显示。
    const total = items.reduce((s, it) => s + Number(it.calories), 0);
    $('#ai_kcal').textContent = round1(total);
    $('#ai_total').classList.toggle('hidden', items.length < 2);
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
    if (!description && aiImages.length === 0) { showAiError('请输入食物描述或添加图片'); return; }
    const btn = $('#estimateBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '估算中…';
    $('#ai_error').classList.add('hidden');
    try {
      const { data, error } = await sb.functions.invoke('estimate-calories', {
        body: { description, images: aiImages.map(i => i.dataUrl) },
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
      // 新格式 {items: [{name, calories}, ...]}；如果 edge function 还没更新，
      // 旧格式 {name, calories} 也能升级成单元素数组继续走。
      let items = null;
      if (data && Array.isArray(data.items)) {
        items = data.items
          .filter(it => it && typeof it.name === 'string' && typeof it.calories === 'number' && it.calories >= 0)
          .map(it => ({ name: it.name, calories: round1(it.calories) }));
      } else if (data && typeof data.calories === 'number') {
        items = [{ name: data.name || description, calories: round1(data.calories) }];
      }
      if (!items || items.length === 0) {
        showAiError('AI 返回格式异常: ' + JSON.stringify(data).slice(0, 200));
        return;
      }
      aiEstimate = { items };
      renderAiItems(items);
      renderAiReasoning(data && data.model, data && (data.reasoning || data.raw));
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
    if (!aiEstimate || !aiEstimate.items || aiEstimate.items.length === 0) return;
    const btn = $('#addAiBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '添加中…';
    const payloads = aiEstimate.items.map(it => ({
      name: it.name,
      calories: it.calories,
      mode: 'ai',
      detail: 'AI 估算',
    }));
    const entries = await addEntries(payloads);
    btn.disabled = false;
    btn.textContent = old;
    if (entries && entries.length > 0) {
      $('#ai_description').value = '';
      aiImages = [];
      renderAiThumbs();
      resetAiPanel();
      $('#ai_description').focus();
      renderToday();
      showLastEntriesToast(entries);
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
  function updateFridgePreview() {
    const item = getSelectedFridgeItem();
    const amount = parseFloat($('#q_fridge_amount').value);
    if (item && isFinite(amount) && amount > 0) {
      const k = Number(item.kcal);
      const kcal = item.basis === 'per_serving' ? amount * k : (amount / 100) * k;
      $('#fridge_preview').textContent = `≈ ${round1(kcal)} 大卡`;
    } else {
      $('#fridge_preview').textContent = '≈ 0 大卡';
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
    $('#cheatToggleBtn').addEventListener('click', handleToggleCheat);
    setupDayDetailEvents();

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
        $('#mode-fridge').classList.toggle('hidden', inputMode !== 'fridge');
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
    $('#addFridgeEntryBtn').addEventListener('click', handleAddFromFridge);
    ['q_amount', 'q_per100', 'q_unit', 'q_energy_unit'].forEach(id => {
      $('#' + id).addEventListener('input', updateQuantityPreview);
      $('#' + id).addEventListener('change', updateQuantityPreview);
    });
    $('#q_fridge_item').addEventListener('change', () => {
      updateFridgePickerInfo();
      updateFridgePreview();
    });
    $('#q_fridge_amount').addEventListener('input', updateFridgePreview);
    $('#q_fridge_unit').addEventListener('change', updateFridgePreview);

    $('#addFridgeBtn').addEventListener('click', handleAddOrSaveFridge);
    $('#cancelFridgeEditBtn').addEventListener('click', () => resetFridgeForm());
    $('#f_basis').addEventListener('change', updateVolumeFieldVisibility);
    $('#estimateBtn').addEventListener('click', handleEstimateAi);
    $('#addAiBtn').addEventListener('click', handleAddAi);
    $('#ai_description').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleEstimateAi(); }
    });
    $('#ai_description').addEventListener('input', () => {
      // 描述变了就清掉旧估算，避免误添加
      if (aiEstimate) resetAiPanel();
    });
    $('#aiPickImageBtn').addEventListener('click', () => $('#ai_image_file').click());
    $('#ai_image_file').addEventListener('change', (e) => {
      addAiImageFiles(e.target.files);
      e.target.value = '';
    });
    $('#aiPasteImageBtn').addEventListener('click', handleAiPasteImageBtn);
    // 在 AI 模式下，Ctrl/⌘+V 直接把剪贴板里的图片塞进来
    document.addEventListener('paste', handleAiPaste);
    const bdEx = $('#bdExerciseInput');
    bdEx.addEventListener('input', () => {
      const v = parseFloat(bdEx.value);
      if (!isFinite(v) || v < 0) return;
      if (v > MAX_PLAUSIBLE_EXERCISE) return;
      dailyExercise = round1(v);
      // 防抖写库：每次按键改 in-memory + 进度条；攒够 EXERCISE_SAVE_DEBOUNCE_MS
      // 没新输入再 upsert，避免一串数字打出 5 次 PATCH。
      if (exerciseSaveTimer) clearTimeout(exerciseSaveTimer);
      // 记下编辑时的日期+值，flushPendingExerciseSave 用这份快照写库——
      // 这样切回前台/跨午夜触发 loadAll 时能先把它落库再读回，不会被默认值冲掉。
      pendingExerciseSave = {
        date: currentDate,
        value: dailyExercise,
        userId: session && session.user ? session.user.id : null,
      };
      exerciseSaveTimer = setTimeout(flushPendingExerciseSave, EXERCISE_SAVE_DEBOUNCE_MS);
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
        // 一并丢掉待写快照，否则它之后会把刚删的值又写回去。
        if (exerciseSaveTimer) { clearTimeout(exerciseSaveTimer); exerciseSaveTimer = null; }
        pendingExerciseSave = null;
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
    $('#saveWeightBtn').addEventListener('click', async () => {
      const cur = plausibleWeight($('#weightCurrentInput').value);
      const tgt = plausibleWeight($('#weightTargetInput').value);
      if (cur == null) { alert('请输入有效的当前体重（kg）'); return; }
      if (tgt == null) { alert('请输入有效的目标体重（kg）'); return; }
      const btn = $('#saveWeightBtn');
      btn.disabled = true; const old = btn.textContent; btn.textContent = '保存中…';
      const ok = await saveWeights(round1(cur), round1(tgt));
      btn.disabled = false; btn.textContent = old;
      if (ok) { renderToday(); renderSettings(); alert('已保存'); }
    });
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden || !session) return;
      try {
        await loadAll();
        renderAll();
      } catch (e) {
        // 切回前台 loadAll 超时多半是 token 在后台被 rotate 出问题，
        // 或锁被节流挂住——hardReset reload 替用户做手动刷新那一步，
        // 重建 supabase 客户端丢掉所有卡死的内部状态。reload 用过一次
        // 就只能落回 in-page forceReauth。
        if (isAuthError(e) || e.__timeout) {
          if (hardReset('visibilitychange/loadAll')) return;
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
      // 超时基本等于 token 坏了 / 锁卡死。光 forceReauth 清不掉 supabase 客户端
      // 内部那些卡住的 promise/lock，下一次 signInWithPassword 也会被拖垮——
      // 用户只能手动刷新。这里 hardReset 先 reload 一次替他做。
      if (isAuthError(e) || e.__timeout) {
        if (hardReset('afterAuth/loadAll')) return;
        await forceReauth('会话异常已重置，请重新登录');
        return;
      }
      // 非 auth 错误也必须把 init 遮罩收掉，否则 alert 关掉后用户
      // 永远停在「正在恢复会话」转圈圈上。
      hideInitOverlay();
      alert('加载数据失败：' + (e.message || e));
    }
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', async () => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      // 早期 return 走 showLogin 而不是只设 loginError 文案——
      // 否则 init 遮罩盖着登录页，用户根本看不到错误。
      showLogin('请先在 app.js 顶部配置 SUPABASE_URL 和 SUPABASE_ANON_KEY');
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      showLogin('Supabase SDK 加载失败，请检查网络');
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // 默认 lock 跨标签共享 navigator.locks，另一个标签崩/被节流时会
        // 把锁挂死，新登录就会停在 200 之后写不进 storage，UI 不跳转。
        // 这里改成 ifAvailable 单次尝试 + 立刻 last-write-wins 兜底，
        // 避免每个查询都白等 3 秒锁。详见 authLock 函数顶部注释。
        lock: authLock,
      }
    });
    setupEvents();

    // 登录覆盖层 HTML 默认就是可见的——init 期间用户看到登录页会忍不住点
    // 登录，跟后台 session 恢复 / refresh 抢同一把 auth lock，把 supabase
    // 客户端内部状态搞死，最终连环出现「登录中→会话异常→登录超时」三连。
    // init 期间先禁用按钮，等 getSession 决定下一步（恢复成功隐藏遮罩 /
    // 失败 hardReset 走 reload / 无 session 走 showLogin 放回可点）。
    const loginBtn = $('#loginBtn');
    loginBtn.disabled = true;
    loginBtn.textContent = '正在恢复会话…';

    // 终极兜底：12 秒内启动流程没走到"登录页可见"或"今日页可见"任一稳定态，
    // 就 hardReset（清 sb-* + reload 一次）。任何 await 卡死、forceReauth
    // 自己也卡的极端组合都能救回来。
    initWatchdog = setTimeout(() => {
      if (hardReset('init/watchdog 12s')) return;
      // 已经 reload 过一次还是死，让用户看到登录页手动重试。
      // showLogin 会一并藏掉 initOverlay 并把按钮放回可点状态。
      try { showLogin('启动反复失败，请检查网络或浏览器拦截'); } catch (_) {}
    }, 12000);
    function clearInitWatchdog() {
      if (initWatchdog) { clearTimeout(initWatchdog); initWatchdog = null; }
      sessionStorage.removeItem('cc_emergency_reset');
    }

    // 从 localStorage 恢复会话时 GoTrue 也会发一次 SIGNED_IN，而且是在 auth
    // 客户端内部初始化的通知链里同步 await 回调的。如果这时直接 await
    // afterAuth()，里面每个查询取 access token 都要 await getSession()，
    // 而 getSession() 又在等初始化完成——互相等死。表现就是：每次刷新
    // init/getSession 6 秒超时 → hardReset 把好端端的 token 清掉 → 重输密码。
    // （supabase 官方文档也警告不要在 onAuthStateChange 回调里调用其他
    // supabase 方法。）所以 init 阶段的会话恢复完全交给下面显式的
    // getSession 分支处理，这里跳过；initSettled 置真之后（登录页可见 /
    // 首屏加载启动）才响应真正由用户点登录触发的 SIGNED_IN。
    let initSettled = false;
    sb.auth.onAuthStateChange(async (event, sess) => {
      if (event === 'SIGNED_IN' && sess) {
        if (!initSettled) return;
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
        weightCurrent = null;
        weightTarget = null;
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
      // getSession 卡死/抛错 = 持久化 session 坏了。光 forceReauth 不够，
      // supabase 客户端内部那个挂住的 refresh promise 还在，下一次
      // signInWithPassword 也会被拖垮——hardReset reload 让客户端重建。
      // reload 过一次还死才落回 in-page 重登。
      if (hardReset('init/getSession')) return;
      initSettled = true; // 放行登录页上用户手动登录触发的 SIGNED_IN
      await forceReauth(e.__timeout ? '会话异常已重置，请重新登录' : '会话已重置，请重新登录');
      clearInitWatchdog();
      return;
    }
    initSettled = true;
    if (existing) {
      session = existing;
      await afterAuth();
    } else {
      showLogin();
    }
    clearInitWatchdog();
  });
})();
