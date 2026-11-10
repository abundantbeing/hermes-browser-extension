(() => {
  const start = () => {
    globalThis.hermesBrowserApi = globalThis.browser || globalThis.chrome || null;
  };
  if (typeof globalThis.hermesAwaitPageScriptPolicy === 'function') {
    globalThis.hermesAwaitPageScriptPolicy(start);
  } else {
    start();
  }
})();
