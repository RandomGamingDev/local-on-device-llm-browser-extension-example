// main.js - Content script for Boiler Tai
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';

marked.use(markedKatex({ throwOnError: false }));

let contentPort = null;
let isModelReady = false;
let isVisionReady = false;      // true when Gemma 3n supplement is loaded
let visionModelName = 'gemma-3n-E2B-it-int4-Web.litertlm'; // default vision model
let currentResSpan = null;
let currentImageDataUrl = null;
let isGenerating = false;
let setGenerating = null; // set by injectUI once the stop button exists

let cachedContextUrl = null;
let cachedContextData = null;

// Blind mode: suppress answer choices + choice images from context
let blindMode = false;

// Block-based prompt composer (DSPy-style)
const BLOCK_IDS = [
  'role-tutor', 'role-explainer',
  'domain-cs', 'domain-math', 'domain-physics',
  'technique-anti-hallucination', 'technique-chain-of-thought', 'technique-verify',
  'constraint-no-spoilers', 'constraint-latex'
];
const CATEGORY_LABELS = { role: '🎭 Role', domain: '📚 Domain', technique: '🔬 Technique', constraint: '🔒 Constraint' };
let blockRegistry = {};        // id -> block object
let activeComposition = [];    // [{id, indent}] flat ordered list with nesting depth

async function initBlockRegistry() {
  const results = await Promise.allSettled(
    BLOCK_IDS.map(id =>
      fetch(chrome.runtime.getURL(`personalities/blocks/${id}.json`)).then(r => r.json())
    )
  );
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') blockRegistry[BLOCK_IDS[i]] = res.value;
  });
}

function assemblePrompt(composition) {
  return composition
    .map(item => blockRegistry[item.id] && blockRegistry[item.id].content)
    .filter(Boolean)
    .join('\n\n');
}

// Load persisted settings
chrome.storage.local.get(['btBlindMode', 'btComposition'], (result) => {
  if (result.btBlindMode !== undefined) blindMode = !!result.btBlindMode;
  if (result.btComposition) {
    try { activeComposition = JSON.parse(result.btComposition); } catch (e) { }
  }
});
// Pre-load blocks
initBlockRegistry();

// Extract context from current Boilerexams question page
async function getQuestionContext() {
  const currentUrl = window.location.href;
  if (currentUrl === cachedContextUrl) return cachedContextData;

  const match = window.location.pathname.match(/\/([a-f0-9\-]{36})$/i);
  if (!match) return null;
  const questionId = match[1];

  try {
    const res = await fetch(`https://api.boilerexams.com/questions/${questionId}`);
    if (!res.ok) return null;
    const data = await res.json();
    cachedContextUrl = currentUrl;
    cachedContextData = data;
    return data;
  } catch (e) {
    console.error("Failed to fetch context", e);
    return null;
  }
}

function stripHtml(html) {
  if (!html) return '';
  // Use a temporary DOM element to decode entities and strip tags
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

function formatContextString(qData) {
  if (!qData || !qData.data) return "";
  let text = "Question Context:\n";
  if (qData.data.body) {
    text += stripHtml(qData.data.body) + "\n";
  }

  // In blind mode, omit answer choices so the model cannot anchor on them
  if (!blindMode && qData.type === "MULTIPLE_CHOICE" && qData.data.answerChoices) {
    text += "\nChoices:\n";
    const choices = [...qData.data.answerChoices].sort((a, b) => a.index - b.index);
    choices.forEach((choice, i) => {
      text += `${String.fromCharCode(65 + i)}: ${stripHtml(choice.body)}\n`;
    });
  }
  return text;
}

const MAX_IMAGES = 5;

async function fetchImageAsDataUrl(url, index) {
  try {
    const imgResp = await fetch(url);
    const blob = await imgResp.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error(`Failed to load image ${index + 1}`, e);
    return null;
  }
}

async function extractAllImages(qData) {
  if (!qData) return { questionImages: [], choiceImages: [] };

  // Question body images: first try top-level resources
  let questionImageUrls = (qData.resources || [])
    .filter(r => r.type === "IMAGE" && r.data && r.data.url)
    .map(r => r.data.url)
    .slice(0, MAX_IMAGES);
  console.log('[BoilerTai] Top-level resources:', qData.resources?.length ?? 0, '→ IMAGE urls:', questionImageUrls);

  // Fallback 1: scan the body HTML template for inline <img> tags
  if (questionImageUrls.length === 0 && qData.data && qData.data.body) {
    const tmp = document.createElement('div');
    tmp.innerHTML = qData.data.body;
    const imgTags = Array.from(tmp.querySelectorAll('img'));
    questionImageUrls = imgTags
      .map(img => img.getAttribute('src'))
      .filter(src => src && src.startsWith('http'))
      .slice(0, MAX_IMAGES);
    console.log('[BoilerTai] Fallback1 body HTML imgs found:', imgTags.length, '→ valid srcs:', questionImageUrls);
  }

  // Fallback 2: scan the live rendered DOM
  if (questionImageUrls.length === 0) {
    const mainContent = document.querySelector('#main-content') || document.body;
    const allImgs = Array.from(mainContent.querySelectorAll('img'));
    console.log('[BoilerTai] Fallback2 DOM scan: #main-content found:', !!document.querySelector('#main-content'), 'total imgs:', allImgs.length, 'srcs:', allImgs.map(i => i.src));
    const domImgs = allImgs
      .filter(img => {
        const src = img.src || '';
        return src.includes('boilerexams-production.s3') || src.includes('amazonaws.com') || src.includes('boilerexams');
      })
      .map(img => img.src)
      .filter(Boolean)
      .slice(0, MAX_IMAGES);
    questionImageUrls = [...new Set(domImgs)]; // deduplicate
    console.log('[BoilerTai] Fallback2 filtered imgs:', questionImageUrls);
  }

  // Answer choice images — labeled with their choice letter (skipped in blind mode)
  const choiceImages = [];
  if (!blindMode && qData.type === "MULTIPLE_CHOICE" && qData.data && qData.data.answerChoices) {
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let i = 0; i < qData.data.answerChoices.length && choiceImages.length < MAX_IMAGES; i++) {
      const choice = qData.data.answerChoices[i];
      // Check choice resources
      const imgRes = (choice.resources || []).filter(r => r.type === "IMAGE" && r.data && r.data.url);
      for (const r of imgRes) {
        const dataUrl = await fetchImageAsDataUrl(r.data.url, choiceImages.length);
        if (dataUrl) choiceImages.push({ dataUrl, label: letters[i] || `Choice ${i + 1}` });
        if (choiceImages.length >= MAX_IMAGES) break;
      }
      // Also scan choice HTML body for inline images
      if (choice.body) {
        const tmp = document.createElement('div');
        tmp.innerHTML = choice.body;
        const imgTags = Array.from(tmp.querySelectorAll('img'));
        for (const img of imgTags) {
          const src = img.src || img.getAttribute('src');
          if (!src) continue;
          const dataUrl = await fetchImageAsDataUrl(src, choiceImages.length);
          if (dataUrl) choiceImages.push({ dataUrl, label: letters[i] || `Choice ${i + 1}` });
          if (choiceImages.length >= MAX_IMAGES) break;
        }
      }
    }
  }

  const questionImages = (await Promise.all(
    questionImageUrls.map((url, i) => fetchImageAsDataUrl(url, i))
  )).filter(Boolean);

  return { questionImages, choiceImages };
}

