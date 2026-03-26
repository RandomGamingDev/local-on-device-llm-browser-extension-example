// main.js - Content script for Boiler Tai
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';

marked.use(markedKatex({ throwOnError: false }));

let contentPort = null;
let isModelReady = false;
let currentResSpan = null;
let currentImageDataUrl = null;

let cachedContextUrl = null;
let cachedContextData = null;

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

function formatContextString(qData) {
  if (!qData || !qData.data) return "";
  let text = "Question Context:\n";
  if (qData.data.body) {
    text += qData.data.body + "\n";
  }

  if (qData.type === "MULTIPLE_CHOICE" && qData.data.answerChoices) {
    text += "\nChoices:\n";
    const choices = [...qData.data.answerChoices].sort((a, b) => a.index - b.index);
    choices.forEach((choice, i) => {
      text += `${String.fromCharCode(65 + i)}: ${choice.body}\n`;
    });
  }
  return text;
}

async function extractFirstImage(qData) {
  if (!qData) return null;
  
  const resources = [...(qData.resources || [])];
  if (qData.type === "MULTIPLE_CHOICE" && qData.data && qData.data.answerChoices) {
    qData.data.answerChoices.forEach(c => {
      if (c.resources) resources.push(...c.resources);
    });
  }

  const imageRes = resources.find(r => r.type === "IMAGE");
  if (imageRes && imageRes.data && imageRes.data.url) {
    try {
      const imgResp = await fetch(imageRes.data.url);
      const blob = await imgResp.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.error("Failed to load question image", e);
      return null;
    }
  }
  return null;
}

function setupPort() {
  if (contentPort) return;
  contentPort = chrome.runtime.connect({ name: 'content' });

  contentPort.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'init':
        addMessage(`System: Model loaded successfully!`);
        isModelReady = true;
        break;
      case 'result':
        handleResult(msg.payload);
        break;
      case 'error':
        addMessage(`Error: ${msg.payload.message || 'Unknown error'}`);
        break;
    }
  });

  contentPort.onDisconnect.addListener(() => {
    contentPort = null;
    isModelReady = false;
    addMessage("System: Disconnected from background script. Please reopen chat to reconnect.");
  });
}

function initModel(modelName) {
  setupPort();
  addMessage(`System: Initializing model ${modelName}... Please wait.`);
  contentPort.postMessage({
    type: 'init',
    payload: { modelName }
  });
}

