const OFFSCREEN_PATH = 'src/offscreen.html';
let offscreenPort = null;
let contentPort = null;

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
        if (contentPort)
          contentPort.postMessage(msg);
      });

      offscreenPort.onDisconnect.addListener(() => {
        offscreenPort = null;
        console.log('SW: Offscreen disconnected. Recreating...');
        setupOffscreen();
      });
      break;
    case "content":
      contentPort = port;
      console.log('SW: Connected to Content Script');

      setupOffscreen();

      contentPort.onMessage.addListener((msg) => {
        if (offscreenPort)
          offscreenPort.postMessage(msg);
        else
          console.warn("SW: Offscreen port not ready, dropping message", msg);
      });

      contentPort.onDisconnect.addListener(() => {
        contentPort = null;
        console.log('SW: Content Script disconnected');
      });
      break;
  }
});

setupOffscreen();
