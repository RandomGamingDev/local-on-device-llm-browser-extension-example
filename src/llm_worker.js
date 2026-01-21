import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';

function returnPartialResults(partialResults, complete) {
  self.postMessage({ type: "result", payload: { partialResults, complete } });
}

let llmInference = null;
async function initialize(modelStream, wasmUrl) {
  const genaiFileset = await FilesetResolver.forGenAiTasks(wasmUrl);

  llmInference = await LlmInference.createFromOptions(genaiFileset, {
    baseOptions: { modelAssetBuffer: modelStream },  // Use modelAssetPath
    // instead for URLs.
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
    // For multimodal (Gemma 3n) options and more documentation, see
    // https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js
  });
}

self.onmessage = async (event) => {
  const { type, payload } = event.data;

  if (type === "init") {
    await initialize(payload.modelStream.getReader(), payload.wasmUrl);
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
        llmInference.generateResponse(payload.query, returnPartialResults);
        break;
    }
};