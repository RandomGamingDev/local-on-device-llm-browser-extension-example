const RUNTIME = typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
const OFFSCREEN_PATH = "src/offscreen.html";

let offscreen_port = null;
let promised_offscreen_document = null; 
let offscreenReady = false;

// Manifest V3 (which is anti-ad bs btw) likes disabling stuff so this is for reenabling if disabled
// Generate offscreen only if no prior created version is still active, and ensure persistent port connection
// Returns port
async function createOffscreen() {
  const client = (await RUNTIME.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [RUNTIME.getURL(OFFSCREEN_PATH)]
  }))[0];

  // If the offscreen port's open return it
  if (offscreen_port)
    return offscreen_port;

  // If the offscreen port's gone, but page is still there, then regenerate the port 
  if (client && !offscreen_port) {
    offscreen_port = RUNTIME.connect({ name: "offscreen-worker-port" });
    offscreen_port.onDisconnect.addListener(() => offscreen_port = null);
    console.log("MediaPipe Local Server: Re-established Offscreen Port for existing Offscreen Document.");
    return offscreen_port;
  }
  
  // Wait for the document to finish generating if it's still being created
  if (promised_offscreen_document)
    return promised_offscreen_document;

  // If the offscreen page's gone (re)create it

  // Store the creation Promise to block simultaneous creation attempts.
  promised_offscreen_document = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH, 
      reasons: ["WORKERS"], 
      justification: "Running Local MediaPipe LLM inference."
  });
  // Wait for the document to be ready.
  await promised_offscreen_document;
  // Then clear the lock when ready
  promised_offscreen_document = null;

  // Wait for the offscreen document to signal it's ready
  await new Promise((resolve) => {
    const listener = (message, sender) => {
      if (message.type === 'offscreen_ready' && sender.url.endsWith(OFFSCREEN_PATH)) {
        RUNTIME.onMessage.removeListener(listener);
        resolve();
      }
    };
    RUNTIME.onMessage.addListener(listener);
  });

  // (Re)create the persistent port connection.
  offscreen_port = RUNTIME.connect({ name: "offscreen-worker-port" });
  offscreen_port.onDisconnect.addListener(() => offscreen_port = null);
  
  console.log("MediaPipe Local Server: New Offscreen Document created and connected.");
  offscreenReady = true;

  return offscreen_port;
}

createOffscreen();

RUNTIME.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (message === 'is_ready') {
      sendResponse(offscreenReady);
    }
  }
);


RUNTIME.onConnect.addListener(async (popup_port) => {
  if (popup_port.name != "mediapipe-llm")
    return;

  const activeOffscreenPort = await createOffscreen();
  // Make sure that the port can actually be created
  if (!activeOffscreenPort) {
    console.error("Could not establish persistent connection to Offscreen Document.");
    return;
  }

  // Relays between background worker and offscreen page
  const popupListener = (msg) => activeOffscreenPort.postMessage(msg);
  popup_port.onMessage.addListener(popupListener);
  const offscreenListener = (msg) => popup_port.postMessage(msg);
  activeOffscreenPort.onMessage.addListener(offscreenListener);

  // Clean up relays when disconnected
  popup_port.onDisconnect.addListener(() => {
      popup_port.onMessage.removeListener(popupListener);
      activeOffscreenPort.onMessage.removeListener(offscreenListener);
      
      console.log("MediaPipe Local Server: Popup port disconnected.");
  });
});