function setupPort() {
  if (contentPort) return;
  contentPort = chrome.runtime.connect({ name: 'content' });

  contentPort.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'init':
        addMessage(`System: Primary model loaded successfully!`);
        isModelReady = true;
        break;
      case 'init_vision':
        if (msg.payload.isSuccess) {
          isVisionReady = true;
          addMessage(`System: Vision supplement (Gemma 3n) loaded! Image queries will now use it.`);
        } else {
          addMessage(`System: Vision supplement failed to load: ${msg.payload.error || 'unknown error'}`);
        }
        break;
      case 'result':
        handleResult(msg.payload);
        break;
      case 'error':
        addMessage(`Error: ${msg.payload.message || 'Unknown error'}`);
        currentResSpan = null;
        isGenerating = false;
        if (setGenerating) setGenerating(false);
        break;
    }
  });

  contentPort.onDisconnect.addListener(() => {
    contentPort = null;
    isModelReady = false;
    addMessage("System: Disconnected from background script. Please reopen chat to reconnect.");
  });
}

function initModel(modelName, withVision, visionName) {
  setupPort();
  addMessage(`System: Initializing model ${modelName}... Please wait.`);
  contentPort.postMessage({
    type: 'init',
    payload: { modelName }
  });
  if (withVision) {
    visionModelName = visionName;
    isVisionReady = false;
    addMessage(`System: Also loading vision supplement (${visionName})...`);
    contentPort.postMessage({
      type: 'init_vision',
      payload: { modelName: visionName }
    });
  }
}

async function queryModel(text) {
  if (!isModelReady) {
    addMessage("System: Please load a model first.");
    return;
  }

  // Reset any in-flight response span so its output cannot bleed into this new query
  currentResSpan = null;
  isGenerating = true;
  if (setGenerating) setGenerating(true);

  const contextData = await getQuestionContext();
  let finalQuery = text;
  let questionImages = [];
  let choiceImages = [];

  // Assemble system prompt from active block composition
  const systemPrompt = assemblePrompt(activeComposition);

  if (contextData) {
    const contextString = formatContextString(contextData);
    const extracted = await extractAllImages(contextData);
    questionImages = extracted.questionImages;
    choiceImages = extracted.choiceImages;
    const totalImgs = questionImages.length + choiceImages.length;
    const blindNote = blindMode ? '[BLIND MODE: Answer choices have been hidden from context.]\n\n' : '';
    const imageNote = totalImgs > 0
      ? `[Note: ${questionImages.length} question diagram(s) and ${choiceImages.length} answer choice image(s) are attached. If the text context above contains structural information like adjacency lists, edge weights, or equations, PRIORITIZE the text description — it is more reliable than visual inference for dense technical diagrams.]\n\n`
      : '';
    finalQuery = `Context from current page:\n${contextString}\n\n${blindNote}${imageNote}User Question:\n${text}`;
  }

  // Manual upload is prepended to question images
  if (currentImageDataUrl) {
    questionImages = [currentImageDataUrl, ...questionImages].slice(0, MAX_IMAGES);
    currentImageDataUrl = null;
    const preview = document.getElementById('boiler-tai-image-preview');
    if (preview) preview.style.display = 'none';
    const fileInput = document.getElementById('boiler-tai-image-input');
    if (fileInput) fileInput.value = '';
  }

  const hasImages = questionImages.length > 0 || choiceImages.length > 0;
  const payload = { query: finalQuery, systemPrompt };
  const totalAttached = questionImages.length + choiceImages.length;
  if (totalAttached > 0) {
    payload.questionImages = questionImages;
    payload.choiceImages = choiceImages;
    const visionNote = isVisionReady
      ? ` [Routed to vision model]`
      : ` [Vision model not loaded — images may be ignored by primary model]`;
    addMessage(`System: Attached ${questionImages.length} question image(s) + ${choiceImages.length} answer choice image(s).${blindMode ? ' [Blind mode: choices hidden]' : ''}${visionNote}`);
  }

  contentPort.postMessage({
    type: 'query',
    payload
  });
}

function parseMarkdown(text) {
  if (!text) return "";
  try {
    return marked.parse(text);
  } catch (e) {
    console.error("Markdown parse error:", e);
    return text;
  }
}

function createMessageWrapper(isUser, isSystem, initialText = "") {
  const wrapper = document.createElement('div');
  wrapper.style.padding = '8px 12px';
  wrapper.style.borderRadius = '15px';
  wrapper.style.maxWidth = '80%';
  wrapper.style.wordWrap = 'break-word';
  wrapper.style.lineHeight = '1.4';
  wrapper.style.position = 'relative';

  if (isSystem) {
    wrapper.style.alignSelf = 'center';
    wrapper.style.fontSize = '0.85em';
    wrapper.style.color = '#666';
    wrapper.style.background = 'none';
  } else if (isUser) {
    wrapper.style.alignSelf = 'flex-end';
    wrapper.style.background = '#000';
    wrapper.style.color = '#fff';
  } else {
    wrapper.style.alignSelf = 'flex-start';
    wrapper.style.background = '#f1f1f1';
    wrapper.style.color = '#000';
    wrapper.style.fontFamily = 'monospace, sans-serif';
  }

  wrapper._rawText = initialText;

  let prefix = null;
  if (!isUser && !isSystem) {
    prefix = document.createElement('b');
    prefix.innerText = 'TA: ';
    wrapper.appendChild(prefix);
  }

  const contentSpan = document.createElement('span');
  contentSpan.className = "boiler-tai-md-wrapper";
  contentSpan.innerHTML = parseMarkdown(initialText);
  wrapper.appendChild(contentSpan);

  if (!isSystem) {
    const actionMenu = document.createElement('div');
    actionMenu.style.position = 'absolute';
    actionMenu.style.top = '-10px';
    actionMenu.style.right = isUser ? 'auto' : '10px';
    actionMenu.style.left = isUser ? '-10px' : 'auto';
    actionMenu.style.background = '#fff';
    actionMenu.style.color = '#000';
    actionMenu.style.border = '1px solid #ccc';
    actionMenu.style.borderRadius = '5px';
    actionMenu.style.padding = '2px 5px';
    actionMenu.style.display = 'none';
    actionMenu.style.gap = '5px';
    actionMenu.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
    actionMenu.style.zIndex = '10';

    const editBtn = document.createElement('span');
    editBtn.innerText = '✏️';
    editBtn.style.cursor = 'pointer';
    editBtn.title = 'Edit';

    const delBtn = document.createElement('span');
    delBtn.innerText = '🗑️';
    delBtn.style.cursor = 'pointer';
    delBtn.title = 'Delete';

    actionMenu.appendChild(editBtn);
    actionMenu.appendChild(delBtn);
    wrapper.appendChild(actionMenu);

    wrapper.addEventListener('mouseenter', () => actionMenu.style.display = 'flex');
    wrapper.addEventListener('mouseleave', () => actionMenu.style.display = 'none');

    delBtn.addEventListener('click', () => wrapper.remove());

    const editContainer = document.createElement('div');
    editContainer.style.display = 'none';
    editContainer.style.flexDirection = 'column';
    editContainer.style.gap = '5px';
    editContainer.style.marginTop = '5px';

    const textarea = document.createElement('textarea');
    textarea.style.width = '100%';
    textarea.style.resize = 'vertical';
    textarea.style.minHeight = '60px';
    textarea.style.fontFamily = 'inherit';
    textarea.style.padding = '5px';
    textarea.style.color = '#000';

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.gap = '5px';

    const cancelBtn = document.createElement('button');
    cancelBtn.innerText = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.innerText = 'Save';

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    editContainer.appendChild(textarea);
    editContainer.appendChild(btnRow);
    wrapper.appendChild(editContainer);

    Object.assign(cancelBtn.style, { cursor: 'pointer', padding: '2px 6px' });
    Object.assign(saveBtn.style, { cursor: 'pointer', padding: '2px 6px', background: '#007bff', color: '#fff', border: 'none', borderRadius: '3px' });

    editBtn.addEventListener('click', () => {
      actionMenu.style.display = 'none';
      if (prefix) prefix.style.display = 'none';
      contentSpan.style.display = 'none';

      textarea.value = wrapper._rawText;
      editContainer.style.display = 'flex';
    });

    cancelBtn.addEventListener('click', () => {
      editContainer.style.display = 'none';
      if (prefix) prefix.style.display = 'inline';
      contentSpan.style.display = 'inline';
    });

    saveBtn.addEventListener('click', () => {
      wrapper._rawText = textarea.value;
      contentSpan.innerHTML = parseMarkdown(textarea.value);

      editContainer.style.display = 'none';
      if (prefix) prefix.style.display = 'inline';
      contentSpan.style.display = 'inline';
    });
  }

  return { wrapper, contentSpan };
}

