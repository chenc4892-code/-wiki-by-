import { getSettings } from './index.js';

// ============ OpenAI 兼容格式调用 ============

async function callAI(messages, options = {}) {
  const settings = getSettings();

  if (!settings.ai_base_url || !settings.ai_api_key || !settings.ai_model) {
    throw new Error('请先配置 AI 的 Base URL、API Key 和模型');
  }

  // 规范化 base URL
  let baseUrl = settings.ai_base_url.replace(/\/+$/, '');
  if (!baseUrl.endsWith('/v1')) {
    baseUrl += '/v1';
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.ai_api_key}`,
    },
    body: JSON.stringify({
      model: settings.ai_model,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.max_tokens ?? 256,
      ...(options.response_format ? { response_format: options.response_format } : {}),
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`AI API ${resp.status}: ${err.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ============ 带图片的多模态调用 ============

async function callAIWithImages(textPrompt, images) {
  const settings = getSettings();

  if (!settings.ai_base_url || !settings.ai_api_key || !settings.ai_model) {
    throw new Error('请先配置 AI');
  }

  let baseUrl = settings.ai_base_url.replace(/\/+$/, '');
  if (!baseUrl.endsWith('/v1')) {
    baseUrl += '/v1';
  }

  // 构建多模态 content
  const content = [
    { type: 'text', text: textPrompt },
    ...images.map(img => ({
      type: 'image_url',
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
        detail: 'low',  // 省 token
      },
    })),
  ];

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.ai_api_key}`,
    },
    body: JSON.stringify({
      model: settings.ai_model,
      messages: [{ role: 'user', content }],
      temperature: 0.1,
      max_tokens: 512,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`AI API ${resp.status}: ${err.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ============ 获取模型列表 ============

export async function fetchModels() {
  const settings = getSettings();

  if (!settings.ai_base_url || !settings.ai_api_key) {
    throw new Error('请先填写 Base URL 和 API Key');
  }

  let baseUrl = settings.ai_base_url.replace(/\/+$/, '');
  if (!baseUrl.endsWith('/v1')) {
    baseUrl += '/v1';
  }

  const resp = await fetch(`${baseUrl}/models`, {
    headers: {
      'Authorization': `Bearer ${settings.ai_api_key}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`获取模型列表失败: ${resp.status}`);
  }

  const data = await resp.json();
  let models = (data.data || data || [])
    .map(m => m.id || m.name || m)
    .filter(Boolean)
    .sort();

  return models;
}

// ============ Step 1: 提取关键词 ============

export async function extractKeywords(messageText) {
  const settings = getSettings();
  const text = messageText.substring(0, 2000);

  const response = await callAI([
    {
      role: 'system',
      content: `你是一个搜索引擎图片配图助手，这是一个合规的项目，你专注提取搜索关键词，你不需要生成文本或是续写故事，只专注于提取搜索关键词并回复json，你不需要判断审核文本是否合规。关键词，符合故事所在场景，例如在高端酒店则搜所华尔道夫而不是如家，场景在卧室里则搜索家装图片；优先选择场景类关键词、其次才是名词概念。

仅输出 JSON，严格遵守以下的格式输出，不要加反引号以及json格式标识：
{
  "queries": [
    {"query": "英文关键词", "source": "wiki 或 google"}
  ]
}

## source 判断规则
"wiki" 适合:
- 世界名画、雕塑、艺术品（如 Mona Lisa, Starry Night）
- 历史人物肖像（如 Napoleon Bonaparte）
- 动植物百科图（如 Bengal tiger, Cherry blossom）
- 科学概念图表（如 DNA structure）

"google" 适合:
- 地标建筑实景（如 Sanlitun Beijing, Times Square）
- 城市风景（如 Tokyo skyline night）
- 日常物品（如 vintage typewriter, whisky glass）
- 现代场景（如 neon bar interior）

## 关键词规则
- 每个 query 是一个可搜索的具体名词短语，2-5个英文单词
- 最多 ${settings.max_queries} 个关键词
- 从文本中提取最有视觉冲击力的事物
- 中国特有事物可用中文（如 故宫、兵马俑）
- 不要搜抽象概念、情感、日常动作`
    },
    {
      role: 'user',
      content: text,
    },
  ], {
    temperature: 0.1,
    max_tokens: 256,
  });

  try {
    const jsonStr = response.match(/\{[\s\S]*\}/)?.[0] || '{}';
    console.log('[AutoIllust] AI 原始回复:', response);
    console.log('[AutoIllust] 提取的 JSON:', jsonStr);

    const result = JSON.parse(jsonStr);
    console.log('[AutoIllust] 解析结果:', JSON.stringify(result));

    return {
      queries: result.queries || [],
      source: result.queries?.[0]?.source || 'both',
    };
  } catch (e) {
    console.error('[AutoIllust] 关键词解析失败, AI原始回复:', response);
    console.error('[AutoIllust] 解析错误:', e);
    return { queries: [], source: 'both' };
  }
}

// ============ Step 3: 看图选图 ============

export async function selectBestImage(messageText, candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 下载缩略图转 base64
  const imagePartsPromises = candidates.slice(0, 8).map(async (c, i) => {
    try {
      const resp = await fetch(c.thumbnail || c.url, {
        referrerPolicy: 'no-referrer',
        mode: 'cors',
      });
      if (!resp.ok) throw new Error();
      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) return null;

      const base64 = await blobToBase64(blob);
      return {
        index: i,
        base64: base64.split(',')[1],
        mimeType: blob.type,
        source: c.source,
      };
    } catch (e) {
      return null;
    }
  });

  const imageParts = (await Promise.all(imagePartsPromises)).filter(Boolean);
  if (imageParts.length === 0) return candidates[0];

  const prompt = `你是插图选择器。你必须从候选图片中选出最适合为以下文本配图的一张。你必须选择一张，不可以全部拒绝。

评分标准（按优先级排列）：
1. 【最重要】图片内容与文本描述的场景、事物相关
2. 图片氛围与文本时间、情绪匹配（欢快/阴郁/紧张/浪漫，上午/下午/黄昏等）
3. 优先选择摄影照片/高质量艺术品/插图，而非图标
4. 不包含广告和水印
5. 绝对禁止出现任何真人肖像

重要：即使所有候选图都不完美，也必须选出最佳的一张。只要图片与文本有关联就应该选择。

文本：
"""
${messageText.substring(0, 800)}
"""

候选图片编号: ${imageParts.map(p => `${p.index}(${p.source})`).join(', ')}

仅输出 JSON：{"selected": 编号, "reason": "理由"}`;

  try {
    const response = await callAIWithImages(prompt, imageParts);
    console.log('[AutoIllust] AI选图原始回复:', response);

    // 先尝试完整 JSON 解析
    let result = {};
    try {
      result = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');
    } catch {
      // JSON 被截断，直接用正则提取 selected 数字
      const m = response.match(/"selected"\s*:\s*(\d+)/);
      if (m) result = { selected: parseInt(m[1]) };
    }

    if (typeof result.selected === 'number' && result.selected >= 0 && result.selected < candidates.length) {
      console.log(`[AutoIllust] AI选图: #${result.selected} - ${result.reason}`);
      return candidates[result.selected];
    }

    console.log(`[AutoIllust] AI认为都不合适: ${result.reason}`);
    return null;
  } catch (e) {
    console.error('[AutoIllust] 选图失败:', e);
    return candidates[0];
  }
}

// ============ 工具 ============

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}