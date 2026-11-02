// Scrollbars that float over what they scroll. The browser's own bar is hidden, so nothing keeps a strip
// beside the content (a search box or a row runs right to the edge), and the branded thumb is drawn on top
// of the content's right edge while there is anything to scroll. Scrolling works as usual; the thumb drags.
// Import-free: the page runtime bundles it (scripts/build-content-runtime.mjs) and the side panel imports it.

export const OVERLAY_SCROLL_ATTRIBUTE = 'data-overlay-scroll';

// The thumb is the canonical branded one: 8px wide, the foreground at 45%, a strong line around it. The rail
// is a zero-height sticky first child, so the thumb stays in view while the content scrolls under it.
export const OVERLAY_SCROLLBAR_CSS = [
  '[data-overlay-scroll] { scrollbar-width:none; }',
  '[data-overlay-scroll]::-webkit-scrollbar { display:none; width:0; height:0; }',
  '.overlay-scroll-rail { position:sticky; top:0; z-index:9; display:block; flex:none; grid-column:1 / -1; height:0; margin-top:0; margin-bottom:0; padding:0; overflow:visible; pointer-events:none; }',
  '.overlay-scroll-thumb { position:absolute; top:0; right:0; width:8px; box-sizing:border-box; background:rgba(var(--hermes-fg-rgb),0.45); border:1px solid var(--hermes-line-strong); pointer-events:auto; touch-action:none; }',
  '.overlay-scroll-thumb[hidden] { display:none; }',
].join('\n');

const THUMB_INSET = 2;
const THUMB_MIN = 24;

// Where the thumb sits in the visible area and how tall it is, from how far the area is scrolled.
export function overlayThumbGeometry({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, minSize = THUMB_MIN, inset = THUMB_INSET } = {}) {
  const track = Math.max(0, Number(clientHeight) - inset * 2);
  const range = Number(scrollHeight) - Number(clientHeight);
  if (!(range > 1) || track <= 0) return { visible: false, size: 0, offset: 0 };
  const size = Math.min(track, Math.max(minSize, Math.round(track * clientHeight / scrollHeight)));
  const progress = Math.max(0, Math.min(1, Number(scrollTop) / range));
  return { visible: true, size, offset: Math.round(inset + (track - size) * progress) };
}

// Gives `scroller` the floating thumb. `refresh` re-places it (after content changes it cannot see);
// `detach` gives the area its plain browser bar back. Pass watchResize:false for short-lived areas that
// are rebuilt with each screen, so no ResizeObserver outlives them.
export function attachOverlayScrollbar(scroller, { documentRef = scroller?.ownerDocument, watchResize = true } = {}) {
  if (!scroller || !documentRef) return { refresh() {}, detach() {} };
  const view = documentRef.defaultView || globalThis;
  scroller.setAttribute(OVERLAY_SCROLL_ATTRIBUTE, '');
  const rail = documentRef.createElement('span');
  rail.className = 'overlay-scroll-rail';
  rail.setAttribute('aria-hidden', 'true');
  const thumb = documentRef.createElement('span');
  thumb.className = 'overlay-scroll-thumb';
  thumb.hidden = true;
  rail.append(thumb);
  let frame = 0;
  let drag = null;
  let attached = true;

  const geometry = () => overlayThumbGeometry({
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  });
  const place = () => {
    frame = 0;
    if (!attached) return;
    // Screens that replace the area's children take the rail with them: it always comes back first.
    if (scroller.firstChild !== rail) scroller.prepend(rail);
    const style = view.getComputedStyle?.(scroller);
    // The rail spans the padding box, so the thumb sits at the area's inner right edge.
    rail.style.marginLeft = `-${parseFloat(style?.paddingLeft) || 0}px`;
    rail.style.marginRight = `-${parseFloat(style?.paddingRight) || 0}px`;
    const next = geometry();
    thumb.hidden = !next.visible;
    if (!next.visible) return;
    // Until it sticks (while padding above it is still in view) the rail sits lower than the top.
    const railTop = rail.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (scroller.clientTop || 0);
    thumb.style.height = `${next.size}px`;
    thumb.style.transform = `translateY(${next.offset - railTop}px)`;
  };
  const schedule = () => {
    if (frame || !attached) return;
    if (typeof view.requestAnimationFrame === 'function') frame = view.requestAnimationFrame(place);
    else place();
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { y: event.clientY, top: scroller.scrollTop };
    thumb.setPointerCapture?.(event.pointerId);
    thumb.dataset.dragging = '';
  };
  const onPointerMove = (event) => {
    if (!drag) return;
    const travel = scroller.clientHeight - THUMB_INSET * 2 - geometry().size;
    if (travel <= 0) return;
    scroller.scrollTop = drag.top + (event.clientY - drag.y) * (scroller.scrollHeight - scroller.clientHeight) / travel;
  };
  const endDrag = () => {
    drag = null;
    delete thumb.dataset.dragging;
  };
  thumb.addEventListener('pointerdown', onPointerDown);
  thumb.addEventListener('pointermove', onPointerMove);
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);
  thumb.addEventListener('lostpointercapture', endDrag);
  scroller.addEventListener('scroll', schedule, { passive: true });

  // Content and visibility changes move the thumb; its own moves (inside the rail) and the rail coming
  // back do not.
  const ownChange = (record) => rail.contains(record.target)
    || (record.type === 'childList' && record.target === scroller
      && [...record.addedNodes, ...record.removedNodes].every((node) => node === rail));
  const mutations = typeof view.MutationObserver === 'function'
    ? new view.MutationObserver((records) => { if (!records.every(ownChange)) schedule(); })
    : null;
  mutations?.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'style', 'class', 'open'] });
  const resize = watchResize && typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null;
  resize?.observe(scroller);

  scroller.prepend(rail);
  schedule();
  return {
    refresh: schedule,
    detach() {
      attached = false;
      if (frame && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(frame);
      frame = 0;
      mutations?.disconnect();
      resize?.disconnect();
      scroller.removeEventListener('scroll', schedule);
      rail.remove();
      scroller.removeAttribute(OVERLAY_SCROLL_ATTRIBUTE);
    },
  };
}

export const OVERLAY_SCROLLBAR_API = Object.freeze({
  attribute: OVERLAY_SCROLL_ATTRIBUTE,
  css: OVERLAY_SCROLLBAR_CSS,
  overlayThumbGeometry,
  attachOverlayScrollbar,
});
