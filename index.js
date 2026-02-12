import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { searchWikimedia, searchGoogle, searchBoth } from './search.js';
import { extractKeywords, selectBestImage, fetchModels } from './ai.js';
import { insertImageToMessage, insertLoadingPlaceholder, removeLoadingPlaceholder, restoreAllImages } from './ui.js';

export const extensionName = 'auto-illustration';
export const extensionFolder = `scripts/extensions/third-party/${extensionName}`;

// ============ 默认设置 ============

export const defaultSettings = {
  enabled: false,

  // AI 设置（OpenAI 兼容格式）
  ai_base_url: 'https://your-proxy.com',  // 中转地址
  ai_api_key: '',
  ai_model: '',
  ai_models_cache: [],  // 缓存的模型列表

  // Serper (Google)
  serper_api_key: '',

  // 行为（同之前）
  candidates_per_source: 4,
  max_queries: 2,
  min_message_length: 80,
  show_caption: true,
  auto_mode: true,
  search_preference: 'smart',
};

// ============ 初始化设置 ============
export function loadSettings() {
  extension_settings[extensionName] = {
    ...defaultSettings,
    ...(extension_settings[extensionName] || {}),
  };
}

export function getSettings() {
  return extension_settings[extensionName];
}

// ============ 主流程 ============
async function onMessageReceived(messageId) {
  const settings = getSettings();
  if (!settings.enabled) return;

  const context = getContext();
  const message = context.chat[messageId];

  // 基本过滤
  if (!message || message.is_user) return;
  if (message.mes.length < settings.min_message_length) return;
  if (message.extra?.auto_illust) return; // 已经配过图了

  console.log('[AutoIllust] 处理消息:', messageId);

  // ========== 先插入加载动画 ==========
  insertLoadingPlaceholder(messageId);

  try {
    // ========== Step 1: AI 提取关键词 + 判断搜索源 ==========
    const analysis = await extractKeywords(message.mes);

    if (!analysis.queries?.length) {
      console.log('[AutoIllust] 没有提取到关键词');
      removeLoadingPlaceholder(messageId);
      return;
    }

    console.log('[AutoIllust] 关键词:', analysis.queries, '来源:', analysis.source);

    // ========== Step 2: 根据来源搜索 ==========
    const source = settings.search_preference === 'smart'
      ? analysis.source
      : settings.search_preference;

    let allCandidates = [];

    for (const queryItem of analysis.queries.slice(0, settings.max_queries)) {
      const query = typeof queryItem === 'string' ? queryItem : queryItem.query;
      const querySource = typeof queryItem === 'string' ? source : (queryItem.source || source);

      let results = [];

      switch (querySource) {
        case 'wiki':
          results = await searchWikimedia(query);
          // Wiki 没搜到就降级到 Google
          if (results.length === 0 && settings.serper_api_key) {
            console.log('[AutoIllust] Wiki 无结果，降级到 Google');
            results = await searchGoogle(query);
          }
          break;

        case 'google':
          results = await searchGoogle(query);
          break;

        case 'both':
          results = await searchBoth(query);
          break;

        default:
          results = await searchBoth(query);
      }

      allCandidates.push(...results.map(r => ({ ...r, query })));
    }

    if (allCandidates.length === 0) {
      console.log('[AutoIllust] 搜索无结果');
      removeLoadingPlaceholder(messageId);
      return;
    }

    console.log(`[AutoIllust] 共 ${allCandidates.length} 张候选图`);

    // ========== Step 3: AI 看图选最佳 ==========
    const best = await selectBestImage(message.mes, allCandidates);

    if (!best) {
      console.log('[AutoIllust] 没有合适的图');
      removeLoadingPlaceholder(messageId);
      return;
    }

    console.log('[AutoIllust] 选中:', best.url, 'from', best.source);

    // ========== Step 4: 替换加载动画为图片 ==========
    if (settings.auto_mode) {
      await insertImageToMessage(messageId, best);
    } else {
      removeLoadingPlaceholder(messageId);
      const confirmed = await showConfirmPopup(best);
      if (confirmed) {
        await insertImageToMessage(messageId, best);
      }
    }

  } catch (error) {
    console.error('[AutoIllust] 错误:', error);
    removeLoadingPlaceholder(messageId);
  }
}

