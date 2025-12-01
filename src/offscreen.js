import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';

const RUNTIME = typeof browser !== "undefined" ? browser.runtime : chrome.runtime;

const MODEL_FILENAME = RUNTIME.getURL("resources/models/gemma3-1b-it-int4-web.task"); 
//const MODEL_FILENAME = RUNTIME.getURL("resources/models/gemma-3n-E2B-it-int4-Web.litertlm"); 

const GEN_AI_FILESET = await FilesetResolver.forGenAiTasks(
  RUNTIME.getURL("wasm/")); 
    
let llmInference;

function getFileName(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/**
 * Uses more advanced caching system which allows for the loading of larger models even in more limited environments
 */
async function loadModelWithCache(modelPath) {
  const fileName = getFileName(modelPath);
  const opfsRoot = await navigator.storage.getDirectory();

  try {
    const fileHandle = await opfsRoot.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    const sizeHandle = await opfsRoot.getFileHandle(fileName + '_size');
    const sizeFile = await sizeHandle.getFile();
    const expectedSizeText = await sizeFile.text();
    const expectedSize = parseInt(expectedSizeText);

    if (file.size === expectedSize) {
      console.log('Found valid model in cache.');
      return { stream: file.stream(), size: file.size };
    }

    console.warn('Cached model has incorrect size. Deleting and re-downloading.');
    await opfsRoot.removeEntry(fileName);
    await opfsRoot.removeEntry(fileName + '_size');
    throw new Error('Incorrect file size');
  } catch (e) {
    if (e.name !== 'NotFoundError')
      console.error('Error accessing OPFS:', e);
  }

  console.log('Fetching model from network and caching to OPFS.');
  const response = await fetch(modelPath);
  if (!response.ok) {
    throw new Error(`Failed to download model from ${modelPath}: ${response.statusText}.`);
  }
  const modelBlob = await response.blob();
  const expectedSize = modelBlob.size;
  const streamForConsumer = modelBlob.stream();

  (async () => {
    try {
      const fileHandle = await opfsRoot.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(modelBlob);
      await writable.close();

      const sizeHandle = await opfsRoot.getFileHandle(fileName + '_size', { create: true });
      const sizeWritable = await sizeHandle.createWritable();
      await sizeWritable.write(expectedSize.toString());
      await sizeWritable.close();
      console.log(`Successfully cached ${fileName}.`);
    } catch (error) {
      console.error(`Failed to cache model ${fileName}:`, error);
      try {
        await opfsRoot.removeEntry(fileName);
        await opfsRoot.removeEntry(fileName + '_size');
      } catch (cleanupError) {}
    }
  })();

  return { stream: streamForConsumer, size: expectedSize };
}

  try {
    const { stream: modelStream } = await loadModelWithCache(MODEL_FILENAME);
    
    const llm = await LlmInference.createFromOptions(GEN_AI_FILESET, {
        baseOptions: {modelAssetBuffer: modelStream.getReader()},
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
      });

    llmInference = llm;
    RUNTIME.sendMessage({ type: "offscreen_ready" });
  } catch (error) {
    console.error(error);
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