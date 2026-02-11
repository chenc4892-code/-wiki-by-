import { getSettings } from './index.js';

// ============ Wikimedia 搜索 ============

// 策略1: Wikipedia 文章主图
async function searchWikipediaArticle(query, lang) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php` +
      `?action=query&generator=search` +
      `&gsrsearch=${encodeURIComponent(query)}` +
      `&gsrlimit=5&prop=pageimages&piprop=original` +
      `&format=json&origin=*`;

    const resp = await fetch(url);
    const data = await resp.json();
    const pages = Object.values(data.query?.pages || {});

    pages.sort((a, b) => (a.index || 0) - (b.index || 0));

    return pages
      .filter(p => p.original && /\.(jpe?g|png|webp)/i.test(p.original.source))
      .map(p => ({
        url: p.original.source,
        thumbnail: p.original.source.replace(/\/commons\//, '/commons/thumb/') + '/800px-' + p.original.source.split('/').pop(),
        title: p.title || '',
        source: `${lang}.wikipedia`,
        width: p.original.width || 0,
        height: p.original.height || 0,
      }));
  } catch (e) {
    console.error('[AutoIllust] Wikipedia 搜索失败:', e);
    return [];
  }
}

// 策略2: Wikimedia Commons 搜文件
async function searchWikimediaCommons(query) {
  try {
    // 搜索文件
    const searchUrl = `https://commons.wikimedia.org/w/api.php` +
      `?action=query&list=search` +
      `&srsearch=${encodeURIComponent(query)}` +
      `&srnamespace=6&srlimit=8&format=json&origin=*`;

    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();
    const results = searchData.query?.search;
    if (!results?.length) return [];

    // 获取图片信息
    const titles = results.map(r => r.title).join('|');
    const infoUrl = `https://commons.wikimedia.org/w/api.php` +
      `?action=query&titles=${encodeURIComponent(titles)}` +
      `&prop=imageinfo&iiprop=url|mime|extmetadata|size` +
      `&format=json&origin=*`;

    const infoResp = await fetch(infoUrl);
    const infoData = await infoResp.json();
    const pages = Object.values(infoData.query?.pages || {});

    return pages
      .filter(p => {
        const info = p.imageinfo?.[0];
        return info?.mime?.startsWith('image/') &&
          !info.mime.includes('svg') &&
          (info.width || 0) > 200;  // 过滤太小的图
      })
      .map(p => {
        const info = p.imageinfo[0];
        const filename = p.title.replace('File:', '');
        return {
          url: info.url,
          thumbnail: `https://commons.wikimedia.org/w/thumb.php?f=${encodeURIComponent(filename)}&w=800`,
          title: p.title.replace('File:', '').replace(/\.\w+$/, '').replace(/_/g, ' '),
          source: 'commons',
          width: info.width || 0,
          height: info.height || 0,
        };
      });
  } catch (e) {
    console.error('[AutoIllust] Commons 搜索失败:', e);
    return [];
  }
}

// Wikimedia 综合搜索
export async function searchWikimedia(query) {
  const settings = getSettings();
  const limit = settings.candidates_per_source;

  // 判断是否包含中日韩文字
  const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]/.test(query);

  let results = [];

  // 按语言优先级搜 Wikipedia
  if (hasCJK) {
    results = await searchWikipediaArticle(query, 'zh');
    if (results.length < 2) {
      results.push(...await searchWikipediaArticle(query, 'en'));
    }
  } else {
    results = await searchWikipediaArticle(query, 'en');
    if (results.length < 2) {
      results.push(...await searchWikipediaArticle(query, 'zh'));
    }
  }

  // Wikipedia 不够就搜 Commons
  if (results.length < limit) {
    const commonsResults = await searchWikimediaCommons(query);
    results.push(...commonsResults);
  }

  // 去重（按 URL）
  const seen = new Set();
  results = results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  return results.slice(0, limit);
}

// ============ Google 搜索（通过 Serper.dev）============

export async function searchGoogle(query) {
  const settings = getSettings();

  if (!settings.serper_api_key) {
    console.warn('[AutoIllust] 未设置 Serper API Key，跳过 Google 搜索');
    return [];
  }

  try {
    const resp = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: {
        'X-API-KEY': settings.serper_api_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: settings.candidates_per_source,
      }),
    });

    if (!resp.ok) throw new Error(`Serper API ${resp.status}`);

    const data = await resp.json();

    return (data.images || []).map(item => ({
      url: item.imageUrl,
      thumbnail: item.thumbnailUrl || item.imageUrl,
      title: item.title || '',
      source: 'google',
      width: item.imageWidth || 0,
      height: item.imageHeight || 0,
      link: item.link || '',
      domain: item.source || '',
    }));
  } catch (e) {
    console.error('[AutoIllust] Google 搜索失败:', e);
    return [];
  }
}

// ============ 两个都搜 ============

export async function searchBoth(query) {
  const [wikiResults, googleResults] = await Promise.all([
    searchWikimedia(query),
    searchGoogle(query),
  ]);

  // 交替排列，让两个来源的图片混合
  const merged = [];
  const maxLen = Math.max(wikiResults.length, googleResults.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < wikiResults.length) merged.push(wikiResults[i]);
    if (i < googleResults.length) merged.push(googleResults[i]);
  }

  return merged;
}