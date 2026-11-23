import { createBrowserControlApprovalStore } from '../../extension/lib/browser-control-safety.mjs';

// For tests that are not about the approval pause: grant each request as soon as it is registered.
export function autoApprovingStore(options) {
  const store = createBrowserControlApprovalStore(options);
  const originalRequest = store.request;
  store.request = (value) => {
    const promise = originalRequest(value);
    queueMicrotask(() => {
      const pending = store.pending().find((item) => item.approvalId === value.approvalId);
      if (pending) store.grant(pending);
    });
    return promise;
  };
  return store;
}
