// Spawn the dedicated worker
const worker = new Worker('llm_worker.js');

// Connect to the Service Worker
const port = chrome.runtime.connect({ name: 'offscreen' });

// Relay messages from Service Worker to Web Worker
port.onMessage.addListener(async (msg) => {
  if (msg.type === 'init') {
    // Inject local WASM URL here since Worker can't access chrome.runtime
    msg.payload.wasmUrl = chrome.runtime.getURL("wasm");

    try {
      const root = await navigator.storage.getDirectory();
      let fileHandle;

      try {
        // Try to get existing model
        fileHandle = await root.getFileHandle(msg.payload.modelName);
      } catch (e) {
        // If not found, download from resources
        console.log("Model not found in OPFS, fetching from resources...");
        const response = await fetch(chrome.runtime.getURL('resources/models/gemma3-1b-it-int4-web.task'));
        const blob = await response.blob();

        fileHandle = await root.getFileHandle(msg.payload.modelName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        console.log("Model cached to OPFS.");
      }

      const file = await fileHandle.getFile();
      const modelStream = file.stream();
      msg.payload.modelStream = modelStream;

      // Forward to worker with transferables
      worker.postMessage(msg, [modelStream]);
    } catch (e) {
      console.error("Offscreen: Error loading model", e);
    }
  } else {
    // Forward other messages (query, cancel, etc.)
    worker.postMessage(msg);
  }
});

// Relay messages from Web Worker to Service Worker
worker.onmessage = (event) => {
  port.postMessage(event.data);
};

// Keep alive
setInterval(() => {
  if (port) port.postMessage({ type: 'ping' });
}, 20000);
