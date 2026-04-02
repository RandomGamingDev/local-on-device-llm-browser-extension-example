import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';

// Polyfill DOM references that MediaPipe might check during image validation
if (typeof HTMLImageElement === 'undefined') self.HTMLImageElement = class {};
if (typeof HTMLVideoElement === 'undefined') self.HTMLVideoElement = class {};
if (typeof HTMLCanvasElement === 'undefined') self.HTMLCanvasElement = class {};

function returnPartialResults(partialResults, complete) {
  self.postMessage({ type: "result", payload: { partialResults, complete } });
}

async function dataUrlToBitmap(dataUrl) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

let llmInference = null;
async function initialize(modelStream, wasmUrl, modelName) {
  const genaiFileset = await FilesetResolver.forGenAiTasks(wasmUrl);

  const isMultimodal = modelName && (
    modelName.toLowerCase().includes('3n') || modelName.toLowerCase().includes('e2b')
  );

  const options = {
    baseOptions: { modelAssetBuffer: modelStream },
    maxTokens: 8192,
  };

  if (isMultimodal) {
    options.maxNumImages = 5;
  }

  llmInference = await LlmInference.createFromOptions(genaiFileset, options);
}

self.onmessage = async (event) => {
  const { type, payload } = event.data;

  if (type === "init") {
    await initialize(payload.modelStream.getReader(), payload.wasmUrl, payload.modelName);
    self.postMessage({ type: "init", payload: { isSuccess: true } });
    return;
  }

  if (llmInference)
    switch (type) {
      case "cancel":
        llmInference.cancelProcessing();
        break;
      case "query":
        try {
          const systemPrompt = payload.systemPrompt || '';
          const systemBlock = systemPrompt ? `${systemPrompt}\n\n` : '';

          const questionImages = payload.questionImages || payload.images || (payload.image ? [payload.image] : []);
          const choiceImages = payload.choiceImages || [];
          const hasImages = questionImages.length > 0 || choiceImages.length > 0;

          if (hasImages) {
            const qBitmaps = await Promise.all(questionImages.map(dataUrlToBitmap));
            const cBitmaps = await Promise.all(choiceImages.map(c => dataUrlToBitmap(c.dataUrl)));

            // System prompt goes at the top of the user turn
            const promptParts = [`<start_of_turn>user\n${systemBlock}`];

            if (qBitmaps.length === 1) {
              promptParts.push('Question diagram:\n');
              promptParts.push({ imageSource: qBitmaps[0] });
              promptParts.push('\n');
            } else if (qBitmaps.length > 1) {
              qBitmaps.forEach((bm, i) => {
                promptParts.push(`Question diagram ${i + 1}:\n`);
                promptParts.push({ imageSource: bm });
                promptParts.push('\n');
              });
            }

            if (cBitmaps.length > 0) {
              promptParts.push('\nAnswer choice images:\n');
              cBitmaps.forEach((bm, i) => {
                promptParts.push(`Answer choice ${choiceImages[i].label}:\n`);
                promptParts.push({ imageSource: bm });
                promptParts.push('\n');
              });
            }

            promptParts.push('\n' + payload.query + '<end_of_turn>\n<start_of_turn>model\n');
            await llmInference.generateResponse(promptParts, returnPartialResults);
          } else {
            const formattedQuery = `<start_of_turn>user\n${systemBlock}${payload.query}<end_of_turn>\n<start_of_turn>model\n`;
            await llmInference.generateResponse(formattedQuery, returnPartialResults);
          }
        } catch (e) {
          console.error("Worker: Error generating response", e);
          self.postMessage({ type: "error", payload: { message: e.message || e.toString() } });
        }
        break;
    }
};