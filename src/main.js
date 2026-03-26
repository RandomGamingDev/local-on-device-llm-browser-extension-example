// main.js - Content script for Boiler Tai
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

function handleResult(payload) {
  if (!currentResSpan) {
    const parentDiv = document.createElement('div');
    parentDiv.style.alignSelf = 'flex-start';
    parentDiv.style.background = '#f1f1f1';
    parentDiv.style.padding = '8px 12px';
    parentDiv.style.borderRadius = '15px';
    parentDiv.style.maxWidth = '80%';
    parentDiv.style.color = '#000';
    parentDiv.style.wordWrap = 'break-word';
    parentDiv.style.lineHeight = '1.4';

    const b = document.createElement('b');
    b.innerText = 'TA: ';
    parentDiv.appendChild(b);

    currentResSpan = document.createElement('span');
    parentDiv.appendChild(currentResSpan);

    const msgList = document.getElementById('boiler-tai-msg-list');
    msgList.appendChild(parentDiv);
    msgList.scrollTop = msgList.scrollHeight;
  }

  currentResSpan.innerText += payload.partialResults || '';

  const msgList = document.getElementById('boiler-tai-msg-list');
  msgList.scrollTop = msgList.scrollHeight;

  if (payload.complete) {
    currentResSpan = null;
  }
}

function addMessage(text) {
  const msgList = document.getElementById('boiler-tai-msg-list');
  if (!msgList) return;

  const msgDiv = document.createElement('div');
  msgDiv.innerText = text;
  msgDiv.style.padding = '8px 12px';
  msgDiv.style.borderRadius = '15px';
  msgDiv.style.maxWidth = '80%';
  msgDiv.style.wordWrap = 'break-word';
  msgDiv.style.lineHeight = '1.4';

  if (text.startsWith("You:")) {
    msgDiv.style.alignSelf = 'flex-end';
    msgDiv.style.background = '#000';
    msgDiv.style.color = '#fff';
  } else if (text.startsWith("System:")) {
    msgDiv.style.alignSelf = 'center';
    msgDiv.style.fontSize = '0.85em';
    msgDiv.style.color = '#666';
    msgDiv.style.background = 'none';
  } else {
    msgDiv.style.alignSelf = 'flex-start';
    msgDiv.style.background = '#f1f1f1';
    msgDiv.style.color = '#000';
  }

  msgList.appendChild(msgDiv);
  msgList.scrollTop = msgList.scrollHeight;
}

// UI Setup
function injectUI() {
  if (document.getElementById('boiler-tai-container')) return;

  // Create main container
  const container = document.createElement('div');
  container.id = 'boiler-tai-container';
  container.style.position = 'fixed';
  container.style.bottom = '20px';
  container.style.right = '20px';
  container.style.zIndex = '999999';
  container.style.fontFamily = 'system-ui, -apple-system, sans-serif';

  // Create toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.innerText = 'Boiler Tai';
  toggleBtn.style.padding = '12px 24px';
  toggleBtn.style.borderRadius = '24px';
  toggleBtn.style.border = 'none';
  toggleBtn.style.background = '#ceb888'; // Boiler gold
  toggleBtn.style.color = '#000';
  toggleBtn.style.cursor = 'pointer';
  toggleBtn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  toggleBtn.style.fontWeight = 'bold';
  toggleBtn.style.fontSize = '16px';
  toggleBtn.style.transition = 'transform 0.2s';
  toggleBtn.onmouseover = () => toggleBtn.style.transform = 'scale(1.05)';
  toggleBtn.onmouseout = () => toggleBtn.style.transform = 'scale(1)';

  // Create chat window
  const chatWindow = document.createElement('div');
  chatWindow.style.display = 'none';
  chatWindow.style.flexDirection = 'column';
  chatWindow.style.width = '350px';
  chatWindow.style.height = '500px';
  chatWindow.style.background = '#fff';
  chatWindow.style.border = '1px solid #e0e0e0';
  chatWindow.style.borderRadius = '12px';
  chatWindow.style.boxShadow = '0 8px 24px rgba(0,0,0,0.15)';
  chatWindow.style.position = 'absolute';
  chatWindow.style.bottom = '60px';
  chatWindow.style.right = '0';
  chatWindow.style.overflow = 'hidden';

  // Chat header
  const header = document.createElement('div');
  header.style.background = '#000';
  header.style.color = '#ceb888';
  header.style.padding = '12px 16px';
  header.style.textAlign = 'center';
  header.style.fontWeight = 'bold';
  header.style.fontSize = '16px';
  header.innerText = 'Boiler Tai Chat';

  // Controls (model loading)
  const controlsDiv = document.createElement('div');
  controlsDiv.style.padding = '10px';
  controlsDiv.style.background = '#f9f9f9';
  controlsDiv.style.borderBottom = '1px solid #eee';
  controlsDiv.style.display = 'flex';
  controlsDiv.style.gap = '8px';

  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.value = 'gemma3-1b-it-int4-web.task';
  modelInput.style.flex = '1';
  modelInput.style.padding = '8px';
  modelInput.style.border = '1px solid #ccc';
  modelInput.style.borderRadius = '6px';
  modelInput.style.fontSize = '12px';

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

  // Input area
  const inputArea = document.createElement('div');
  inputArea.style.padding = '12px';
  inputArea.style.borderTop = '1px solid #eee';
  inputArea.style.display = 'flex';
  inputArea.style.flexDirection = 'column';
  inputArea.style.gap = '8px';
  inputArea.style.background = '#fafafa';

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

  chatWindow.appendChild(header);
  chatWindow.appendChild(controlsDiv);
  chatWindow.appendChild(msgList);
  chatWindow.appendChild(inputArea);

  container.appendChild(chatWindow);
  container.appendChild(toggleBtn);
  document.body.appendChild(container);

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
