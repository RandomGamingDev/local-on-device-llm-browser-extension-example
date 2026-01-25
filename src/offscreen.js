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
        console.log("Model not found/empty in OPFS, fetching from resources using chunked-download...");

        const fileUrl = chrome.runtime.getURL(`resources/models/${msg.payload.modelName}`);
        fileHandle = await root.getFileHandle(msg.payload.modelName, { create: true });
        const writable = await fileHandle.createWritable();

        // SPLIT-FILE STITCHING STRATEGY
        // 1. Check if a manifest exists for this model (e.g. model.json)
        const manifestUrl = chrome.runtime.getURL(`resources/models/${msg.payload.modelName}.json`);
        const manifestResp = await fetch(manifestUrl);

        if (manifestResp.ok) {
          // CASE A: Split File (Large Model)
          const manifest = await manifestResp.json();
          console.log(`Found split configuration for ${msg.payload.modelName}. Parts: ${manifest.parts.length}`);

          // Re-create writable as it might have been closed or not used if the initial `writable` was for a single file.
          // This ensures we start fresh for stitching.
          fileHandle = await root.getFileHandle(msg.payload.modelName, { create: true });
          const newWritable = await fileHandle.createWritable(); // Use a new variable name to avoid conflict

          for (let i = 0; i < manifest.parts.length; i++) {
            const partName = manifest.parts[i];
            const partUrl = chrome.runtime.getURL(`resources/models/${partName}`);

            const partResp = await fetch(partUrl);
            if (!partResp.ok) throw new Error(`Failed to fetch part ${partName}`);

            const partBlob = await partResp.blob();
            await newWritable.write(partBlob);

            console.log(`Stitched part ${i + 1}/${manifest.parts.length}: ${partName}`);

            // Allow GC
            await new Promise(r => setTimeout(r, 10));
          }

          await newWritable.close();
          console.log("Model successfully stitched and cached to OPFS.");

        } else {
          // CASE B: Single File (Legacy/Small Model)
          console.log("No manifest found, falling back to single-stream pump.");

          // The initial `fileUrl` and `writable` can be reused here.
          const response = await fetch(fileUrl);
          if (!response.body) throw new Error("Fetch response body is null");

          const contentLength = response.headers.get('Content-Length');
          const totalSize = contentLength ? parseInt(contentLength) : 0;

          console.log(`Starting stream download. Total size: ${totalSize ? (totalSize / 1024 / 1024).toFixed(2) + ' MB' : 'Unknown'}`);

          // The writable from above is already created: `const writable = await fileHandle.createWritable();`
          // No need to recreate fileHandle or writable here.

          const reader = response.body.getReader();
          let processedBytes = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            await writable.write(value);
            processedBytes += value.length;

            if (processedBytes % (50 * 1024 * 1024) < value.length) {
              console.log(`Wrote ${(processedBytes / 1024 / 1024).toFixed(1)} MB`);
            }

            await new Promise(r => setTimeout(r, 0));
          }

          await writable.close();
          console.log("Model successfully cached to OPFS via stream pump.");
        }
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
