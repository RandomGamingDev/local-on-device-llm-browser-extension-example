// Spawn the primary worker (text model)
const worker = new Worker('llm_worker.js');

// Spawn a secondary worker for the Gemma 3n vision supplement
const visionWorker = new Worker('llm_worker.js');
let isVisionReady = false;
let isVisionLoading = false;

// Connect to the Service Worker
const port = chrome.runtime.connect({ name: 'offscreen' });

// ── Shared OPFS model loader ────────────────────────────────────────────────
async function loadModelToOPFS(modelName) {
  const root = await navigator.storage.getDirectory();
  let fileHandle;

  try {
    fileHandle = await root.getFileHandle(modelName);
    const checkFile = await fileHandle.getFile();
    if (checkFile.size === 0) {
      console.warn(`[OPFS] ${modelName}: file is empty, re-downloading.`);
      throw new Error('File empty');
    }
    console.log(`[OPFS] ${modelName}: found in cache, size`, checkFile.size);
  } catch (e) {
    console.log(`[OPFS] ${modelName}: not in cache, fetching from resources...`);

    const manifestUrl = chrome.runtime.getURL(`resources/models/${modelName}.json`);
    const manifestResp = await fetch(manifestUrl);

    fileHandle = await root.getFileHandle(modelName, { create: true });

    if (manifestResp.ok) {
      const manifest = await manifestResp.json();
      console.log(`[OPFS] ${modelName}: split file, ${manifest.parts.length} parts`);

      let newWritable = await fileHandle.createWritable();
      let bytesWritten = 0;
      const FLUSH_EVERY = 10;

      for (let i = 0; i < manifest.parts.length; i++) {
        const partUrl = chrome.runtime.getURL(`resources/models/${manifest.parts[i]}`);
        const partResp = await fetch(partUrl);
        if (!partResp.ok) throw new Error(`Failed to fetch part ${manifest.parts[i]}`);

        const reader = partResp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await newWritable.write(value);
          bytesWritten += value.byteLength;
        }
        console.log(`[OPFS] ${modelName}: stitched part ${i + 1}/${manifest.parts.length}`);

        if ((i + 1) % FLUSH_EVERY === 0 && i + 1 < manifest.parts.length) {
          await newWritable.close();
          newWritable = await fileHandle.createWritable({ keepExistingData: true });
          await newWritable.seek(bytesWritten);
        }
        await new Promise(r => setTimeout(r, 0));
      }
      await newWritable.close();
    } else {
      const fileUrl = chrome.runtime.getURL(`resources/models/${modelName}`);
      const response = await fetch(fileUrl);
      if (!response.body) throw new Error('Fetch body is null');
      const writable = await fileHandle.createWritable();
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        await new Promise(r => setTimeout(r, 0));
      }
      await writable.close();
    }
  }

  const file = await fileHandle.getFile();
  if (file.size === 0) throw new Error(`${modelName}: size is 0 after write`);
  return file.stream();
}

// Relay messages from Service Worker to Web Worker
port.onMessage.addListener(async (msg) => {
  // ── Vision supplement init ────────────────────────────────────────────────
  if (msg.type === 'init_vision') {
    if (isVisionLoading || isVisionReady) {
      console.log('Offscreen: vision model already loaded/loading, skipping.');
      port.postMessage({ type: 'init_vision', payload: { isSuccess: true } });
      return;
    }
    isVisionLoading = true;
    console.log('Offscreen: loading vision supplement:', msg.payload.modelName);
    try {
      const modelStream = await loadModelToOPFS(msg.payload.modelName);
      const visionMsg = {
        type: 'init',
        payload: {
          modelStream,
          wasmUrl: chrome.runtime.getURL('wasm'),
          modelName: msg.payload.modelName,
        }
      };
      visionWorker.postMessage(visionMsg, [modelStream]);
    } catch (e) {
      isVisionLoading = false;
      console.error('Offscreen: vision model load error', e);
      port.postMessage({ type: 'init_vision', payload: { isSuccess: false, error: e.message } });
    }
    return;
  }

  if (msg.type === 'init') {
    try {
      const modelStream = await loadModelToOPFS(msg.payload.modelName);
      const initMsg = {
        type: 'init',
        payload: {
          modelStream,
          wasmUrl: chrome.runtime.getURL('wasm'),
          modelName: msg.payload.modelName,
        }
      };
      worker.postMessage(initMsg, [modelStream]);
    } catch (e) {
      console.error('Offscreen: Error loading primary model', e);
    }
    return;
  }

  // ── Query routing: images → vision worker (if ready), else primary ────────
  if (msg.type === 'query') {
    const hasImages = (msg.payload.questionImages && msg.payload.questionImages.length > 0) ||
                      (msg.payload.choiceImages && msg.payload.choiceImages.length > 0);
    if (hasImages && isVisionReady) {
      visionWorker.postMessage(msg);
    } else {
      worker.postMessage(msg);
    }
    return;
  }

  // All other messages (cancel, etc.) go to the active primary worker
  worker.postMessage(msg);
});

// Relay messages from primary worker to Service Worker
worker.onmessage = (event) => {
  port.postMessage(event.data);
};

// Relay messages from vision worker to Service Worker
visionWorker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    // Intercept the init-success from the vision worker and rewrite it
    isVisionLoading = false;
    isVisionReady = msg.payload.isSuccess;
    port.postMessage({ type: 'init_vision', payload: { isSuccess: msg.payload.isSuccess } });
  } else {
    // Pass inference results straight through
    port.postMessage(msg);
  }
};

// Keep alive heartbeat (Manifest V3 T-T)
setInterval(() => {
  if (port) port.postMessage({ type: 'ping' });
}, 20000);