function handleResult(payload) {
  if (!currentResSpan) {
    const { wrapper, contentSpan } = createMessageWrapper(false, false, "");
    currentResSpan = contentSpan;
    currentResSpan._parentNode = wrapper;

    const msgList = document.getElementById('boiler-tai-msg-list');
    msgList.appendChild(wrapper);
    msgList.scrollTop = msgList.scrollHeight;
  }

  const wrapper = currentResSpan._parentNode;
  wrapper._rawText += payload.partialResults || '';
  currentResSpan.innerHTML = parseMarkdown(wrapper._rawText);

  const msgList = document.getElementById('boiler-tai-msg-list');
  msgList.scrollTop = msgList.scrollHeight;

  if (payload.complete) {
    currentResSpan = null;
    isGenerating = false;
    if (setGenerating) setGenerating(false);
  }
}

function addMessage(text) {
  const msgList = document.getElementById('boiler-tai-msg-list');
  if (!msgList) return;

  const isUser = text.startsWith("You:");
  const isSystem = text.startsWith("System:");
  const { wrapper } = createMessageWrapper(isUser, isSystem, text);

  msgList.appendChild(wrapper);
  msgList.scrollTop = msgList.scrollHeight;
}

// UI Setup
function injectUI() {
  if (document.getElementById('boiler-tai-container')) return;

  // Ensure KaTeX styles are present in the document
  if (!document.getElementById('katex-css')) {
    const link = document.createElement('link');
    link.id = 'katex-css';
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css';
    document.head.appendChild(link);
  }

  const style = document.createElement('style');
  style.textContent = `
    .boiler-tai-md-wrapper p { margin: 0; padding: 0 0 8px 0; }
    .boiler-tai-md-wrapper p:last-child { padding-bottom: 0; }
    .boiler-tai-md-wrapper pre { background: #333; color: #fff; padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; }
    .boiler-tai-md-wrapper code { background: #eee; border-radius: 4px; padding: 2px 4px; font-family: monospace; }
  `;
  document.head.appendChild(style);

  // Create toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'boiler-tai-toggle';
  toggleBtn.style.position = 'fixed';
  toggleBtn.style.bottom = '20px';
  toggleBtn.style.right = '20px';
  toggleBtn.style.zIndex = '999999';
  toggleBtn.style.fontFamily = 'system-ui, -apple-system, sans-serif';
  toggleBtn.innerText = 'Boiler Tai';
  toggleBtn.style.padding = '12px 24px';
  toggleBtn.style.borderRadius = '24px';
  toggleBtn.style.border = 'none';
  toggleBtn.style.background = '#ceb888';
  toggleBtn.style.color = '#000';
  toggleBtn.style.cursor = 'pointer';
  toggleBtn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  toggleBtn.style.fontWeight = 'bold';
  toggleBtn.style.fontSize = '16px';
  toggleBtn.style.transition = 'transform 0.2s';
  toggleBtn.onmouseover = () => toggleBtn.style.transform = 'scale(1.05)';
  toggleBtn.onmouseout = () => toggleBtn.style.transform = 'scale(1)';
  document.body.appendChild(toggleBtn);

  // Create chat window
  const chatWindow = document.createElement('div');
  chatWindow.id = 'boiler-tai-container';
  chatWindow.style.display = 'none';
  chatWindow.style.flexDirection = 'column';
  chatWindow.style.width = '350px';
  chatWindow.style.height = '500px';
  chatWindow.style.background = '#fff';
  chatWindow.style.border = '1px solid #e0e0e0';
  chatWindow.style.borderRadius = '12px';
  chatWindow.style.boxShadow = '0 8px 24px rgba(0,0,0,0.15)';
  chatWindow.style.position = 'fixed';
  chatWindow.style.bottom = '80px';
  chatWindow.style.right = '20px';
  chatWindow.style.zIndex = '999999';
  chatWindow.style.fontFamily = 'system-ui, -apple-system, sans-serif';
  chatWindow.style.minWidth = '280px';
  chatWindow.style.minHeight = '350px';
  chatWindow.style.boxSizing = 'border-box';

  // Explicit DOM Resizers
  const edgeSize = 10;
  const resizers = {
    top: { cursor: 'ns-resize', w: '100%', h: edgeSize + 'px', t: -edgeSize / 2, l: 0 },
    right: { cursor: 'ew-resize', w: edgeSize + 'px', h: '100%', t: 0, r: -edgeSize / 2 },
    bottom: { cursor: 'ns-resize', w: '100%', h: edgeSize + 'px', b: -edgeSize / 2, l: 0 },
    left: { cursor: 'ew-resize', w: edgeSize + 'px', h: '100%', t: 0, l: -edgeSize / 2 },
    topleft: { cursor: 'nwse-resize', w: edgeSize * 2 + 'px', h: edgeSize * 2 + 'px', t: -edgeSize, l: -edgeSize, z: 2 },
    topright: { cursor: 'nesw-resize', w: edgeSize * 2 + 'px', h: edgeSize * 2 + 'px', t: -edgeSize, r: -edgeSize, z: 2 },
    bottomleft: { cursor: 'nesw-resize', w: edgeSize * 2 + 'px', h: edgeSize * 2 + 'px', b: -edgeSize, l: -edgeSize, z: 2 },
    bottomright: { cursor: 'nwse-resize', w: edgeSize * 2 + 'px', h: edgeSize * 2 + 'px', b: -edgeSize, r: -edgeSize, z: 2 }
  };

  Object.keys(resizers).forEach(key => {
    const props = resizers[key];
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.cursor = props.cursor;
    el.style.width = props.w;
    el.style.height = props.h;
    if ('t' in props) el.style.top = props.t + 'px';
    if ('b' in props) el.style.bottom = props.b + 'px';
    if ('l' in props) el.style.left = props.l + 'px';
    if ('r' in props) el.style.right = props.r + 'px';
    if ('z' in props) el.style.zIndex = props.z;
    else el.style.zIndex = '1';
    el.style.background = 'transparent';
    chatWindow.appendChild(el);

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;

      const rect = chatWindow.getBoundingClientRect();
      const startW = rect.width;
      const startH = rect.height;
      const startL = rect.left;
      const startT = rect.top;

      chatWindow.style.bottom = 'auto';
      chatWindow.style.right = 'auto';
      chatWindow.style.left = startL + 'px';
      chatWindow.style.top = startT + 'px';

      const onMouseMove = (moveEvent) => {
        let newW = startW, newH = startH, newL = startL, newT = startT;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        if (key.includes('right') || key === 'right') newW = startW + dx;
        if (key.includes('left') || key === 'left') { newW = startW - dx; newL = startL + dx; }
        if (key.includes('bottom') || key === 'bottom') newH = startH + dy;
        if (key.includes('top') || key === 'top') { newH = startH - dy; newT = startT + dy; }

        if (newW > 280) {
          chatWindow.style.width = newW + 'px';
          if (newL !== startL) chatWindow.style.left = newL + 'px';
        }
        if (newH > 350) {
          chatWindow.style.height = newH + 'px';
          if (newT !== startT) chatWindow.style.top = newT + 'px';
        }
      };

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  });

  // Chat header
  const header = document.createElement('div');
  header.style.background = '#000';
  header.style.color = '#ceb888';
  header.style.padding = '12px 16px';
  header.style.textAlign = 'center';
  header.style.fontWeight = 'bold';
  header.style.fontSize = '16px';
  header.style.cursor = 'grab';
  header.style.userSelect = 'none';
  header.style.boxSizing = 'border-box';
  header.style.borderRadius = '12px 12px 0 0';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.gap = '4px';

  const titleSpan = document.createElement('span');
  titleSpan.innerText = 'Boiler Tai';
  titleSpan.style.fontWeight = 'bold';
  titleSpan.style.fontSize = '16px';

  const tabRow = document.createElement('div');
  tabRow.style.display = 'flex';
  tabRow.style.gap = '4px';

  const chatTab = document.createElement('button');
  chatTab.innerText = '💬 Chat';
  const padTab = document.createElement('button');
  padTab.innerText = '✏️ Pad';

  const tabStyle = (btn, active) => {
    btn.style.padding = '4px 10px';
    btn.style.border = 'none';
    btn.style.borderRadius = '8px';
    btn.style.cursor = 'pointer';
    btn.style.fontWeight = '600';
    btn.style.fontSize = '12px';
    btn.style.transition = 'background 0.2s';
    btn.style.background = active ? '#ceb888' : 'rgba(255,255,255,0.15)';
    btn.style.color = active ? '#000' : '#ceb888';
  };
  tabStyle(chatTab, true);
  tabStyle(padTab, false);
  tabRow.appendChild(chatTab);
  tabRow.appendChild(padTab);

  // Blind mode toggle button
  const blindBtn = document.createElement('button');
  const updateBlindBtn = () => {
    blindBtn.textContent = blindMode ? '🙈' : '👁';
    blindBtn.title = blindMode ? 'Blind mode ON (click to show answers)' : 'Blind mode OFF (click to hide answers)';
    blindBtn.style.background = blindMode ? '#ceb888' : 'rgba(255,255,255,0.15)';
    blindBtn.style.color = blindMode ? '#000' : '#ceb888';
  };
  blindBtn.style.padding = '4px 8px';
  blindBtn.style.border = 'none';
  blindBtn.style.borderRadius = '8px';
  blindBtn.style.cursor = 'pointer';
  blindBtn.style.fontSize = '14px';
  blindBtn.style.transition = 'background 0.2s';
  blindBtn.addEventListener('mousedown', e => e.stopPropagation());
  blindBtn.addEventListener('click', () => {
    blindMode = !blindMode;
    chrome.storage.local.set({ btBlindMode: blindMode });
    updateBlindBtn();
  });
  updateBlindBtn();

  // Prompt tab (added to tabRow)
  const promptTab = document.createElement('button');
  promptTab.innerText = '🧩';
  promptTab.title = 'Prompt Composer';
  tabStyle(promptTab, false);
  promptTab.addEventListener('mousedown', e => e.stopPropagation());
  tabRow.appendChild(promptTab);

  header.appendChild(titleSpan);
  header.appendChild(tabRow);
  header.appendChild(blindBtn);

  // Drag logic
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    header.style.cursor = 'grabbing';

    // Switch from bottom/right to top/left if not already
    const rect = chatWindow.getBoundingClientRect();
    chatWindow.style.bottom = 'auto';
    chatWindow.style.right = 'auto';
    chatWindow.style.top = rect.top + 'px';
    chatWindow.style.left = rect.left + 'px';

    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    chatWindow.style.left = (e.clientX - dragOffsetX) + 'px';
    chatWindow.style.top = (e.clientY - dragOffsetY) + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      header.style.cursor = 'grab';
    }
  });

  // Controls (model loading)
  const controlsDiv = document.createElement('div');
  controlsDiv.style.padding = '10px';
  controlsDiv.style.background = '#f9f9f9';
  controlsDiv.style.borderBottom = '1px solid #eee';
  controlsDiv.style.display = 'flex';
  controlsDiv.style.gap = '8px';
  controlsDiv.style.boxSizing = 'border-box';

  // — Primary model row —
  const primaryRow = document.createElement('div');
  primaryRow.style.display = 'flex';
  primaryRow.style.gap = '8px';
  primaryRow.style.width = '100%';

  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.value = 'gemma-4-E2B-it-web.task';
  modelInput.style.flex = '1';
  modelInput.style.padding = '8px';
  modelInput.style.border = '1px solid #ccc';
  modelInput.style.borderRadius = '6px';
  modelInput.style.fontSize = '12px';
  modelInput.style.boxSizing = 'border-box';
  modelInput.style.minWidth = '0';

  const loadBtn = document.createElement('button');
  loadBtn.innerText = 'Load';
  loadBtn.style.padding = '8px 16px';
  loadBtn.style.background = '#ceb888';
  loadBtn.style.color = '#000';
  loadBtn.style.border = 'none';
  loadBtn.style.borderRadius = '6px';
  loadBtn.style.cursor = 'pointer';
  loadBtn.style.fontWeight = 'bold';
  loadBtn.style.flexShrink = '0';

  primaryRow.appendChild(modelInput);
  primaryRow.appendChild(loadBtn);

  // — Vision supplement row —
  const visionRow = document.createElement('div');
  visionRow.style.display = 'flex';
  visionRow.style.gap = '6px';
  visionRow.style.alignItems = 'center';
  visionRow.style.width = '100%';
  visionRow.style.marginTop = '4px';

  const visionCheckbox = document.createElement('input');
  visionCheckbox.type = 'checkbox';
  visionCheckbox.id = 'boiler-tai-vision-toggle';
  visionCheckbox.title = 'Load Gemma 3n as a vision supplement for image queries';
  visionCheckbox.style.cursor = 'pointer';
  visionCheckbox.style.flexShrink = '0';
  visionCheckbox.style.accentColor = '#ceb888';

  const visionLabel = document.createElement('label');
  visionLabel.htmlFor = 'boiler-tai-vision-toggle';
  visionLabel.innerText = '🖼 Vision:';
  visionLabel.style.fontSize = '11px';
  visionLabel.style.color = '#555';
  visionLabel.style.cursor = 'pointer';
  visionLabel.style.flexShrink = '0';
  visionLabel.style.userSelect = 'none';

  const visionInput = document.createElement('input');
  visionInput.type = 'text';
  visionInput.value = 'gemma-3n-E2B-it-int4-Web.litertlm';
  visionInput.style.flex = '1';
  visionInput.style.padding = '6px 8px';
  visionInput.style.border = '1px solid #ccc';
  visionInput.style.borderRadius = '6px';
  visionInput.style.fontSize = '11px';
  visionInput.style.boxSizing = 'border-box';
  visionInput.style.minWidth = '0';
  visionInput.style.opacity = '0.45';
  visionInput.style.transition = 'opacity 0.2s';
  visionInput.disabled = true;

  // Enable/disable the vision model input based on checkbox
  visionCheckbox.addEventListener('change', () => {
    visionInput.disabled = !visionCheckbox.checked;
    visionInput.style.opacity = visionCheckbox.checked ? '1' : '0.45';
  });

  visionRow.appendChild(visionCheckbox);
  visionRow.appendChild(visionLabel);
  visionRow.appendChild(visionInput);

  controlsDiv.style.flexDirection = 'column';
  controlsDiv.appendChild(primaryRow);
  controlsDiv.appendChild(visionRow);

  // Message list
  const msgList = document.createElement('div');
  msgList.id = 'boiler-tai-msg-list';
  msgList.style.flex = '1';
  msgList.style.padding = '16px';
  msgList.style.overflowY = 'auto';
  msgList.style.display = 'flex';
  msgList.style.flexDirection = 'column';
  msgList.style.gap = '12px';
  msgList.style.background = '#ffffff';
  msgList.style.boxSizing = 'border-box';

  // Input area
  const inputArea = document.createElement('div');
  inputArea.style.padding = '12px';
  inputArea.style.borderTop = '1px solid #eee';
  inputArea.style.display = 'flex';
  inputArea.style.flexDirection = 'column';
  inputArea.style.gap = '8px';
  inputArea.style.background = '#fafafa';
  inputArea.style.boxSizing = 'border-box';
  inputArea.style.borderRadius = '0 0 12px 12px';

  const previewImg = document.createElement('img');
  previewImg.id = 'boiler-tai-image-preview';
  previewImg.style.display = 'none';
  previewImg.style.maxWidth = '100px';
  previewImg.style.maxHeight = '100px';
  previewImg.style.borderRadius = '8px';
  previewImg.style.objectFit = 'cover';

  const rowDiv = document.createElement('div');
  rowDiv.style.display = 'flex';
  rowDiv.style.gap = '8px';
  rowDiv.style.alignItems = 'center';
  rowDiv.style.boxSizing = 'border-box';
  rowDiv.style.width = '100%';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'boiler-tai-image-input';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        currentImageDataUrl = ev.target.result;
        previewImg.src = currentImageDataUrl;
        previewImg.style.display = 'block';
      };
      reader.readAsDataURL(file);
    }
  };

  const uploadBtn = document.createElement('button');
  uploadBtn.innerText = '📷';
  uploadBtn.title = 'Upload Image';
  uploadBtn.style.padding = '8px';
  uploadBtn.style.background = 'none';
  uploadBtn.style.border = 'none';
  uploadBtn.style.fontSize = '18px';
  uploadBtn.style.cursor = 'pointer';
  uploadBtn.onclick = () => fileInput.click();

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.placeholder = 'Ask a question...';
  textInput.style.flex = '1';
  textInput.style.padding = '10px 14px';
  textInput.style.border = '1px solid #ddd';
  textInput.style.borderRadius = '20px';
  textInput.style.outline = 'none';
  textInput.style.boxSizing = 'border-box';
  textInput.style.minWidth = '0';

  const sendBtn = document.createElement('button');
  sendBtn.innerText = 'Send';
  sendBtn.style.padding = '10px 16px';
  sendBtn.style.background = '#000';
  sendBtn.style.color = '#ceb888';
  sendBtn.style.border = 'none';
  sendBtn.style.borderRadius = '20px';
  sendBtn.style.cursor = 'pointer';
  sendBtn.style.fontWeight = 'bold';

  const stopBtn = document.createElement('button');
  stopBtn.innerText = '⏹';
  stopBtn.title = 'Stop generation';
  stopBtn.style.padding = '10px 14px';
  stopBtn.style.background = '#c0392b';
  stopBtn.style.color = '#fff';
  stopBtn.style.border = 'none';
  stopBtn.style.borderRadius = '20px';
  stopBtn.style.cursor = 'pointer';
  stopBtn.style.fontWeight = 'bold';
  stopBtn.style.display = 'none';
  stopBtn.onclick = () => {
    if (contentPort) contentPort.postMessage({ type: 'cancel' });
    currentResSpan = null;
    isGenerating = false;
    setGenerating(false);
  };

  // Wire up the generating toggle once both buttons exist
  setGenerating = (generating) => {
    sendBtn.style.display = generating ? 'none' : 'inline-block';
    stopBtn.style.display = generating ? 'inline-block' : 'none';
  };

  rowDiv.appendChild(uploadBtn);
  rowDiv.appendChild(textInput);
  rowDiv.appendChild(sendBtn);
  rowDiv.appendChild(stopBtn);

  inputArea.appendChild(previewImg);
  inputArea.appendChild(rowDiv);
  inputArea.appendChild(fileInput);

  // --- Chat content wrapper ---
  const chatContent = document.createElement('div');
  chatContent.style.display = 'flex';
  chatContent.style.flexDirection = 'column';
  chatContent.style.flex = '1';
  chatContent.style.overflow = 'hidden';
  chatContent.appendChild(msgList);
  chatContent.appendChild(inputArea);

  // --- Scratchpad content ---
  const scratchpadContent = document.createElement('div');
  scratchpadContent.style.display = 'none';
  scratchpadContent.style.flexDirection = 'column';
  scratchpadContent.style.flex = '1';
  scratchpadContent.style.overflow = 'hidden';
  scratchpadContent.style.boxSizing = 'border-box';

  // Scratchpad toolbar
  const spToolbar = document.createElement('div');
  spToolbar.style.display = 'flex';
  spToolbar.style.gap = '6px';
  spToolbar.style.padding = '8px 10px';
  spToolbar.style.borderBottom = '1px solid #eee';
  spToolbar.style.alignItems = 'center';
  spToolbar.style.background = '#f9f9f9';
  spToolbar.style.boxSizing = 'border-box';
  spToolbar.style.flexWrap = 'wrap';

  const modeTypeBtn = document.createElement('button');
  modeTypeBtn.innerText = '⌨️ Type';
  const modeDrawBtn = document.createElement('button');
  modeDrawBtn.innerText = '🖊️ Draw';

  const spBtnStyle = (btn, active) => {
    Object.assign(btn.style, {
      padding: '4px 10px', border: '1px solid #ccc', borderRadius: '6px',
      cursor: 'pointer', fontWeight: '600', fontSize: '12px',
      background: active ? '#000' : '#fff', color: active ? '#ceb888' : '#333'
    });
  };
  spBtnStyle(modeTypeBtn, true);
  spBtnStyle(modeDrawBtn, false);

  // Draw sub-tools (hidden in type mode)
  const drawTools = document.createElement('div');
  drawTools.style.display = 'none';
  drawTools.style.gap = '6px';
  drawTools.style.alignItems = 'center';

  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.value = '#000000';
  colorPicker.title = 'Pen Color';
  colorPicker.style.width = '28px';
  colorPicker.style.height = '28px';
  colorPicker.style.border = 'none';
  colorPicker.style.cursor = 'pointer';
  colorPicker.style.padding = '0';

  const eraserBtn = document.createElement('button');
  eraserBtn.innerText = '🧹';
  eraserBtn.title = 'Eraser';
  eraserBtn.style.padding = '4px 8px';
  eraserBtn.style.border = '1px solid #ccc';
  eraserBtn.style.borderRadius = '6px';
  eraserBtn.style.cursor = 'pointer';
  eraserBtn.style.fontSize = '14px';

  const clearBtn = document.createElement('button');
  clearBtn.innerText = '🗑️ Clear';
  clearBtn.style.padding = '4px 8px';
  clearBtn.style.border = '1px solid #ccc';
  clearBtn.style.borderRadius = '6px';
  clearBtn.style.cursor = 'pointer';
  clearBtn.style.fontSize = '12px';

  drawTools.appendChild(colorPicker);
  drawTools.appendChild(eraserBtn);
  drawTools.appendChild(clearBtn);

  spToolbar.appendChild(modeTypeBtn);
  spToolbar.appendChild(modeDrawBtn);
  spToolbar.appendChild(drawTools);

  // Type mode area
  const typeArea = document.createElement('textarea');
  typeArea.placeholder = 'Write your work here (equations, steps, notes)...';
  typeArea.style.flex = '1';
  typeArea.style.padding = '12px';
  typeArea.style.border = 'none';
  typeArea.style.outline = 'none';
  typeArea.style.resize = 'none';
  typeArea.style.fontFamily = 'monospace, sans-serif';
  typeArea.style.fontSize = '14px';
  typeArea.style.background = '#fffef5';
  typeArea.style.color = '#000';
  typeArea.style.boxSizing = 'border-box';
  typeArea.style.lineHeight = '1.6';

  // Draw mode area
  const canvasWrapper = document.createElement('div');
  canvasWrapper.style.flex = '1';
  canvasWrapper.style.display = 'none';
  canvasWrapper.style.overflow = 'hidden';
  canvasWrapper.style.background = '#fff';
  canvasWrapper.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.cursor = 'crosshair';
  canvas.style.touchAction = 'none';
  canvasWrapper.appendChild(canvas);

  // Resize canvas to wrapper when shown
  const resizeCanvas = () => {
    const r = canvasWrapper.getBoundingClientRect();
    const imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = r.width;
    canvas.height = r.height;
    canvas.getContext('2d').putImageData(imgData, 0, 0);
  };

  // Drawing state
  let drawing = false;
  let erasing = false;
  let lastX = 0, lastY = 0;

  eraserBtn.addEventListener('click', () => {
    erasing = !erasing;
    eraserBtn.style.background = erasing ? '#000' : '';
    eraserBtn.style.color = erasing ? '#fff' : '';
  });

  clearBtn.addEventListener('click', () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  const getPos = (e) => {
    const r = canvas.getBoundingClientRect();
    if (e.touches) return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const startDraw = (e) => {
    drawing = true;
    const pos = getPos(e);
    lastX = pos.x; lastY = pos.y;
    e.preventDefault();
  };

  const draw = (e) => {
    if (!drawing) return;
    const ctx = canvas.getContext('2d');
    const pos = getPos(e);
    ctx.lineWidth = erasing ? 20 : 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = erasing ? '#fff' : colorPicker.value;
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastX = pos.x; lastY = pos.y;
    e.preventDefault();
  };

  const stopDraw = () => { drawing = false; };

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('mouseleave', stopDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', draw, { passive: false });
  canvas.addEventListener('touchend', stopDraw);

  // Mode switching
  let spMode = 'type';
  modeTypeBtn.addEventListener('click', () => {
    spMode = 'type';
    typeArea.style.display = 'block';
    canvasWrapper.style.display = 'none';
    drawTools.style.display = 'none';
    spBtnStyle(modeTypeBtn, true);
    spBtnStyle(modeDrawBtn, false);
  });

  modeDrawBtn.addEventListener('click', () => {
    spMode = 'draw';
    typeArea.style.display = 'none';
    canvasWrapper.style.display = 'block';
    drawTools.style.display = 'flex';
    spBtnStyle(modeDrawBtn, true);
    spBtnStyle(modeTypeBtn, false);
    setTimeout(resizeCanvas, 50);
  });

  // Scratchpad grade area
  const spBottom = document.createElement('div');
  spBottom.style.padding = '10px';
  spBottom.style.borderTop = '1px solid #eee';
  spBottom.style.background = '#fafafa';
  spBottom.style.boxSizing = 'border-box';
  spBottom.style.display = 'flex';
  spBottom.style.gap = '8px';
  spBottom.style.alignItems = 'center';
  spBottom.style.borderRadius = '0 0 12px 12px';

  const gradeHint = document.createElement('span');
  gradeHint.innerText = 'Send work to AI for grading';
  gradeHint.style.flex = '1';
  gradeHint.style.fontSize = '12px';
  gradeHint.style.color = '#888';

  const gradeBtn = document.createElement('button');
  gradeBtn.innerText = '📝 Grade';
  gradeBtn.style.padding = '8px 16px';
  gradeBtn.style.background = '#ceb888';
  gradeBtn.style.color = '#000';
  gradeBtn.style.border = 'none';
  gradeBtn.style.borderRadius = '10px';
  gradeBtn.style.cursor = 'pointer';
  gradeBtn.style.fontWeight = 'bold';
  gradeBtn.style.fontSize = '13px';

  spBottom.appendChild(gradeHint);
  spBottom.appendChild(gradeBtn);

  scratchpadContent.appendChild(spToolbar);
  scratchpadContent.appendChild(typeArea);
  scratchpadContent.appendChild(canvasWrapper);
  scratchpadContent.appendChild(spBottom);

  // Grade handler
  gradeBtn.addEventListener('click', async () => {
    if (!isModelReady) {
      addMessage('System: Please load a model first.');
      // Switch to chat tab to show message
      chatTab.click();
      return;
    }

    const contextData = await getQuestionContext();
    const contextString = contextData ? formatContextString(contextData) : '';

    let gradePrompt = 'Please grade this student\'s work.';
    if (contextString) {
      gradePrompt += `\n\nQuestion context:\n${contextString}`;
    }

    let imageDataUrl = null;

    if (spMode === 'type') {
      const workText = typeArea.value.trim();
      if (!workText) { addMessage('System: Scratchpad is empty.'); chatTab.click(); return; }
      gradePrompt += `\n\nStudent\'s typed work:\n${workText}\n\nProvide: whether it is correct, any key mistakes, and a brief explanation.`;
    } else {
      // Check if canvas has any content
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hasContent = pixels.some(v => v !== 0);
      if (!hasContent) { addMessage('System: Canvas is blank.'); chatTab.click(); return; }
      imageDataUrl = canvas.toDataURL('image/png');
      gradePrompt += '\n\nThe student\'s hand-drawn work is attached as an image. Please evaluate it.\n\nProvide: whether it is correct, any key mistakes, and a brief explanation.';
    }

    // Send to LLM
    addMessage('You: [Submitted scratchpad work for grading]');
    chatTab.click(); // Switch to chat to see response

    // temporarily override image for this query
    if (imageDataUrl) currentImageDataUrl = imageDataUrl;
    await queryModel(gradePrompt);
  });

  // ─── Prompt Composer Panel ─────────────────────────────────────────────
  const promptPanel = document.createElement('div');
  promptPanel.style.cssText = 'display:none;flex-direction:column;height:100%;background:#111;color:#e0e0e0;font-size:12px;overflow:hidden;';

  function makeSection(titleText, flex) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;flex:' + flex + ';overflow:hidden;border-bottom:1px solid #333;min-height:0;';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:5px 10px;font-weight:700;font-size:10px;color:#ceb888;background:#1a1a1a;letter-spacing:.5px;text-transform:uppercase;flex-shrink:0;';
    hdr.textContent = titleText;
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:2px 0;min-height:0;';
    wrap.appendChild(hdr);
    wrap.appendChild(body);
    return { wrap, body };
  }

  const libSec = makeSection('Library', 1);
  const treeSec = makeSection('Active Composition', 1);

  // ── Library ──
  function renderLibrary() {
    libSec.body.innerHTML = '';
    const byCat = {};
    BLOCK_IDS.forEach(id => {
      const b = blockRegistry[id]; if (!b) return;
      (byCat[b.category] = byCat[b.category] || []).push(b);
    });
    Object.entries(CATEGORY_LABELS).forEach(([cat, label]) => {
      if (!byCat[cat]) return;
      const catEl = document.createElement('div');
      catEl.style.cssText = 'padding:3px 10px 1px;font-size:10px;color:#777;font-weight:700;';
      catEl.textContent = label;
      libSec.body.appendChild(catEl);
      byCat[cat].forEach(block => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:3px 10px;cursor:grab;border-radius:5px;margin:1px 3px;';
        row.draggable = true;
        row.title = block.description || '';
        row.onmouseover = () => row.style.background = '#1e1e1e';
        row.onmouseout = () => row.style.background = '';
        const grip = document.createElement('span'); grip.textContent = '\u2261'; grip.style.cssText = 'color:#555;font-size:13px;';
        const name = document.createElement('span'); name.textContent = block.name; name.style.cssText = 'flex:1;font-size:11px;';
        const addBtn = document.createElement('button');
        addBtn.textContent = '+';
        addBtn.style.cssText = 'padding:0 5px;border:none;border-radius:4px;background:#ceb888;color:#000;cursor:pointer;font-weight:700;font-size:12px;flex-shrink:0;';
        addBtn.onmousedown = e => e.stopPropagation();
        addBtn.onclick = e => {
          e.stopPropagation();
          const indent = activeComposition.length ? activeComposition[activeComposition.length - 1].indent : 0;
          activeComposition.push({ id: block.id, indent });
          chrome.storage.local.set({ btComposition: JSON.stringify(activeComposition) });
          renderTree();
        };
        row.ondragstart = e => {
          e.dataTransfer.setData('btBlockId', block.id);
          e.dataTransfer.setData('btSource', 'library');
          e.dataTransfer.effectAllowed = 'copy';
        };
        row.appendChild(grip); row.appendChild(name); row.appendChild(addBtn);
        libSec.body.appendChild(row);
      });
    });
  }

  // ── Tree ──
  let dragSrcIdx = -1;
  function saveComp() { chrome.storage.local.set({ btComposition: JSON.stringify(activeComposition) }); }

  function renderTree() {
    treeSec.body.innerHTML = '';
    if (!activeComposition.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px;color:#444;font-style:italic;font-size:11px;';
      empty.textContent = 'Drag blocks from library or click + to add.';
      treeSec.body.appendChild(empty);
    }
    activeComposition.forEach((item, idx) => {
      const block = blockRegistry[item.id]; if (!block) return;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:3px;padding:3px 6px;border-radius:5px;margin:1px 3px;cursor:grab;margin-left:' + (6 + item.indent * 14) + 'px;';
      row.draggable = true;
      row.onmouseover = () => row.style.background = '#1d1d1d';
      row.onmouseout = () => row.style.background = '';
      row.ondragstart = e => {
        dragSrcIdx = idx;
        e.dataTransfer.setData('btBlockId', item.id); e.dataTransfer.setData('btSource', 'tree');
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => row.style.opacity = '0.4', 0);
      };
      row.ondragend = () => row.style.opacity = '';
      row.ondragover = e => { e.preventDefault(); row.style.background = '#2a2a2a'; };
      row.ondragleave = () => row.style.background = '';
      row.ondrop = e => {
        e.preventDefault(); row.style.background = '';
        const src = e.dataTransfer.getData('btSource');
        const bid = e.dataTransfer.getData('btBlockId');
        if (src === 'tree' && dragSrcIdx !== -1 && dragSrcIdx !== idx) {
          const [m] = activeComposition.splice(dragSrcIdx, 1);
          activeComposition.splice(dragSrcIdx < idx ? idx - 1 : idx, 0, m);
          dragSrcIdx = -1;
        } else if (src === 'library') {
          activeComposition.splice(idx, 0, { id: bid, indent: item.indent });
        }
        saveComp(); renderTree();
      };
      const grip = document.createElement('span'); grip.textContent = '\u2261'; grip.style.cssText = 'color:#555;font-size:13px;flex-shrink:0;';
      const badge = document.createElement('span'); badge.textContent = block.category; badge.style.cssText = 'font-size:9px;padding:1px 3px;border-radius:3px;background:#2a2a2a;color:#999;flex-shrink:0;';
      const name = document.createElement('span'); name.textContent = block.name; name.style.cssText = 'flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const mkIB = (t, tip, fn) => {
        const b = document.createElement('button');
        b.textContent = t; b.title = tip;
        b.style.cssText = 'border:none;background:transparent;color:#666;cursor:pointer;padding:0 2px;font-size:11px;flex-shrink:0;';
        b.onmousedown = e => e.stopPropagation(); b.onclick = e => { e.stopPropagation(); fn(); };
        return b;
      };
      const dedent = mkIB('\u2190', 'Decrease indent', () => { if (item.indent > 0) { item.indent--; saveComp(); renderTree(); } });
      const indent = mkIB('\u2192', 'Increase indent', () => { item.indent++; saveComp(); renderTree(); });
      const rem = mkIB('\u00d7', 'Remove', () => { activeComposition.splice(idx, 1); saveComp(); renderTree(); });
      rem.style.color = '#a44';
      row.appendChild(grip); row.appendChild(badge); row.appendChild(name);
      row.appendChild(dedent); row.appendChild(indent); row.appendChild(rem);
      treeSec.body.appendChild(row);
    });
    // Append drop zone
    const dz = document.createElement('div');
    dz.style.cssText = 'height:28px;margin:3px;border:1px dashed #2a2a2a;border-radius:5px;display:flex;align-items:center;justify-content:center;color:#3a3a3a;font-size:10px;';
    dz.textContent = 'Drop to append';
    dz.ondragover = e => { e.preventDefault(); dz.style.borderColor = '#ceb888'; dz.style.color = '#ceb888'; };
    dz.ondragleave = () => { dz.style.borderColor = '#2a2a2a'; dz.style.color = '#3a3a3a'; };
    dz.ondrop = e => {
      e.preventDefault(); dz.style.borderColor = '#2a2a2a'; dz.style.color = '#3a3a3a';
      const src = e.dataTransfer.getData('btSource');
      const bid = e.dataTransfer.getData('btBlockId');
      if (src === 'tree' && dragSrcIdx !== -1) { const [m] = activeComposition.splice(dragSrcIdx, 1); activeComposition.push(m); dragSrcIdx = -1; }
      else if (src === 'library') { activeComposition.push({ id: bid, indent: 0 }); }
      saveComp(); renderTree();
    };
    treeSec.body.appendChild(dz);
  }

  // ── Footer ──
  const footerSec = document.createElement('div');
  footerSec.style.cssText = 'flex-shrink:0;padding:5px 7px;border-top:1px solid #333;background:#1a1a1a;display:flex;flex-direction:column;gap:3px;';
  const fbRow = document.createElement('div');
  fbRow.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;';
  const mkFBtn = (t, fn, danger) => {
    const b = document.createElement('button');
    b.textContent = t;
    b.style.cssText = 'padding:2px 7px;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;background:' + (danger ? '#3a1010' : '#222') + ';color:' + (danger ? '#f77' : '#ceb888') + ';';
    b.onmousedown = e => e.stopPropagation(); b.onclick = fn; return b;
  };
  const previewBox = document.createElement('pre');
  previewBox.style.cssText = 'display:none;font-size:9px;color:#999;white-space:pre-wrap;word-break:break-word;max-height:72px;overflow-y:auto;margin:0;background:#0d0d0d;padding:3px 6px;border-radius:3px;';
  const savedList = document.createElement('div');
  savedList.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;max-height:40px;overflow-y:auto;';

  function renderSavedList() {
    chrome.storage.local.get(['btSaved'], r => {
      savedList.innerHTML = '';
      Object.keys(r.btSaved || {}).forEach(name => {
        const c = document.createElement('button');
        c.textContent = name; c.title = 'Load';
        c.style.cssText = 'padding:1px 5px;border:none;border-radius:3px;background:#222;color:#ceb888;cursor:pointer;font-size:10px;';
        c.onmousedown = e => e.stopPropagation();
        c.onclick = () => { activeComposition = (r.btSaved[name] || []).map(x => ({ ...x })); saveComp(); renderTree(); };
        savedList.appendChild(c);
      });
    });
  }

  fbRow.appendChild(mkFBtn('Save as…', () => {
    const n = prompt('Composition name:'); if (!n) return;
    chrome.storage.local.get(['btSaved'], r => {
      const s = r.btSaved || {}; s[n] = [...activeComposition];
      chrome.storage.local.set({ btSaved: s }); renderSavedList();
    });
  }));
  fbRow.appendChild(mkFBtn('Clear', () => { activeComposition = []; saveComp(); renderTree(); }, true));
  let pvOpen = false;
  fbRow.appendChild(mkFBtn('Preview', () => {
    pvOpen = !pvOpen;
    previewBox.style.display = pvOpen ? 'block' : 'none';
    if (pvOpen) previewBox.textContent = assemblePrompt(activeComposition) || '(empty composition)';
  }));
  footerSec.appendChild(fbRow);
  footerSec.appendChild(previewBox);
  const savedHdr = document.createElement('div'); savedHdr.style.cssText = 'font-size:9px;color:#555;'; savedHdr.textContent = 'Saved:';
  footerSec.appendChild(savedHdr);
  footerSec.appendChild(savedList);
  renderSavedList();

  promptPanel.appendChild(libSec.wrap);
  promptPanel.appendChild(treeSec.wrap);
  promptPanel.appendChild(footerSec);

  // ─── Tab switching ──────────────────────────────────────────────────────
  chatTab.addEventListener('click', () => {
    chatContent.style.display = 'flex'; scratchpadContent.style.display = 'none'; promptPanel.style.display = 'none';
    tabStyle(chatTab, true); tabStyle(padTab, false); tabStyle(promptTab, false);
  });
  padTab.addEventListener('click', () => {
    chatContent.style.display = 'none'; scratchpadContent.style.display = 'flex'; promptPanel.style.display = 'none';
    tabStyle(padTab, true); tabStyle(chatTab, false); tabStyle(promptTab, false);
    if (spMode === 'draw') setTimeout(resizeCanvas, 50);
  });
  promptTab.addEventListener('click', () => {
    chatContent.style.display = 'none'; scratchpadContent.style.display = 'none'; promptPanel.style.display = 'flex';
    tabStyle(promptTab, true); tabStyle(chatTab, false); tabStyle(padTab, false);
    // Re-render in case blocks just finished loading
    renderLibrary(); renderTree(); renderSavedList();
  });

  // Render library after pre-load (500ms head-start from initBlockRegistry at top)
  setTimeout(() => { renderLibrary(); renderTree(); }, 600);

  // Assemble chatWindow
  chatWindow.appendChild(header);
  chatWindow.appendChild(controlsDiv);
  chatWindow.appendChild(chatContent);
  chatWindow.appendChild(scratchpadContent);
  chatWindow.appendChild(promptPanel);
  document.body.appendChild(chatWindow);

  // Event Listeners
  toggleBtn.onclick = () => {
    if (chatWindow.style.display === 'none') {
      chatWindow.style.display = 'flex';
      setupPort();
      textInput.focus();
    } else {
      chatWindow.style.display = 'none';
    }
  };

  loadBtn.onclick = () => {
    initModel(
      modelInput.value,
      visionCheckbox.checked,
      visionInput.value.trim() || 'gemma-3n-E2B-it-int4-Web.litertlm'
    );
  };

  const handleSend = () => {
    const text = textInput.value.trim();
    if (text) {
      addMessage("You: " + text);
      queryModel(text);
      textInput.value = '';
    }
  };

  sendBtn.onclick = handleSend;
  textInput.onkeypress = (e) => {
    if (e.key === 'Enter') handleSend();
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectUI);
} else {
  injectUI();
}
