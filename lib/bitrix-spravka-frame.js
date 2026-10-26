'use strict';

// The native portal marks a frame connected when it receives a valid SDK
// message. Without that signal it probes the website root with no-cors fetch;
// that separate host probe may fail even though the frame loaded successfully.
// Use the SDK's initial message, but request NO callback: OAuth data stays in
// the parent portal. This is presentation-only, never an authentication check.
function notifyBitrixFrame() {
  try {
    if (window.parent === window) return;
    const context = String(window.name || '').split('|');
    if (context.length !== 3 || context[0] !== 'interpain.bitrix24.ru' ||
        context[1] !== '1' || !/^[a-f0-9]{32}$/i.test(context[2])) return;
    window.parent.postMessage({
      method: 'getInitData', params: {}, callback: false, appSid: context[2]
    }, 'https://interpain.bitrix24.ru');
  } catch {
    // A blocked presentation bridge must not break the report/password UI.
  }
}

const FRAME_READY_SCRIPT = `<script id="spravka-bitrix-frame-ready">(${notifyBitrixFrame.toString()})();</script>`;

function withFrameReady(html) {
  // All entry templates have </html>; the report also has an explicit </head>.
  // Keep charset first and run before the report's own application scripts.
  return html.replace(/<\/head\s*>|<\/html\s*>/i, closing => FRAME_READY_SCRIPT + closing);
}

module.exports = { FRAME_READY_SCRIPT, withFrameReady };