async function queryModel(text) {
  if (!isModelReady) {
    addMessage("System: Please load a model first.");
    return;
  }
  
  const contextData = await getQuestionContext();
  let finalQuery = text;
  
  if (contextData) {
    const contextString = formatContextString(contextData);
    finalQuery = `Context from current page:\n${contextString}\n\nUser Question:\n${text}`;
    
    // Automatically attach image if user didn't manually upload one
    if (!currentImageDataUrl) {
      const autoImageUrl = await extractFirstImage(contextData);
      if (autoImageUrl) {
        currentImageDataUrl = autoImageUrl;
      }
    }
  }

  const payload = { query: finalQuery };
  
  if (currentImageDataUrl) {
    payload.image = currentImageDataUrl;
    currentImageDataUrl = null;
    
    // reset preview UI
    const preview = document.getElementById('boiler-tai-image-preview');
    if (preview) preview.style.display = 'none';
    const fileInput = document.getElementById('boiler-tai-image-input');
    if (fileInput) fileInput.value = '';
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
    top: { cursor: 'ns-resize', w: '100%', h: edgeSize+'px', t: -edgeSize/2, l: 0 },
    right: { cursor: 'ew-resize', w: edgeSize+'px', h: '100%', t: 0, r: -edgeSize/2 },
    bottom: { cursor: 'ns-resize', w: '100%', h: edgeSize+'px', b: -edgeSize/2, l: 0 },
    left: { cursor: 'ew-resize', w: edgeSize+'px', h: '100%', t: 0, l: -edgeSize/2 },
    topleft: { cursor: 'nwse-resize', w: edgeSize*2+'px', h: edgeSize*2+'px', t: -edgeSize, l: -edgeSize, z: 2 },
    topright: { cursor: 'nesw-resize', w: edgeSize*2+'px', h: edgeSize*2+'px', t: -edgeSize, r: -edgeSize, z: 2 },
    bottomleft: { cursor: 'nesw-resize', w: edgeSize*2+'px', h: edgeSize*2+'px', b: -edgeSize, l: -edgeSize, z: 2 },
    bottomright: { cursor: 'nwse-resize', w: edgeSize*2+'px', h: edgeSize*2+'px', b: -edgeSize, r: -edgeSize, z: 2 }
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
  header.innerText = 'Boiler Tai Chat';

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

  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.value = 'gemma3-1b-it-int4-web.task';
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

  controlsDiv.appendChild(modelInput);
  controlsDiv.appendChild(loadBtn);

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

  rowDiv.appendChild(uploadBtn);
  rowDiv.appendChild(textInput);
  rowDiv.appendChild(sendBtn);

  inputArea.appendChild(previewImg);
  inputArea.appendChild(rowDiv);
  inputArea.appendChild(fileInput);

  // Tabs
  const tabsDiv = document.createElement('div');
  tabsDiv.style.display = 'flex';
  tabsDiv.style.background = '#eee';
  tabsDiv.style.borderBottom = '1px solid #ccc';
  tabsDiv.style.boxSizing = 'border-box';

  const chatTabBtn = document.createElement('button');
  chatTabBtn.innerText = '💬 Chat';
  chatTabBtn.style.flex = '1';
  chatTabBtn.style.padding = '8px';
  chatTabBtn.style.border = 'none';
  chatTabBtn.style.background = '#fff';
  chatTabBtn.style.cursor = 'pointer';
  chatTabBtn.style.fontWeight = 'bold';

  const scratchTabBtn = document.createElement('button');
  scratchTabBtn.innerText = '📝 Scratchpad';
  scratchTabBtn.style.flex = '1';
  scratchTabBtn.style.padding = '8px';
  scratchTabBtn.style.border = 'none';
  scratchTabBtn.style.background = '#eee';
  scratchTabBtn.style.cursor = 'pointer';

  tabsDiv.appendChild(chatTabBtn);
  tabsDiv.appendChild(scratchTabBtn);

  // Chat container wrapper
  const chatInputContainer = document.createElement('div');
  chatInputContainer.style.display = 'flex';
  chatInputContainer.style.flexDirection = 'column';
  chatInputContainer.style.flexGrow = '1';
  chatInputContainer.style.overflow = 'hidden';
  chatInputContainer.appendChild(controlsDiv);
  chatInputContainer.appendChild(msgList);
  chatInputContainer.appendChild(inputArea);

  // Scratchpad container
  const scratchpadContainer = document.createElement('div');
  scratchpadContainer.style.display = 'none';
  scratchpadContainer.style.flexDirection = 'column';
  scratchpadContainer.style.flexGrow = '1';
  scratchpadContainer.style.overflow = 'hidden';
  scratchpadContainer.style.background = '#fafafa';
  scratchpadContainer.style.padding = '10px';
  scratchpadContainer.style.boxSizing = 'border-box';
  scratchpadContainer.style.gap = '10px';

  const toolDiv = document.createElement('div');
  toolDiv.style.display = 'flex';
  toolDiv.style.gap = '5px';
  
  const penBtn = document.createElement('button');
  penBtn.innerText = '✏️ Pen';
  const eraseBtn = document.createElement('button');
  eraseBtn.innerText = '🧽 Erase';
  const clearBtn = document.createElement('button');
  clearBtn.innerText = '🗑️ Clear';
  
  [penBtn, eraseBtn, clearBtn].forEach(b => {
    b.style.padding = '4px 8px';
    b.style.cursor = 'pointer';
    b.style.border = '1px solid #ccc';
    b.style.borderRadius = '4px';
    b.style.background = '#fff';
    toolDiv.appendChild(b);
  });
  penBtn.style.background = '#e0e0e0';

  const canvasWrapper = document.createElement('div');
  canvasWrapper.style.flexGrow = '1';
  canvasWrapper.style.border = '1px solid #ccc';
  canvasWrapper.style.borderRadius = '8px';
  canvasWrapper.style.background = '#fff';
  canvasWrapper.style.position = 'relative';
  canvasWrapper.style.overflow = 'hidden';

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  canvasWrapper.appendChild(canvas);

  const scratchText = document.createElement('textarea');
  scratchText.placeholder = 'Type additional reasoning here...';
  scratchText.style.width = '100%';
  scratchText.style.height = '60px';
  scratchText.style.minHeight = '60px';
  scratchText.style.resize = 'vertical';
  scratchText.style.padding = '8px';
  scratchText.style.boxSizing = 'border-box';
  scratchText.style.border = '1px solid #ccc';
  scratchText.style.borderRadius = '8px';

  const gradeBtn = document.createElement('button');
  gradeBtn.innerText = 'Grade My Work';
  gradeBtn.style.padding = '10px';
  gradeBtn.style.background = '#ceb888';
  gradeBtn.style.color = '#000';
  gradeBtn.style.fontWeight = 'bold';
  gradeBtn.style.border = 'none';
  gradeBtn.style.borderRadius = '8px';
  gradeBtn.style.cursor = 'pointer';

  scratchpadContainer.appendChild(toolDiv);
  scratchpadContainer.appendChild(canvasWrapper);
  scratchpadContainer.appendChild(scratchText);
  scratchpadContainer.appendChild(gradeBtn);

  chatWindow.appendChild(header);
  chatWindow.appendChild(tabsDiv);
  chatWindow.appendChild(chatInputContainer);
  chatWindow.appendChild(scratchpadContainer);

  document.body.appendChild(chatWindow);

  // Event Listeners
  chatTabBtn.onclick = () => {
    chatTabBtn.style.background = '#fff';
    scratchTabBtn.style.background = '#eee';
    chatTabBtn.style.fontWeight = 'bold';
    scratchTabBtn.style.fontWeight = 'normal';
    chatInputContainer.style.display = 'flex';
    scratchpadContainer.style.display = 'none';
  };

  scratchTabBtn.onclick = () => {
    scratchTabBtn.style.background = '#fff';
    chatTabBtn.style.background = '#eee';
    scratchTabBtn.style.fontWeight = 'bold';
    chatTabBtn.style.fontWeight = 'normal';
    scratchpadContainer.style.display = 'flex';
    chatInputContainer.style.display = 'none';
    resizeCanvas();
  };

  // Canvas drawing logic
  let ctx = canvas.getContext('2d');
  let drawing = false;
  let currentTool = 'pen';

  const resizeCanvas = () => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    tempCanvas.getContext('2d').drawImage(canvas, 0, 0);
    
    const rect = canvasWrapper.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width;
      canvas.height = rect.height;
      ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      if (tempCanvas.width === 0 || tempCanvas.height === 0 || tempCanvas.width === 300) {
          ctx.fillRect(0, 0, canvas.width, canvas.height); 
      } else {
          ctx.fillRect(0, 0, canvas.width, canvas.height); 
          ctx.drawImage(tempCanvas, 0, 0);
      }
    }
  };
  
  new ResizeObserver(resizeCanvas).observe(canvasWrapper);

  const getPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const startDraw = (e) => {
    drawing = true;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  };

  const draw = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = currentTool === 'erase' ? '#fff' : '#000';
    ctx.lineWidth = currentTool === 'erase' ? 20 : 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  const stopDraw = () => {
    drawing = false;
    ctx.closePath();
  };

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('mouseout', stopDraw);
  canvas.addEventListener('touchstart', startDraw, {passive: false});
  canvas.addEventListener('touchmove', draw, {passive: false});
  canvas.addEventListener('touchend', stopDraw);

  penBtn.onclick = () => { currentTool = 'pen'; penBtn.style.background = '#e0e0e0'; eraseBtn.style.background = '#fff'; };
  eraseBtn.onclick = () => { currentTool = 'erase'; eraseBtn.style.background = '#e0e0e0'; penBtn.style.background = '#fff'; };
  clearBtn.onclick = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  gradeBtn.onclick = () => {
    const text = scratchText.value.trim();
    const blank = document.createElement('canvas');
    blank.width = canvas.width;
    blank.height = canvas.height;
    blank.getContext('2d').fillStyle = '#fff';
    blank.getContext('2d').fillRect(0, 0, blank.width, blank.height);
    
    // Some browsers differ slightly in empty pixel coloring compressions, but this is a rough exact match
    const isBlank = canvas.toDataURL() === blank.toDataURL();
    
    if (isBlank && !text) {
      alert("Please draw or type your work first!");
      return;
    }

    if (!isBlank) {
      currentImageDataUrl = canvas.toDataURL('image/png');
    }
    
    const gradePrompt = `Please act as a TA and grade my work for the current question.\nMy text reasoning is: ${text || "(None)"}\nMy written work is attached as an image. Provide hints if I am wrong.`;
    
    chatTabBtn.click();
    addMessage("You: [Submitted Scratchpad Work for Grading]");
    queryModel(gradePrompt);
  };

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
    initModel(modelInput.value);
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
