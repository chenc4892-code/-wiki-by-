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
      max_tokens: 128,
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
      content: `你是图片配图助手。分析文本并提取搜索关键词，符合故事所在场景，例如在高端酒店则搜所华尔道夫而不是如家，场景在卧室里则搜索家装图片；优先选择场景类关键词、其次才是名词概念。

仅输出 JSON，格式：
{
  "need_img": true/false,
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
- 不要搜抽象概念、情感、日常动作

## 不需要配图的情况
- 纯对话/内心独白
- 没有具体的可视觉化事物
- 文本太短或太抽象`
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
    const result = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return {
      need_img: result.need_img ?? false,
      queries: result.queries || [],
      source: result.queries?.[0]?.source || 'both',
    };
  } catch (e) {
    console.error('[AutoIllust] 关键词解析失败:', response);
    return { need_img: false, queries: [], source: 'both' };
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

  const prompt = `你是插图选择器。从候选图片中选最适合为以下文本配图的一张。

评分标准：
1. 图片内容与文本中描述的事物相关
2. 图片质量好（清晰、构图佳，不是广告/水印/截图/logo/表情包）
3. 图片氛围与文本情绪匹配（欢快/阴郁/紧张/浪漫等）
4. 优先选择摄影照片/高质量艺术品/插图，而非图标
5. 绝对禁止出现任何真人肖像

文本：
"""
${messageText.substring(0, 800)}
"""

候选图片编号: ${imageParts.map(p => `${p.index}(${p.source})`).join(', ')}

仅输出 JSON：{"selected": 编号, "reason": "理由"}
都不合适则 selected 为 -1。`;

  try {
    const response = await callAIWithImages(prompt, imageParts);
    const result = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');

    if (result.selected >= 0 && result.selected < candidates.length) {
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