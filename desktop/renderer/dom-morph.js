/* ---------------- ATO-824: rebuild a subtree without replacing what did not change ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/dom-morph.test.mjs).

   A streaming reply repaints the transcript column on every frame
   (renderer.js repaintTranscript). Setting innerHTML threw away every node
   in it, so a code block's Copy button was a new element each frame: the
   pointer's hover flickered, and a press that began on one button and ended
   on the next never became a click, so Copy did nothing while the reply was
   still coming.

   morphChildren(into, from) makes `into`'s children match `from`'s (a parsed
   copy of the new markup) and keeps every node it can: an equal node is left
   alone, an element of the same tag (and the same id, when it has one) keeps
   its identity with its attributes brought in line and its children morphed
   the same way, a text node takes the new text. Only what differs is
   replaced. Nodes of `from` are moved into `into`, so `from` is spent. */

function morphSameKind(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  return a.nodeType !== 1 || (a.getAttribute('id') || '') === (b.getAttribute('id') || '');
}

function morphAttributes(el, want) {
  for (const at of Array.from(el.attributes)) if (!want.hasAttribute(at.name)) el.removeAttribute(at.name);
  for (const at of Array.from(want.attributes)) if (el.getAttribute(at.name) !== at.value) el.setAttribute(at.name, at.value);
}

function morphChildren(into, from) {
  let have = into.firstChild;
  let want = from.firstChild;
  while (want) {
    const nextWant = want.nextSibling;
    if (!have) {
      into.appendChild(want);
    } else if (have.isEqualNode(want)) {
      have = have.nextSibling;
    } else if (morphSameKind(have, want)) {
      if (have.nodeType === 1) { morphAttributes(have, want); morphChildren(have, want); }
      else if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
      have = have.nextSibling;
    } else {
      into.insertBefore(want, have);
    }
    want = nextWant;
  }
  while (have) {
    const next = have.nextSibling;
    into.removeChild(have);
    have = next;
  }
}

if (typeof module !== 'undefined') module.exports = {morphChildren, morphSameKind, morphAttributes};
