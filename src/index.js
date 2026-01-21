/* Copyright 2026 The MediaPipe Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
console.log("FLAG1");

const modelSelector = document.getElementById('model-select');
const cancel = document.getElementById('cancel');
const input = document.getElementById('input');
const output = document.getElementById('output');
const submit = document.getElementById('submit');

// Normally, we'd want a worker with "module" type, but MediaPipe web APIs do
// not yet support this.
const worker = new Worker("/src/background.js");

/**
 * Display newly generated partial results to the output text box.
 */
function displayPartialResults(partialResults, complete) {
  output.textContent += partialResults;

  if (complete) {
    if (!output.textContent) {
      output.textContent = 'Result is empty';
    }
    submit.disabled = false;
    cancel.disabled = true;
  }
}

/**
 * Main function to run LLM Inference given a model.
 */
async function runDemo(modelStream) {
  submit.disabled = true;
  // Send query to worker thread when submit is clicked.
  submit.onclick = () => {
    output.textContent = '';
    submit.disabled = true;
    // Gemma 3 models require a simple template for best results. See
    // https://ai.google.dev/gemma/docs/core/prompt-structure.
    const query = '<start_of_turn>user\n'
      + input.value
      + '<end_of_turn>\n<start_of_turn>model\n';
    worker.postMessage({
      type: "query",
      payload: { query },
    });
    cancel.disabled = false;
  };

  // Send cancel signal to worker thread when cancel is clicked.
  cancel.onclick = () => {
    worker.postMessage({
      type: "cancel",
    });
  };

  submit.value = 'Loading the model...'

  try {
    // Send an init signal (with LLM model Stream) to worker thread, and wait.
    await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const { type, payload } = event.data;
        if (type === "init" && typeof payload === "object"
          && payload.isSuccess) {
          resolve("MediaPipe initialized");
        }
      };
      worker.postMessage({
        type: "init",
        payload: {
          modelStream,
          wasmUrl: chrome.runtime.getURL("wasm")
        },
      }, [modelStream]);
    });
  } catch (error) {
    console.error("Error initializing MediaPipe:", error);
    return;
  }

  // Receive any results from the worker thread, and pipe them to our display.
  worker.onmessage = (event) => {
    const { type, payload } = event.data;
    if (type === "result") {
      displayPartialResults(payload.partialResults, payload.complete);
    }
  };
  submit.disabled = false;
  submit.value = 'Get Response';
}

// When the user chooses a model from their local hard drive, load it and start
// the demo.
modelSelector.onchange = async () => {
  if (modelSelector.files && modelSelector.files.length > 0) {
    const reader = await modelSelector.files[0].stream();
    runDemo(reader);
  }
};


/*
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

// Set initial state to disabled and begin polling for readiness.
submit.disabled = true;
submit.value = "Initializing...";

const readyInterval = setInterval(() => {
  RUNTIME.sendMessage('is_ready', (isReady) => {
    if (isReady) {
      clearInterval(readyInterval);
      submit.disabled = false;
      submit.value = "Get response";
      connect();
    }
  });
}, 1000); // Poll every second.
*/