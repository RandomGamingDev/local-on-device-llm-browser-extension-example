import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';

const RUNTIME = typeof browser !== "undefined" ? browser.runtime : chrome.runtime;

const MODEL_FILENAME = RUNTIME.getURL("resources/models/gemma3-1b-it-int4.task"); 

const GEN_AI_FILESET = await FilesetResolver.forGenAiTasks(
  RUNTIME.getURL("wasm/")); 
    
let llmInference;

LlmInference
  .createFromOptions(GEN_AI_FILESET, {
    baseOptions: { modelAssetPath: MODEL_FILENAME },
    // maxTokens: 512,  // The maximum number of tokens (input tokens + output
    //                  // tokens) the model handles.
    // randomSeed: 1,   // The random seed used during text generation.
    // topK: 1,  // The number of tokens the model considers at each step of
    //           // generation. Limits predictions to the top k most-probable
    //           // tokens. Setting randomSeed is required for this to make
    //           // effects.
    // temperature:
    //     1.0,  // The amount of randomness introduced during generation.
    //           // Setting randomSeed is required for this to make effects.
  })
  .then(llm => {
    llmInference = llm;
    console.log("LLM initialized successfully!");
  })
  .catch((e) => {
    console.error(`Failed to initialize the LLM!\n Error: ${e}`);
  });

function relayPartialResults(partialResult, complete) {

}

// Handle messages relayed from the Service Worker
RUNTIME.onConnect.addListener((port) => {
  if (port.name !== "offscreen-worker-port")
    return;
  
  console.log("Port connection established with Service Worker.");

  port.onMessage.addListener(async (msg) => {
    llmInference.generateResponse(msg.input, (partialResult, complete) => {
      port.postMessage({ partialResult: partialResult, complete: complete });
    })
  });

  port.onDisconnect.addListener(() => console.log("Port disconnected from Service Worker."));
});