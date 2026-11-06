// Scrollbars that float over what they scroll. The browser's own bar is hidden, so nothing keeps a strip
// beside the content, and the branded thumb is the area's own ::before box: sticky at the top of what
// shows, moved to where the scroll is, taking no room. It adds no element, so code that walks or replaces
// the area's children never meets it. The area is a block or a flex column, never a grid or a flex row:
// a sticky box in a grid only moves within its own cell. Import-free: the page runtime bundles it.

export const OVERLAY_SCROLL_ATTRIBUTE = 'data-overlay-scroll';

// The canonical branded thumb: 8px wide, the foreground at 45%, a strong line around it.
export const OVERLAY_SCROLLBAR_CSS = [
  '[data-overlay-scroll] { scrollbar-width:none; }',
  '[data-overlay-scroll]::-webkit-scrollbar { display:none; width:0; height:0; }',
  '[data-overlay-scroll]::before { content:""; position:sticky; top:0; z-index:var(--overlay-z, 9); display:none; flex:none; align-self:flex-end; box-sizing:border-box; width:8px; height:var(--overlay-size, 0px); margin:0 calc(-1 * var(--overlay-pad-right, 0px)) calc(-1 * (var(--overlay-size, 0px) + var(--overlay-gap, 0px))) auto; transform:translateY(var(--overlay-offset, 0px)); background:rgba(var(--hermes-fg-rgb),0.45); border:1px solid var(--hermes-line-strong); cursor:default; }',
  '[data-overlay-scroll="shown"]::before { display:block; }',
].join('\n');

const THUMB_INSET = 2;
const THUMB_MIN = 24;
const THUMB_WIDTH = 8;

export function overlayThumbGeometry({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, minSize = THUMB_MIN, inset = THUMB_INSET } = {}) {
  const track = Math.max(0, Number(clientHeight) - inset * 2);
  const range = Number(scrollHeight) - Number(clientHeight);
  if (!(range > 1) || track <= 0) return { visible: false, size: 0, offset: 0 };
  const size = Math.min(track, Math.max(minSize, Math.round(track * clientHeight / scrollHeight)));
  const progress = Math.max(0, Math.min(1, Number(scrollTop) / range));
  return { visible: true, size, offset: Math.round(inset + (track - size) * progress) };
}

export function overlayLayoutSupported(style) {
  const display = String(style?.display || '');
  if (/grid/.test(display)) return false;
  return !/flex/.test(display) || /column/.test(String(style?.flexDirection || ''));
}

