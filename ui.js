import { getContext } from '../../../extensions.js';
import { getSettings } from './index.js';

// ============ 在 innerHTML 中找元数据起始位置（纯字符串，不受 <content> 影响） ============

function findMetadataIndex(html) {
  const commentIdx = html.indexOf('<!--');
  const detailsIdx = html.indexOf('<details');

  if (commentIdx !== -1 && detailsIdx !== -1) {
    return Math.min(commentIdx, detailsIdx);
  }
  if (commentIdx !== -1) return commentIdx;
  if (detailsIdx !== -1) return detailsIdx;
  return -1;
}

function spliceHtml(textElement, htmlStr) {
  const raw = textElement.innerHTML;
  const idx = findMetadataIndex(raw);

  if (idx !== -1) {
    textElement.innerHTML = raw.slice(0, idx) + htmlStr + raw.slice(idx);
  } else {
    textElement.insertAdjacentHTML('beforeend', htmlStr);
  }
}

// ============ 插入加载占位符 ============

export function insertLoadingPlaceholder(messageId) {
  const messageElement = document.querySelector(`[mesid="${messageId}"]`);
  if (!messageElement) return false;

  const textElement = messageElement.querySelector('.mes_text');
  if (!textElement) return false;

  const loadingHtml = `<div class="auto-illust-wrapper auto-illust-loading" data-mesid="${messageId}">
    <div class="auto-illust-spinner">
      <span class="auto-illust-spinner-text">🔍 搜索配图中...</span>
    </div>
  </div>`;

  spliceHtml(textElement, loadingHtml);
  return true;
}

// ============ 移除加载占位符 ============

export function removeLoadingPlaceholder(messageId) {
  const placeholder = document.querySelector(
    `.auto-illust-loading[data-mesid="${messageId}"]`
  );
  if (placeholder) placeholder.remove();
}

// ============ 插入图片到消息 ============

export async function insertImageToMessage(messageId, imageData) {
  const messageElement = document.querySelector(`[mesid="${messageId}"]`);
  if (!messageElement) return;

  const textElement = messageElement.querySelector('.mes_text');
  if (!textElement) return;

  const settings = getSettings();

  // 创建图片容器
  const wrapper = document.createElement('div');
  wrapper.className = 'auto-illust-wrapper';
  wrapper.dataset.imageUrl = imageData.url;
  wrapper.dataset.query = imageData.query || '';
  wrapper.dataset.source = imageData.source || '';

  const img = document.createElement('img');
  img.className = 'auto-illust-img';
  img.alt = imageData.query || '';
  img.referrerPolicy = 'no-referrer';

  // 直接用原图 URL 加载，不走 fetch，避免 CORS
  img.src = imageData.url;
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => {
    if (img.src !== imageData.url) {
      img.src = imageData.url;
    } else {
      wrapper.remove();
    }
  };

  img.style.cursor = 'pointer';
  img.onclick = () => window.open(imageData.url, '_blank');

  wrapper.appendChild(img);

  // 图片标注
  if (settings.show_caption) {
    const caption = document.createElement('div');
    caption.className = 'auto-illust-caption';

    const sourceIcon = imageData.source === 'google' ? '🔍' :
      imageData.source === 'commons' ? '🏛️' : '📖';
    caption.textContent = `${sourceIcon} ${imageData.query || ''} · via ${imageData.source}`;

    caption.style.cursor = 'pointer';
    caption.onclick = () => window.open(imageData.url, '_blank');

    wrapper.appendChild(caption);
  }

  // 替换加载占位符（占位符已经在正确位置）
  const placeholder = messageElement.querySelector(
    `.auto-illust-loading[data-mesid="${messageId}"]`
  );

  if (placeholder) {
    placeholder.replaceWith(wrapper);
  } else {
    // 没有占位符（恢复场景）：用临时标记定位，再替换为真实元素
    const tempId = `auto-illust-temp-${messageId}-${Date.now()}`;
    spliceHtml(textElement, `<div id="${tempId}"></div>`);

    const tempEl = document.getElementById(tempId);
    if (tempEl) {
      tempEl.replaceWith(wrapper);
    } else {
      textElement.appendChild(wrapper);
    }
  }

  // 保存到消息元数据
  const context = getContext();
  const message = context.chat[messageId];
  if (message) {
    if (!message.extra) message.extra = {};
    message.extra.auto_illust = {
      url: imageData.url,
      thumbnail: imageData.thumbnail,
      query: imageData.query,
      source: imageData.source,
      title: imageData.title,
    };
    await context.saveChat();
  }
}

// ============ 恢复所有图片 ============

export async function restoreAllImages() {
  const context = getContext();
  if (!context.chat) return;

  await new Promise(r => setTimeout(r, 500));

  for (let i = 0; i < context.chat.length; i++) {
    const illust = context.chat[i]?.extra?.auto_illust;
    if (!illust) continue;

    const messageEl = document.querySelector(`[mesid="${i}"]`);
    if (!messageEl) continue;
    if (messageEl.querySelector('.auto-illust-wrapper')) continue;

    await insertImageToMessage(i, illust);
  }

  console.log('[AutoIllust] 图片恢复完成');
}
