// Spawn the dedicated worker
const worker = new Worker('llm_worker.js');

// Connect to the Service Worker
const port = chrome.runtime.connect({ name: 'offscreen' });

// Relay messages from Service Worker to Web Worker
port.onMessage.addListener(async (msg) => {
  if (msg.type === 'init') {
    // Inject local WASM URL
    msg.payload.wasmUrl = chrome.runtime.getURL("wasm");

    try {
      const root = await navigator.storage.getDirectory();
      let fileHandle;

      try {
        fileHandle = await root.getFileHandle(msg.payload.modelName);
        const checkFile = await fileHandle.getFile();
        if (checkFile.size === 0) {
          console.warn("Existing model file is empty. Re-downloading.");
          throw new Error("File empty");
        }
        console.log("Found existing model in OPFS. Size:", checkFile.size);

      } catch (e) {
        console.log("Model not found/empty in OPFS, fetching from resources...");
        const response = await fetch(chrome.runtime.getURL(`resources/models/${msg.payload.modelName}`));
        if (!response.body) throw new Error("Fetch response body is null");

        fileHandle = await root.getFileHandle(msg.payload.modelName, { create: true });
        const writable = await fileHandle.createWritable();

        await response.body.pipeTo(writable);

        console.log("Model stream-cached to OPFS.");
      }

      const file = await fileHandle.getFile();
      if (file.size === 0) {
        throw new Error("File size is 0 after write!");
      }

      const modelStream = file.stream();
      msg.payload.modelStream = modelStream;

      worker.postMessage(msg, [modelStream]);
    } catch (e) {
      console.error("Offscreen: Error loading model", e);
    }
  } else {
    worker.postMessage(msg);
  }
});

// Relay messages from Web Worker to Service Worker
worker.onmessage = (event) => {
  port.postMessage(event.data);
};

// Keep alive heartbeat (Manifest V3 T-T)
setInterval(() => {
  if (port) port.postMessage({ type: 'ping' });
}, 20000);
