chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'pelco-toggle' }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pelco-get-settings') {
    chrome.storage.local.get(
      {
        opacity: 0.85,
        pinned: true,
        visible: true,
      },
      (data) => sendResponse(data),
    );
    return true;
  }
  if (msg?.type === 'pelco-set-settings') {
    chrome.storage.local.set(msg.payload || {}, () => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
