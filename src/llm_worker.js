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
let currentModelName = '';

function isGemma4(modelName) {
  const n = (modelName || '').toLowerCase();
  return n.includes('gemma-4') || n.includes('gemma4');
}

function isMultimodal(modelName) {
  const n = (modelName || '').toLowerCase();
  // .litertlm bundles always include the full vision encoder (Gemma 3n, Gemma 4, etc.)
  // .task web bundles for Gemma 4 are text-only — vision calculator is missing.
  return n.includes('3n') || n.endsWith('.litertlm');
}

async function initialize(modelStream, wasmUrl, modelName) {
  const genaiFileset = await FilesetResolver.forGenAiTasks(wasmUrl);
  currentModelName = modelName || '';

  const options = {
    baseOptions: { modelAssetBuffer: modelStream },
    maxTokens: 8192,
  };

  if (isMultimodal(currentModelName)) {
    options.maxNumImages = 5;
  }

  llmInference = await LlmInference.createFromOptions(genaiFileset, options);
}

// Build a text-only prompt string using the correct control tokens for the model.
function buildTextPrompt(systemPrompt, query, modelName) {
  if (isGemma4(modelName)) {
    // Gemma 4 format: <|turn>role content<turn|>
    const sysTurn = systemPrompt ? `<|turn>system\n${systemPrompt}<turn|>\n` : '';
    return `${sysTurn}<|turn>user\n${query}<turn|>\n<|turn>model\n`;
  } else {
    // Legacy Gemma 1/2/3 format: <start_of_turn>role\ncontent<end_of_turn>
    const systemBlock = systemPrompt ? `${systemPrompt}\n\n` : '';
    return `<start_of_turn>user\n${systemBlock}${query}<end_of_turn>\n<start_of_turn>model\n`;
  }
}

// Build a multi-modal promptParts array using the correct control tokens.
function buildMultimodalParts(systemPrompt, query, qBitmaps, cBitmaps, choiceImages, modelName) {
  const parts = [];

  if (isGemma4(modelName)) {
    const sysTurn = systemPrompt ? `<|turn>system\n${systemPrompt}<turn|>\n` : '';
    parts.push(`${sysTurn}<|turn>user\n`);
  } else {
    const systemBlock = systemPrompt ? `${systemPrompt}\n\n` : '';
    parts.push(`<start_of_turn>user\n${systemBlock}`);
  }

  if (qBitmaps.length === 1) {
    parts.push('Question diagram:\n');
    parts.push({ imageSource: qBitmaps[0] });
    parts.push('\n');
  } else {
    qBitmaps.forEach((bm, i) => {
      parts.push(`Question diagram ${i + 1}:\n`);
      parts.push({ imageSource: bm });
      parts.push('\n');
    });
  }

  if (cBitmaps.length > 0) {
    parts.push('\nAnswer choice images:\n');
    cBitmaps.forEach((bm, i) => {
      parts.push(`Answer choice ${choiceImages[i].label}:\n`);
      parts.push({ imageSource: bm });
      parts.push('\n');
    });
  }

  if (isGemma4(modelName)) {
    parts.push('\n' + query + '<turn|>\n<|turn>model\n');
  } else {
    parts.push('\n' + query + '<end_of_turn>\n<start_of_turn>model\n');
  }

  return parts;
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
          const questionImages = payload.questionImages || payload.images || (payload.image ? [payload.image] : []);
          const choiceImages = payload.choiceImages || [];
          const hasImages = questionImages.length > 0 || choiceImages.length > 0;

          if (hasImages && isMultimodal(currentModelName)) {
            const qBitmaps = await Promise.all(questionImages.map(dataUrlToBitmap));
            const cBitmaps = await Promise.all(choiceImages.map(c => dataUrlToBitmap(c.dataUrl)));
            const parts = buildMultimodalParts(systemPrompt, payload.query, qBitmaps, cBitmaps, choiceImages, currentModelName);
            await llmInference.generateResponse(parts, returnPartialResults);
          } else {
            if (hasImages) console.warn('Worker: Model does not support images — falling back to text-only.');
            const prompt = buildTextPrompt(systemPrompt, payload.query, currentModelName);
            await llmInference.generateResponse(prompt, returnPartialResults);
          }
        } catch (e) {
          console.error("Worker: Error generating response", e);
          self.postMessage({ type: "error", payload: { message: e.message || e.toString() } });
        }
        break;
    }
};