// Supabase Edge Function: estimate-calories
// Proxies a calorie-estimation call to Claude, keeping the Anthropic API key on the server.
//
// Deploy:
//   1) supabase functions new estimate-calories   (or place this file at supabase/functions/estimate-calories/index.ts)
//   2) supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   3) supabase functions deploy estimate-calories
//
// Front-end calls it via:
//   sb.functions.invoke('estimate-calories', { body: { description: '一碗米饭' } })

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const MODEL = 'claude-opus-4-8';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `你是一个营养估算助手。用户用中文描述吃了什么，可能是单项也可能是多项食物（例如「一碗米饭」、「两个鸡腿，50g 巴沙鱼，一些蘑菇」、「一份红烧肉配米饭」），也可能附带食物照片。你需要把吃的东西按每一项独立食物拆开，分别估算每一项的大卡数。如果用户提供了图片，先识别图片里的食物，再结合用户的文字一起估算。

请按以下两步输出：
第一步：用中文写一段简要说明（推理过程），逐项讲清楚你是怎么估的——识别到的每一项食物、采用的份量假设、用到的 kcal/100g 或单位热量、以及最终大卡的算法。这段说明里不要出现大括号 { 或 }。
第二步：另起一行，只输出一个 JSON 对象，这一行之后不要再有任何文字。

JSON 严格按以下规则：
- 格式：{"items": [{"name": "<含份量的食物名>", "calories": <整数>}, ...]}
- 即使只有一项食物，items 也必须是数组（长度为 1）
- 吃的每一项独立食物各占数组中的一项
- 每项的 name 要保留份量信息并使用自然中文（例如「两个鸡腿」、「50g 巴沙鱼」、「一些蘑菇」、「一碗米饭」），不要拆掉数量
- 每项的 calories 是该项按用户描述的份量估算出的整数大卡数（不要写区间、不要带单位、不要带其他字段）
- 严格按用户输入估算：用户写了什么就是什么，不要自行添加用户没有提到的食材、配菜、额外用油或调味，也不要自行删减用户写到的部分
- 食物的默认形态按"该食材最常见的食用形态"判断，不要主动往清淡或往油腻偏：
  - 鸡腿默认带皮带骨；写明「去皮」才按去皮算，写明「鸡腿肉」按去皮去骨纯肉算
  - 米饭默认白米饭（熟）；写明「炒饭」才按炒饭算
  - 鱼/虾/肉类没写做法时，按生重计算原料热量，不额外加油
  - 蔬菜没写做法时，按生重/水煮计算，不额外加油
- 用户没写份量时，按该食物的标准单人份估算（例：「一碗米饭」≈ 150g 熟饭；「一个鸡腿」≈ 生重 120g 带皮带骨；「一份」≈ 常见餐厅单人份）
- 用户明确写了克数/个数/碗数时，必须严格按该份量线性估算，不要凑整到偏高或偏低的数字
- 数字写法解析约定：
  - 「1kg」「1000g」=1000g；「1kg半」「一公斤半」=1500g；「半kg」「500g」=500g
  - 「半鸡」=半只鸡（含骨），去皮可食部约占总重 75%，纯鸡肉热量 ≈ 110 kcal/100g
  - 「整鸡」=一整只鸡（含骨），骨头约占总重 25%
- 如果输入不是食物，返回 {"error": "not_food"}

参考示例（务必遵守同样的换算逻辑，但 calories 仍按用户实际输入重新估算，不要照抄）：
- 输入「1kg 去皮半鸡 空气炸锅 不加油」→ {"items":[{"name":"1kg 去皮半鸡（空气炸锅 不加油）","calories":1150}]}（1kg 含骨，可食部 ~750g 纯肉 × 110 kcal/100g ≈ 825，考虑深色肉占比按 ~150 kcal/100g 上调到 ~1150）
- 输入「200g 水煮鸡胸肉」→ {"items":[{"name":"200g 水煮鸡胸肉","calories":220}]}
- 输入「一碗米饭」→ {"items":[{"name":"一碗米饭","calories":200}]}
- 输入「一个鸡腿」→ {"items":[{"name":"一个鸡腿","calories":210}]}（带皮带骨生重 ~120g）`;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: '未登录' }, 401);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return json({ error: '认证失败' }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length > 200) {
      return json({ error: '描述太长（最多 200 字）' }, 400);
    }

    // 图片：前端传 data URL 字符串（data:image/jpeg;base64,...）或 {media_type, data}。
    // 最多 4 张，单张 base64 体积上限 ~7M 字符（≈ 5MB 原图），超出的丢弃。
    const images = buildImageBlocks(Array.isArray(body.images) ? body.images : []);
    if (!description && images.length === 0) {
      return json({ error: '请输入食物描述或添加图片' }, 400);
    }

    // 用户文字 + 图片一起发给模型；没文字时给一句兜底指令。
    const userContent: unknown[] = [...images];
    userContent.push({ type: 'text', text: description || '请识别图片中的食物并估算热量。' });

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        // 现在要求模型先写推理再给 JSON，篇幅比纯 JSON 长不少；
        // 1500 给推理 + ~15 项 JSON 留足余量。
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error('Anthropic API error:', claudeResponse.status, errText);
      return json({
        error: 'AI 服务异常',
        detail: `Anthropic ${claudeResponse.status}: ${errText.slice(0, 500)}`,
      }, 502);
    }

    const claudeData = await claudeResponse.json();
    const text = claudeData?.content?.[0]?.text ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('No JSON in response:', text);
      return json({
        error: 'AI 返回格式异常',
        detail: `raw: ${text.slice(0, 500)}`,
      }, 502);
    }

    type RawItem = { name?: unknown; calories?: unknown };
    let parsed: { items?: RawItem[]; name?: unknown; calories?: unknown; error?: string };
    try {
      parsed = JSON.parse(match[0]);
    } catch (e) {
      return json({
        error: 'AI 返回解析失败',
        detail: `${(e as Error).message} | raw: ${match[0].slice(0, 300)}`,
      }, 502);
    }

    if (parsed.error === 'not_food') {
      return json({ error: '看起来不是食物，换个描述试试' }, 400);
    }

    // 优先吃新格式 {items: [...]}；如果哪天 prompt 漂移回旧的 {name, calories}
    // 单项格式，也能兜住，整成一项的数组继续往下走。
    let rawItems: RawItem[] = [];
    if (Array.isArray(parsed.items)) {
      rawItems = parsed.items;
    } else if (parsed.calories != null) {
      rawItems = [{ name: parsed.name, calories: parsed.calories }];
    }

    // 单项最长 100 字 + 大卡 [0, 10000]；多项一次最多 20 项（输入有 200 字上限，
    // 正常没人会写到 20+ 项；超出基本是 AI 幻觉，截断保护下游 UI 和数据库）。
    const items: { name: string; calories: number }[] = [];
    for (const it of rawItems.slice(0, 20)) {
      const cal = Math.round(Number(it?.calories));
      if (!Number.isFinite(cal) || cal < 0 || cal > 10000) continue;
      const name = String(it?.name || description).slice(0, 100).trim();
      if (!name) continue;
      items.push({ name, calories: cal });
    }
    if (items.length === 0) {
      return json({
        error: 'AI 返回数值异常',
        detail: `parsed: ${JSON.stringify(parsed).slice(0, 300)}`,
      }, 502);
    }

    // 把 JSON 那段从回答里抠掉，剩下的就是模型的推理说明；前端展示「用了哪个模型 + 它怎么算的」。
    const reasoning = text.replace(match[0], '').trim();
    return json({ items, model: MODEL, reasoning, raw: text });
  } catch (e) {
    console.error('Unhandled error:', e);
    const err = e as Error;
    return json({
      error: '函数内部错误',
      detail: `${err.name || 'Error'}: ${err.message || String(e)}${err.stack ? '\n' + err.stack.slice(0, 500) : ''}`,
    }, 500);
  }
});

// Anthropic 支持的图片类型；其它一律丢弃。
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 7_000_000; // base64 字符上限，≈ 5MB 原图

function buildImageBlocks(raw: unknown[]): unknown[] {
  const blocks: unknown[] = [];
  for (const item of raw) {
    if (blocks.length >= MAX_IMAGES) break;
    let mediaType = '';
    let data = '';
    if (typeof item === 'string') {
      const m = item.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) { mediaType = m[1].toLowerCase(); data = m[2]; }
    } else if (item && typeof item === 'object') {
      const obj = item as { media_type?: unknown; data?: unknown };
      if (typeof obj.data === 'string') {
        mediaType = String(obj.media_type || 'image/jpeg').toLowerCase();
        data = obj.data;
      }
    }
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) continue;
    if (!data || data.length > MAX_IMAGE_CHARS) continue;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }
  return blocks;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
