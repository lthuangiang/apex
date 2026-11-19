/* global window, document, requestAnimationFrame */
// Minimal runtime for the design mockups in this folder (not product code).
// Renders a <template id="dc-tpl"> with {{holes}}, <sc-for>, <sc-if> and onClick="{{fn}}",
// using the Component class defined on the page, and patches the DOM in place on setState.
(function () {
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch) { this.state = Object.assign({}, this.state, patch); schedule(); }
    forceUpdate() { schedule(); }
  }
  window.DCLogic = DCLogic;

  let inst, root, tpl, queued = false, handlers = [];
  const get = (scope, path) => {
    if (path === 'true') return true;
    if (path === 'false') return false;
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
  };
  const hole = /\{\{\s*([\w.$]+)\s*\}\}/g;
  const whole = /^\{\{\s*([\w.$]+)\s*\}\}$/;

  function renderNode(node, scope, out) {
    if (node.nodeType === 3) {
      out.appendChild(document.createTextNode(node.nodeValue.replace(hole, (_, p) => { const v = get(scope, p); return v == null ? '' : String(v); })));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'sc-for') {
      const m = (node.getAttribute('list') || '').match(whole);
      const list = (m && get(scope, m[1])) || [];
      const as = node.getAttribute('as') || 'item';
      list.forEach((item, i) => {
        const s = Object.create(scope); s[as] = item; s.$index = i;
        node.childNodes.forEach((c) => renderNode(c, s, out));
      });
      return;
    }
    if (tag === 'sc-if') {
      const m = (node.getAttribute('value') || '').match(whole);
      if (m && get(scope, m[1])) node.childNodes.forEach((c) => renderNode(c, scope, out));
      return;
    }
    const el = document.createElementNS(node.namespaceURI, node.tagName);
    for (const a of node.attributes) {
      if (/^hint-/.test(a.name)) continue;
      const w = a.value.match(whole);
      if (/^on[a-z]/i.test(a.name) && w) {
        const fn = get(scope, w[1]);
        if (typeof fn === 'function') { el.setAttribute('data-dc-on', a.name.slice(2).toLowerCase() + ':' + handlers.length); handlers.push(fn); }
        continue;
      }
      if (w) {
        const v = get(scope, w[1]);
        if (v === false || v == null) continue;
        el.setAttribute(a.name, v === true ? '' : String(v));
        continue;
      }
      el.setAttribute(a.name, a.value.replace(hole, (_, p) => { const v = get(scope, p); return v == null ? '' : String(v); }));
    }
    const src = tag === 'template' ? node.content : node;
    src.childNodes.forEach((c) => renderNode(c, scope, el));
    out.appendChild(el);
  }

  function patch(cur, next) {
    const a = cur.childNodes, b = next.childNodes;
    let i = 0;
    for (; i < b.length; i++) {
      const n = b[i], c = a[i];
      if (!c) { cur.appendChild(n.cloneNode(true)); continue; }
      if (c.nodeType !== n.nodeType || c.nodeName !== n.nodeName) { cur.replaceChild(n.cloneNode(true), c); continue; }
      if (n.nodeType === 3) { if (c.nodeValue !== n.nodeValue) c.nodeValue = n.nodeValue; continue; }
      for (const at of Array.from(c.attributes)) if (!n.hasAttribute(at.name)) c.removeAttribute(at.name);
      for (const at of n.attributes) if (c.getAttribute(at.name) !== at.value) c.setAttribute(at.name, at.value);
      patch(c, n);
    }
    while (a.length > b.length) cur.removeChild(cur.lastChild);
  }

  function render() {
    queued = false;
    handlers = [];
    const vals = inst.renderVals();
    const frag = document.createElement('div');
    tpl.content.childNodes.forEach((c) => renderNode(c, vals, frag));
    patch(root, frag);
  }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(render); } }

  window.addEventListener('DOMContentLoaded', () => {
    tpl = document.getElementById('dc-tpl');
    root = document.getElementById('dc-root');
    inst = new window.Component(window.DC_PROPS || {});
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-dc-on^="click:"]');
      if (!t) return;
      const fn = handlers[Number(t.getAttribute('data-dc-on').split(':')[1])];
      if (fn) fn(e);
    });
    render();
    if (inst.componentDidMount) inst.componentDidMount();
  });
})();
