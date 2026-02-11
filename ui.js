import { getContext } from '../../../extensions.js';
import { getSettings } from './index.js';

// ============ 找正文末尾插入位置（深度搜索注释/details边界） ============

function findMetadataBoundary(textElement) {
  // 用 TreeWalker 在整棵 DOM 树中找第一个 comment 节点（如 Tidal Memory）
  const walker = document.createTreeWalker(
    textElement,
    NodeFilter.SHOW_COMMENT,
    null,
  );

  if (walker.nextNode()) {
    return walker.currentNode;
  }

  // 没有注释，找 <details>（状态面板）
  const details = textElement.querySelector('details');
  return details || null;
}

function insertAtContentEnd(textElement, element) {
  const boundary = findMetadataBoundary(textElement);
  if (boundary) {
    // 插到注释/details 前面（不管它嵌套在哪一层）
    boundary.parentNode.insertBefore(element, boundary);
  } else {
    textElement.appendChild(element);
  }
}

// ============ 插入加载占位符 ============

export function insertLoadingPlaceholder(messageId) {
  const messageElement = document.querySelector(`[mesid="${messageId}"]`);
  if (!messageElement) return false;

  const textElement = messageElement.querySelector('.mes_text');
  if (!textElement) return false;

  const loading = document.createElement('div');
  loading.className = 'auto-illust-wrapper auto-illust-loading';
  loading.dataset.mesid = messageId;
  loading.innerHTML = `<div class="auto-illust-spinner">
    <span class="auto-illust-spinner-text">🔍 搜索配图中...</span>
  </div>`;

  insertAtContentEnd(textElement, loading);
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

  // 替换加载占位符，或插到正文末尾
  const placeholder = messageElement.querySelector(
    `.auto-illust-loading[data-mesid="${messageId}"]`
  );

  if (placeholder) {
    placeholder.replaceWith(wrapper);
  } else {
    insertAtContentEnd(textElement, wrapper);
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
