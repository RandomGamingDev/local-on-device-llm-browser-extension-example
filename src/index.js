// HTML Elements
const input = document.getElementById('input');
const output = document.getElementById('output');
const submit = document.getElementById('submit');

// Create a listener to the background so it doesn't have to be reloaded everything and everything's abstracted
const RUNTIME = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;

function connect() {
  const port = RUNTIME.connect({ name: "mediapipe-llm" });
  port.onMessage.addListener((msg) => {
    // Stream in the partial results
    output.textContent += msg.partialResult;
    // Allow for another prompt to be entered if response is done
    if (msg.complete) {
      submit.disabled = false;
      submit.value = "Get response";
    }
  });

  // Send a request to the background worker server so that it can relay the input and response to and from the offscreen page
  submit.onclick = () => {
    // Stop another prompt being entered if response is being generated
    output.textContent = "";
    submit.disabled = true;
    submit.value = "Generating response...";

    // Request from the local server (specifically background proxy which will request from offscreen page) LLM's inference
    port.postMessage({ input: input.value });
  };

  port.onDisconnect.addListener(() => {
    console.log("Disconnected from MediaPipe Local Server");
    submit.disabled = true;
    submit.value = "Disconnected";
  });
}

RUNTIME.sendMessage('is_ready', (isReady) => {
  if (isReady) {
    connect();
  } else {
    // Handle the case where the background script is not ready
    submit.disabled = true;
    submit.value = "Background not ready";
  }
});