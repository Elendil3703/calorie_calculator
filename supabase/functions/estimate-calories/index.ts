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
const MODEL = 'claude-haiku-4-5-20251001';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `你是中餐为主的营养估算助手。用户用中文描述吃了什么（例如「一碗米饭」「两个煎蛋」「一份红烧肉」），你估算这份食物的**总**大卡数。

严格按以下规则返回：
- 只输出一个 JSON 对象，不要任何解释或额外文本
- 格式：{"name": "<食物名>", "calories": <整数>}
- name 是规范的食物名称，去掉数量描述（比如「一碗米饭」→「米饭」、「两个煎蛋」→「煎蛋」）
- calories 必须是一个具体的整数（不要写区间、不要带单位、不要带其他字段），按用户描述的份量估算总量
- 份量未明确时，按常见家庭单人份估算（如「一碗」「一份」按普通成人份量）
- 如果输入不是食物，返回 {"error": "not_food"}`;

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
        max_tokens: 200,
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

    let parsed: { name?: string; calories?: number; error?: string };
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

    const calories = Math.round(Number(parsed.calories));
    if (!Number.isFinite(calories) || calories < 0 || calories > 10000) {
      return json({
        error: 'AI 返回数值异常',
        detail: `parsed: ${JSON.stringify(parsed).slice(0, 300)}`,
      }, 502);
    }

    const name = String(parsed.name || description).slice(0, 100);

    return json({ name, calories });
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
