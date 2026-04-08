// src/ui/dom.js
// Tiny DOM helpers — avoid a framework dependency for ~500 lines of UI.
// All text goes through createText() to prevent XSS (never innerHTML with
// user-controlled data).

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

/**
 * Create an element with attributes and children.
 * Children can be strings (text nodes), Nodes, or null.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    } else {
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * Clear an element's children.
 */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Show/hide an element via the `hidden` attribute.
 */
export function show(node, visible = true) {
  if (!node) return;
  if (visible) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}
