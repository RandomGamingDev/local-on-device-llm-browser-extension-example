const OFFSCREEN_PATH = 'src/offscreen.html';
let offscreenPort = null;
let popupPort = null;

// Ensure local persistence
async function setupOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS'],
    justification: 'Keep LLM Worker alive for persistent inference'
  });
}

// Handle connections
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen') {
    offscreenPort = port;
    console.log('SW: Connected to Offscreen');

    // If popup is waiting or we have a queue, handle it.
    // For specific messages from Offscreen (like results), forward to Popup
    offscreenPort.onMessage.addListener((msg) => {
      // Forward to Popup if connected
      if (popupPort) {
        popupPort.postMessage(msg);
      }
    });

    offscreenPort.onDisconnect.addListener(() => {
      offscreenPort = null;
      console.log('SW: Offscreen disconnected. Recreating...');
      setupOffscreen();
    });
  } else if (port.name === 'popup') {
    popupPort = port;
    console.log('SW: Connected to Popup');

    // Ensure offscreen exists when popup connects
    setupOffscreen();

    // Forward messages from Popup to Offscreen
    popupPort.onMessage.addListener((msg) => {
      if (offscreenPort) {
        offscreenPort.postMessage(msg);
      } else {
        console.warn("SW: Offscreen port not ready, dropping message", msg);
      }
    });

    popupPort.onDisconnect.addListener(() => {
      popupPort = null;
      console.log('SW: Popup disconnected');
    });
  }
});

// Initialize on load
setupOffscreen();
