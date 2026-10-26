'use strict';

// One server budget, including authorization and waiting for a shared refresh.
// Leave headroom before the browser's 65s timeout (and a typical 60s proxy).
const REQUEST_TIMEOUT_MS = 55000;
const timeout = () => Object.assign(new Error('Report deadline exceeded'), {
  code: 'TIMEOUT', status: 504,
  publicMessage: 'Истекло время загрузки справки. Повторите запрос.'
});
function remaining(deadline, now = Date.now) {
  const ms = Math.floor(deadline - now());
  if (ms <= 0) throw timeout();
  return ms;
}
async function within(work, deadline, now = Date.now) {
  const ms = remaining(deadline, now);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), ms); })
    ]);
    remaining(deadline, now);
    return result;
  } finally { clearTimeout(timer); }
}
module.exports = { REQUEST_TIMEOUT_MS, remaining, within };
