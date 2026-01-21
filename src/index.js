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

// const modelSelector = document.getElementById('model-select');
const cancel = document.getElementById('cancel');
const input = document.getElementById('input');
const output = document.getElementById('output');
const submit = document.getElementById('submit');

// Connect to the background service worker
const port = chrome.runtime.connect({ name: 'popup' });

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
async function runDemo() {
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

    port.postMessage({
      type: "query",
      payload: { query },
    });
    cancel.disabled = false;
  };

  // Send cancel signal to worker thread when cancel is clicked.
  cancel.onclick = () => {
    port.postMessage({
      type: "cancel",
    });
  };

  submit.value = 'Loading the model...'

  // Send an init signal to worker thread via SW
  // The offscreen worker will handle fetching/caching if needed.
  port.postMessage({
    type: "init",
    payload: {
      //modelName: "gemma3-1b-it-int4-web.task"
      //modelName: "gemma3-4b-it-int4-web.task"
      //modelName: "gemma-3n-E2B-it-int4-Web.litertlm"
    },
  });

  // Wait for init confirmation
  const initListener = (msg) => {
    const { type, payload } = msg;
    if (type === "init" && payload && payload.isSuccess) {
      submit.disabled = false;
      submit.value = 'Get Response';
      port.onMessage.removeListener(initListener);
    }
  };
  port.onMessage.addListener(initListener);
}

// Receive any results from the worker thread, and pipe them to our display.
port.onMessage.addListener((msg) => {
  const { type, payload } = msg;
  if (type === "result") {
    displayPartialResults(payload.partialResults, payload.complete);
  }
});

// When the user chooses a model from their local hard drive, load it and start
// the demo.
// Automatically start loading the model
runDemo();