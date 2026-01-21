const OFFSCREEN_PATH = 'src/offscreen.html';
let offscreenPort = null;
let popupPort = null;

async function setupOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (existingContexts.length > 0)
    return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS'],
    justification: 'Keep LLM Worker alive for persistent inference'
  });
}

chrome.runtime.onConnect.addListener((port) => {
  switch (port.name) {
    case "offscreen":
      offscreenPort = port;
      console.log('SW: Connected to Offscreen');

      offscreenPort.onMessage.addListener((msg) => {
        if (popupPort)
          popupPort.postMessage(msg);
      });

      offscreenPort.onDisconnect.addListener(() => {
        offscreenPort = null;
        console.log('SW: Offscreen disconnected. Recreating...');
        setupOffscreen();
      });
      break;
    case "popup":
      popupPort = port;
      console.log('SW: Connected to Popup');

      setupOffscreen();

      popupPort.onMessage.addListener((msg) => {
        if (offscreenPort)
          offscreenPort.postMessage(msg);
        else
          console.warn("SW: Offscreen port not ready, dropping message", msg);
      });

      popupPort.onDisconnect.addListener(() => {
        popupPort = null;
        console.log('SW: Popup disconnected');
      });
      break;
  }
});

setupOffscreen();
