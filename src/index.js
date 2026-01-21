
const input = document.getElementById('input');
const output = document.getElementById('output');
const submit = document.getElementById('submit');
const modelSelector = document.getElementById('model-select');

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

// Default model name to load
const DEFAULT_MODEL_NAME = "gemma-3n-E2B-it-int4-Web.litertlm";

function startAutoLoad() {
  output.textContent = `[System] Auto-initializing with ${DEFAULT_MODEL_NAME}...\n(Checking OPFS cache...)\n`;
  submit.value = "Auto-loading...";

  // Send init immediately. 
  // Offscreen will check OPFS. If missing, it will stream-fetch safely.
  port.postMessage({
    type: "init",
    payload: {
      modelName: DEFAULT_MODEL_NAME,
    },
  });
}

// Manual option for user to select their own model
modelSelector.onchange = async () => {
  if (modelSelector.files && modelSelector.files.length > 0) {
    submit.value = "Caching to OPFS...";
    submit.disabled = true;

    const file = modelSelector.files[0];
    output.textContent = `[System] Caching ${file.name} to OPFS...\n`;

    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(file.name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(file);
      await writable.close();

      output.textContent += `[System] Cache complete. Initializing...\n`;

      port.postMessage({
        type: "init",
        payload: {
          modelName: file.name,
        },
      });

    } catch (e) {
      output.textContent += `[Error] Failed to save to OPFS: ${e.message}\n`;
      console.error(e);
      submit.value = "Error";
    }
  }
};

// Handle submission
submit.onclick = () => {
  output.textContent = "";
  submit.disabled = true;
  submit.value = "Generating...";

  port.postMessage({
    type: "query",
    payload: { query: input.value }
  });
};

// Start Auto-Load on popup open
startAutoLoad();