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
const MODEL = 'claude-opus-4-7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `你是中餐为主的营养估算助手。用户用中文描述吃了什么，可能是单项也可能是多项食物（例如「一碗米饭」、「两个鸡腿，50g 巴沙鱼，一些蘑菇」、「一份红烧肉配米饭」），你需要把描述按每一项独立食物拆开，分别估算每一项的大卡数。

严格按以下规则返回：
- 只输出一个 JSON 对象，不要任何解释或额外文本
- 格式：{"items": [{"name": "<含份量的食物名>", "calories": <整数>}, ...]}
- 即使只有一项食物，items 也必须是数组（长度为 1）
- 用户描述里的每一项独立食物各占数组中的一项
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
    if (!description) {
      return json({ error: '请输入食物描述' }, 400);
    }
    if (description.length > 200) {
      return json({ error: '描述太长（最多 200 字）' }, 400);
    }

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        // 多项食物时返回的 JSON 比单项长不少（n 个 {name, calories} + items 包裹），
        // 200 不够装 5+ 项；600 给 ~15 项留足余量。
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: description }],
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

    return json({ items });
  } catch (e) {
    console.error('Unhandled error:', e);
    const err = e as Error;
    return json({
      error: '函数内部错误',
      detail: `${err.name || 'Error'}: ${err.message || String(e)}${err.stack ? '\n' + err.stack.slice(0, 500) : ''}`,
    }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
