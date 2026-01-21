// Spawn the dedicated worker
const worker = new Worker('llm_worker.js');

// Connect to the Service Worker
const port = chrome.runtime.connect({ name: 'offscreen' });

// Relay messages from Service Worker to Web Worker
port.onMessage.addListener(async (msg) => {
  if (msg.type === 'init') {
    // Inject local WASM URL here since Worker can't access chrome.runtime
    msg.payload.wasmUrl = chrome.runtime.getURL("wasm");

    // Read model from OPFS
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(msg.payload.modelName);
      const file = await fileHandle.getFile();
      const modelStream = file.stream();
      msg.payload.modelStream = modelStream;

      // Forward to worker with transferables
      worker.postMessage(msg, [modelStream]);
    } catch (e) {
      console.error("Offscreen: Error reading model from OPFS", e);
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