// ============ 确认弹窗 ============
async function showConfirmPopup(imageData) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; top:0; left:0; width:100%; height:100%;
      background:rgba(0,0,0,0.7); z-index:99999;
      display:flex; align-items:center; justify-content:center;
    `;

    overlay.innerHTML = `
      <div style="background:#2b2b2b; border-radius:12px; padding:20px; max-width:500px; width:90%; text-align:center;">
        <div style="color:#aaa; font-size:13px; margin-bottom:10px;">🔍 ${imageData.query} · via ${imageData.source}</div>
        <img src="${imageData.thumbnail || imageData.url}" style="max-width:100%; max-height:300px; border-radius:8px; margin-bottom:15px;" />
        <div style="color:#ccc; font-size:12px; margin-bottom:15px;">${imageData.title || ''}</div>
        <div style="display:flex; gap:10px; justify-content:center;">
          <button id="ai_confirm_yes" style="padding:8px 24px; background:#4CAF50; color:white; border:none; border-radius:6px; cursor:pointer; font-size:14px;">✅ 使用</button>
          <button id="ai_confirm_no" style="padding:8px 24px; background:#666; color:white; border:none; border-radius:6px; cursor:pointer; font-size:14px;">❌ 跳过</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#ai_confirm_yes').onclick = () => {
      overlay.remove();
      resolve(true);
    };
    overlay.querySelector('#ai_confirm_no').onclick = () => {
      overlay.remove();
      resolve(false);
    };
  });
}

