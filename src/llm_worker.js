import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';

// Polyfill DOM references that MediaPipe might check during image validation
if (typeof HTMLImageElement === 'undefined') self.HTMLImageElement = class {};
if (typeof HTMLVideoElement === 'undefined') self.HTMLVideoElement = class {};
if (typeof HTMLCanvasElement === 'undefined') self.HTMLCanvasElement = class {};

function returnPartialResults(partialResults, complete) {
  self.postMessage({ type: "result", payload: { partialResults, complete } });
}

let llmInference = null;
async function initialize(modelStream, wasmUrl, modelName) {
  const genaiFileset = await FilesetResolver.forGenAiTasks(wasmUrl);
  
  const isMultimodal = modelName && (modelName.toLowerCase().includes('3n') || modelName.toLowerCase().includes('e2b'));
  
  const options = {
    baseOptions: { modelAssetBuffer: modelStream },
  };
  
  if (isMultimodal) {
    options.maxNumImages = 1;
  }

  llmInference = await LlmInference.createFromOptions(genaiFileset, options);
}

self.onmessage = async (event) => {
  const { type, payload } = event.data;

  if (type === "init") {
    await initialize(payload.modelStream.getReader(), payload.wasmUrl, payload.modelName);
    self.postMessage({
      type: "init",
      payload: {
        isSuccess: true,
      },
    });
    return;
  }

  if (llmInference)
    switch (type) {
      case "cancel":
        llmInference.cancelProcessing();
        break;
      case "query":
        try {
          if (payload.image) {
            const resp = await fetch(payload.image);
            const blob = await resp.blob();
            const imageBitmap = await createImageBitmap(blob);
            await llmInference.generateResponse([
              '<start_of_turn>user\n',
              { imageSource: imageBitmap },
              '\n' + payload.query + '<end_of_turn>\n<start_of_turn>model\n'
            ], returnPartialResults);
          } else {
            await llmInference.generateResponse(payload.query, returnPartialResults);
          }
        } catch (e) {
          console.error("Worker: Error generating response", e);
          self.postMessage({ type: "error", payload: { message: e.message || e.toString() } });
        }
        break;
    }
};