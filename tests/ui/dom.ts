import { JSDOM } from 'jsdom';

let installed: JSDOM | null = null;

export function installDom(): JSDOM {
  if (installed) return installed;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
  const Pointer = dom.window.MouseEvent;
  Object.defineProperty(dom.window, 'PointerEvent', { configurable: true, value: Pointer });
  Object.defineProperty(globalThis, 'PointerEvent', { configurable: true, writable: true, value: Pointer });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  installed = dom;
  return dom;
}

installDom();