async function loadSettingsUI() {
  // ===== 直接内联 HTML，不依赖外部文件 =====
  const html = `
  <div class="auto-illust-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>🖼️ Auto Illustration</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">

        <label class="checkbox_label">
          <input type="checkbox" id="ai_enabled" />
          <span>启用自动配图</span>
        </label>
        <hr />

        <h4>🤖 AI 设置</h4>
        <small>支持 OpenAI 兼容格式（中转站、one-api 等）</small>

        <label>Base URL</label>
        <input type="text" id="ai_base_url" class="text_pole"
               placeholder="https://your-proxy.com/v1" />

        <label>API Key</label>
        <input type="password" id="ai_api_key" class="text_pole"
               placeholder="sk-..." />

        <div style="display:flex; gap:8px; align-items:center; margin:8px 0;">
          <button id="ai_test_connection" class="menu_button">🔌 测试连接</button>
          <span id="ai_connection_status" style="font-size:12px;"></span>
        </div>

        <label>模型</label>
        <div style="display:flex; gap:8px; align-items:center;">
          <select id="ai_model_select" class="text_pole" style="flex:1;">
            <option value="">-- 点击 🔄 获取模型列表 --</option>
          </select>
          <button id="ai_refresh_models" class="menu_button" title="刷新模型列表">🔄</button>
        </div>
        <input type="text" id="ai_model_search" class="text_pole"
               placeholder="🔍 搜索模型..." style="display:none; margin-top:4px;" />
        <span id="ai_model_status" style="font-size:11px; color:#888;"></span>
        <hr />

        <h4>🔍 图片搜索</h4>
        <label>搜索源偏好</label>
        <select id="ai_search_preference" class="text_pole">
          <option value="smart">🧠 智能判断</option>
          <option value="both">🔀 两个都搜</option>
          <option value="wiki">📖 仅 Wikimedia</option>
          <option value="google">🔍 仅 Google</option>
        </select>

        <label>Serper.dev API Key</label>
        <input type="password" id="ai_serper_key" class="text_pole"
               placeholder="Serper API Key" />
        <small><a href="https://serper.dev/" target="_blank">免费注册 ↗</a> · 注册送 2500 次</small>
        <hr />

        <h4>⚙️ 行为设置</h4>
        <label>每个来源候选图数量</label>
        <input type="number" id="ai_candidates" class="text_pole" min="2" max="8" />
        <label>每条消息最多搜几个关键词</label>
        <input type="number" id="ai_max_queries" class="text_pole" min="1" max="4" />
        <label>最短触发字数</label>
        <input type="number" id="ai_min_length" class="text_pole" min="0" max="500" />
        <label class="checkbox_label">
          <input type="checkbox" id="ai_show_caption" />
          <span>显示图片来源标注</span>
        </label>
        <label class="checkbox_label">
          <input type="checkbox" id="ai_auto_mode" />
          <span>全自动模式</span>
        </label>
        <hr />

        <h4>🧪 测试</h4>
        <div style="background:#1e1e1e; border-radius:8px; padding:12px;">
          <input type="text" id="ai_test_query" class="text_pole"
                 placeholder="输入关键词，如 Mona Lisa" />
          <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
            <select id="ai_test_source" class="text_pole" style="flex:1;">
              <option value="both">两个都搜</option>
              <option value="wiki">Wikimedia</option>
              <option value="google">Google</option>
            </select>
            <button id="ai_test_search" class="menu_button">测试搜索</button>
          </div>
          <div id="ai_test_result" style="min-height:20px; margin-top:8px;"></div>
        </div>

      </div>
    </div>
  </div>`;

  $('#extensions_settings').append(html);

  // ===== 确认 HTML 已加载 =====
  console.log('[AutoIllust] HTML 已注入, 按钮存在:',
    !!document.querySelector('#ai_test_connection'),
    !!document.querySelector('#ai_test_search'),
    !!document.querySelector('#ai_refresh_models')
  );

  const s = getSettings();

  // ===== 绑定设置控件 =====
  $('#ai_enabled').prop('checked', s.enabled);
  $('#ai_base_url').val(s.ai_base_url);
  $('#ai_api_key').val(s.ai_api_key);
  $('#ai_serper_key').val(s.serper_api_key);
  $('#ai_candidates').val(s.candidates_per_source);
  $('#ai_max_queries').val(s.max_queries);
  $('#ai_min_length').val(s.min_message_length);
  $('#ai_show_caption').prop('checked', s.show_caption);
  $('#ai_auto_mode').prop('checked', s.auto_mode);
  $('#ai_search_preference').val(s.search_preference);

  // 模型下拉框：如果有缓存就填充
  if (s.ai_models_cache?.length) {
    populateModelSelect(s.ai_models_cache, s.ai_model);
  } else if (s.ai_model) {
    $('#ai_model_select').append(
      `<option value="${s.ai_model}" selected>${s.ai_model}</option>`
    );
  }

  // ===== 用事件委托绑定按钮，确保一定能触发 =====
  $(document).on('change', '#ai_enabled', function () {
    console.log('[AutoIllust] 开关切换:', this.checked);
    getSettings().enabled = this.checked;
    saveSettingsDebounced();
  });

  $(document).on('input', '#ai_base_url', function () {
    getSettings().ai_base_url = this.value;
    saveSettingsDebounced();
  });

  $(document).on('input', '#ai_api_key', function () {
    getSettings().ai_api_key = this.value;
    saveSettingsDebounced();
  });

  $(document).on('input', '#ai_serper_key', function () {
    getSettings().serper_api_key = this.value;
    saveSettingsDebounced();
  });

  $(document).on('input', '#ai_candidates', function () {
    getSettings().candidates_per_source = parseInt(this.value) || 4;
    saveSettingsDebounced();
  });

  $(document).on('input', '#ai_max_queries', function () {
    getSettings().max_queries = parseInt(this.value) || 2;
    saveSettingsDebounced();
  });

  $(document).on('input', '#ai_min_length', function () {
    getSettings().min_message_length = parseInt(this.value) || 80;
    saveSettingsDebounced();
  });

  $(document).on('change', '#ai_show_caption', function () {
    getSettings().show_caption = this.checked;
    saveSettingsDebounced();
  });

  $(document).on('change', '#ai_auto_mode', function () {
    getSettings().auto_mode = this.checked;
    saveSettingsDebounced();
  });

  $(document).on('change', '#ai_search_preference', function () {
    getSettings().search_preference = this.value;
    saveSettingsDebounced();
  });

  $(document).on('change', '#ai_model_select', function () {
    console.log('[AutoIllust] 模型切换:', this.value);
    getSettings().ai_model = this.value;
    saveSettingsDebounced();
  });

  // ===== 按钮事件 =====

  $(document).on('click', '#ai_test_connection', async function () {
    console.log('[AutoIllust] 点击测试连接');
    const btn = $(this);
    const status = $('#ai_connection_status');

    btn.prop('disabled', true).text('测试中...');
    status.text('').css('color', '#888');

    try {
      const models = await fetchModels();
      status.text(`✅ 连接成功！${models.length} 个模型`).css('color', '#4CAF50');
      console.log('[AutoIllust] 连接成功, 模型数:', models.length);
    } catch (e) {
      status.text(`❌ ${e.message}`).css('color', '#e74c3c');
      console.error('[AutoIllust] 连接失败:', e);
    } finally {
      btn.prop('disabled', false).text('🔌 测试连接');
    }
  });

  $(document).on('click', '#ai_refresh_models', async function () {
    console.log('[AutoIllust] 点击刷新模型');
    const btn = $(this);
    const status = $('#ai_model_status');

    btn.prop('disabled', true);
    status.text('获取中...').css('color', '#888');

    try {
      const models = await fetchModels();

      if (models.length === 0) {
        status.text('未找到模型').css('color', '#e74c3c');
        return;
      }

      getSettings().ai_models_cache = models;
      saveSettingsDebounced();
      populateModelSelect(models, getSettings().ai_model);
      status.text(`✅ ${models.length} 个模型`).css('color', '#4CAF50');

    } catch (e) {
      status.text(`❌ ${e.message}`).css('color', '#e74c3c');
      console.error('[AutoIllust] 获取模型失败:', e);
    } finally {
      btn.prop('disabled', false);
    }
  });

  $(document).on('click', '#ai_test_search', async function () {
    console.log('[AutoIllust] 点击测试搜索');
    const btn = $(this);
    const resultDiv = $('#ai_test_result');

    btn.prop('disabled', true).text('搜索中...');
    resultDiv.html('');

    try {
      const query = $('#ai_test_query').val()?.trim() || 'Mona Lisa';
      const source = $('#ai_test_source').val() || 'both';

      console.log('[AutoIllust] 搜索:', query, '来源:', source);

      let results = [];
      switch (source) {
        case 'wiki': results = await searchWikimedia(query); break;
        case 'google': results = await searchGoogle(query); break;
        case 'both': results = await searchBoth(query); break;
      }

      console.log('[AutoIllust] 搜索结果:', results.length, '张');

      if (results.length === 0) {
        resultDiv.html('<span style="color:#e74c3c;">未找到结果</span>');
        return;
      }

      const thumbs = results.slice(0, 6).map(r => `
        <div style="display:inline-block; margin:4px; text-align:center; vertical-align:top;">
          <img src="${r.thumbnail || r.url}"
               referrerpolicy="no-referrer"
               style="width:100px; height:80px; object-fit:cover; border-radius:4px;"
               onerror="this.style.background='#333'; this.alt='加载失败';" />
          <div style="font-size:10px; color:#888; max-width:100px;
                      overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">
            ${r.source}
          </div>
        </div>
      `).join('');

      resultDiv.html(thumbs);

    } catch (e) {
      resultDiv.html(`<span style="color:#e74c3c;">❌ ${e.message}</span>`);
      console.error('[AutoIllust] 搜索失败:', e);
    } finally {
      btn.prop('disabled', false).text('测试搜索');
    }
  });

  console.log('[AutoIllust] 设置面板初始化完成');
}

// ============ 辅助函数 ============

function populateModelSelect(models, selectedModel) {
  const select = $('#ai_model_select');
  select.empty();

  if (models.length === 0) {
    select.append('<option value="">-- 未找到模型 --</option>');
    return;
  }

  select.append('<option value="">-- 选择模型 --</option>');

  models.forEach(model => {
    const option = $('<option></option>')
      .val(model)
      .text(model);

    if (model === selectedModel) {
      option.prop('selected', true);
    }

    select.append(option);
  });
}

// ============ 启动 ============
jQuery(async () => {
  loadSettings();
  await loadSettingsUI();

  // 监听新消息
  eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
    setTimeout(() => onMessageReceived(messageId), 800);
  });

  // 聊天切换时恢复图片
  eventSource.on(event_types.CHAT_CHANGED, () => {
    setTimeout(restoreAllImages, 1200);
  });

  console.log('[AutoIllust] v2.0 已加载');
});