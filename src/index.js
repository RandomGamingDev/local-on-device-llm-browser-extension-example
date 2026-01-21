
const input = document.getElementById('input');
const output = document.getElementById('output');
const submit = document.getElementById('submit');
const modelSelector = document.getElementById('model-select');
const status = document.getElementById('status'); // Ensure status element exists if used

// Connect to Background
const port = chrome.runtime.connect({ name: 'popup' });

// Listen for updates
port.onMessage.addListener((msg) => {
  if (msg.type === 'init') {
    if (msg.payload.isSuccess) {
      submit.disabled = false;
      submit.value = "Get Response";
      output.textContent += "\n[System] Model Loaded Successfully.\n";
    }
  } else if (msg.type === "result") {
    output.textContent += msg.payload.partialResults;
    if (msg.payload.complete) {
      submit.disabled = false;
      submit.value = "Get Response";
    }
  }
});

// User selects model file
modelSelector.onchange = async () => {
  if (modelSelector.files && modelSelector.files.length > 0) {
    submit.value = "Caching to OPFS...";
    submit.disabled = true;

    const file = modelSelector.files[0];
    output.textContent = `[System] Caching ${file.name} to OPFS...\nThis allows multiple components to access it.\n`;

    try {
      // Write to OPFS from Popup
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(file.name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(file);
      await writable.close();

      output.textContent += `[System] Cache complete. Initializing Worker...\n`;

      // Now tell the background/offscreen to load this filename
      // The Offscreen doc will open it from OPFS and stream it to the worker.
      port.postMessage({
        type: "init",
        payload: {
          modelName: file.name,
          // No stream passed here, Offscreen will create it.
        },
      });

    } catch (e) {
      output.textContent += `[Error] Failed to save to OPFS: ${e.message}\n`;
      console.error(e);
      submit.value = "Error";
    }
  }
};

// Handle Submit
submit.onclick = () => {
  output.textContent = "";
  submit.disabled = true;
  submit.value = "Generating...";

  port.postMessage({
    type: "query",
    payload: { query: input.value }
  });
};

// Initial State
submit.disabled = true;
submit.value = "Select Model First";