// `refresh` re-places the thumb after changes it cannot see; `detach` gives the area its browser bar back.
// Pass watchResize:false for areas rebuilt with each render, so no ResizeObserver outlives them.
export function attachOverlayScrollbar(scroller, { documentRef = scroller?.ownerDocument, watchResize = true } = {}) {
  const none = { refresh() {}, detach() {} };
  if (!scroller || !documentRef) return none;
  const view = documentRef.defaultView || globalThis;
  const computed = () => view.getComputedStyle?.(scroller) || null;
  if (computed() && !overlayLayoutSupported(computed())) return none;
  let frame = 0;
  let drag = null;
  let attached = true;
  let current = { visible: false, size: 0, offset: 0 };
  const written = new Map();
  const write = (name, value) => {
    if (written.get(name) === value) return;
    written.set(name, value);
    scroller.style.setProperty(name, value);
  };
  const geometry = () => overlayThumbGeometry({
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  });
  const place = () => {
    frame = 0;
    if (!attached) return;
    const style = computed();
    current = geometry();
    const flexColumn = /flex/.test(String(style?.display || ''));
    // The ::before box sits under the top padding until the area has scrolled past it, then sticks.
    const stuckAt = Math.max(0, (parseFloat(style?.paddingTop) || 0) - scroller.scrollTop);
    write('--overlay-pad-right', `${parseFloat(style?.paddingRight) || 0}px`);
    write('--overlay-gap', flexColumn ? `${parseFloat(style?.rowGap) || 0}px` : '0px');
    write('--overlay-size', `${current.size}px`);
    write('--overlay-offset', `${current.offset - stuckAt}px`);
    const state = current.visible ? 'shown' : '';
    if (scroller.getAttribute(OVERLAY_SCROLL_ATTRIBUTE) !== state) scroller.setAttribute(OVERLAY_SCROLL_ATTRIBUTE, state);
  };
  const schedule = () => {
    if (frame || !attached) return;
    if (typeof view.requestAnimationFrame === 'function') frame = view.requestAnimationFrame(place);
    else place();
  };

  const onThumb = (event) => {
    if (!current.visible) return false;
    const box = scroller.getBoundingClientRect();
    const right = box.left + scroller.clientLeft + scroller.clientWidth;
    const top = box.top + scroller.clientTop + current.offset;
    return event.clientX >= right - THUMB_WIDTH && event.clientX <= right && event.clientY >= top && event.clientY <= top + current.size;
  };
  const onPointerDown = (event) => {
    if (event.button !== 0 || event.target !== scroller || !onThumb(event)) return;
    event.preventDefault();
    drag = { y: event.clientY, top: scroller.scrollTop };
    scroller.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!drag) return;
    const travel = scroller.clientHeight - THUMB_INSET * 2 - current.size;
    if (travel <= 0) return;
    scroller.scrollTop = drag.top + (event.clientY - drag.y) * (scroller.scrollHeight - scroller.clientHeight) / travel;
  };
  const endDrag = () => { drag = null; };
  scroller.addEventListener('pointerdown', onPointerDown);
  scroller.addEventListener('pointermove', onPointerMove);
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);
  scroller.addEventListener('lostpointercapture', endDrag);
  scroller.addEventListener('scroll', schedule, { passive: true });

  // The thumb's own writes land in the area's style attribute; only other changes move it.
  const ownWrite = (record) => record.target === scroller && record.type === 'attributes' && record.attributeName === 'style';
  const mutations = typeof view.MutationObserver === 'function'
    ? new view.MutationObserver((records) => { if (!records.every(ownWrite)) schedule(); })
    : null;
  mutations?.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'style', 'class', 'open'] });
  const resize = watchResize && typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null;
  resize?.observe(scroller);

  scroller.setAttribute(OVERLAY_SCROLL_ATTRIBUTE, '');
  schedule();
  return {
    refresh: schedule,
    detach() {
      attached = false;
      if (frame && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(frame);
      frame = 0;
      mutations?.disconnect();
      resize?.disconnect();
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        scroller.removeEventListener(type, type === 'pointerdown' ? onPointerDown : type === 'pointermove' ? onPointerMove : endDrag);
      }
      scroller.removeEventListener('scroll', schedule);
      for (const name of written.keys()) scroller.style.removeProperty(name);
      scroller.removeAttribute(OVERLAY_SCROLL_ATTRIBUTE);
    },
  };
}

// Every element under `root` that matches `selector`, now and as they are added, gets the floating thumb.
// Those there at the start are watched for resizes; those added later are rebuilt with their screen.
export function installOverlayScrollbars(root, selector, { documentRef = root?.ownerDocument || root } = {}) {
  const view = documentRef?.defaultView || globalThis;
  const attached = new WeakSet();
  const attachTo = (element, watchResize) => {
    if (attached.has(element)) return;
    attached.add(element);
    attachOverlayScrollbar(element, { documentRef, watchResize });
  };
  const scan = (node, watchResize) => {
    if (node?.nodeType !== 1) return;
    if (node.matches?.(selector)) attachTo(node, watchResize);
    if (node.firstElementChild) node.querySelectorAll(selector).forEach((element) => attachTo(element, watchResize));
  };
  scan(root?.documentElement || root, true);
  const observer = typeof view.MutationObserver === 'function'
    ? new view.MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) scan(node, false);
    })
    : null;
  observer?.observe(root, { childList: true, subtree: true });
  return { disconnect: () => observer?.disconnect() };
}

export const OVERLAY_SCROLLBAR_API = Object.freeze({
  attribute: OVERLAY_SCROLL_ATTRIBUTE,
  css: OVERLAY_SCROLLBAR_CSS,
  overlayThumbGeometry,
  overlayLayoutSupported,
  attachOverlayScrollbar,
  installOverlayScrollbars,
});
