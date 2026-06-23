(function initLyricLensCard(root) {
  "use strict";

  function el(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function appendNote(parent, label, text) {
    if (!text) return;
    const note = el("div", "ll-note");
    note.appendChild(el("b", "", label));
    note.appendChild(el("span", "", text));
    parent.appendChild(note);
  }

  function renderHighlight(highlight, language) {
    if (typeof highlight === "string") {
      const node = el("section", "ll-highlight");
      const head = el("div", "ll-highlight-head");
      const separatorIndex = Math.max(highlight.indexOf("："), highlight.indexOf(":"));
      if (separatorIndex > 0) {
        head.appendChild(el("span", "ll-phrase", highlight.slice(0, separatorIndex)));
        head.appendChild(el("span", "ll-meaning", `：${highlight.slice(separatorIndex + 1)}`));
      } else {
        head.appendChild(el("span", "ll-meaning", highlight));
      }
      node.appendChild(head);
      return node;
    }
    const node = el("section", "ll-highlight");
    const head = el("div", "ll-highlight-head");
    head.appendChild(el("span", "ll-phrase", highlight.phrase || ""));
    if (language === "ja" && highlight.reading) {
      head.appendChild(el("span", "ll-reading", highlight.reading));
    }
    head.appendChild(el("span", "ll-arrow", "→"));
    head.appendChild(el("span", "ll-meaning", highlight.meaning || ""));
    node.appendChild(head);

    if (language === "ja") {
      appendNote(node, "文法", highlight.grammar);
    } else {
      appendNote(node, "发音", highlight.pronunciation);
    }
    appendNote(node, "语境", highlight.context);
    return node;
  }

  function renderCard(card, language) {
    const fragment = root.document.createDocumentFragment();
    const meta = el("div", "ll-current-meta");
    const lineIndex = card.lineIndex ?? card.index ?? 0;
    const startMs = Number(card.startMs ?? card.startTime);
    const time = Number.isFinite(startMs)
      ? `${String(Math.floor(startMs / 60000)).padStart(2, "0")}:${String(Math.floor((startMs % 60000) / 1000)).padStart(2, "0")}`
      : "";
    meta.appendChild(el("span", "", `LINE ${String(lineIndex).padStart(2, "0")}${time ? `  ${time}` : ""}`));
    fragment.appendChild(meta);

    // Prefer card.original — it's pinned to the real lyricLine.text via the
    // resolved index (api.js:347), so it stays correct even when the LLM
    // labels a card with the wrong lineIndex. card.line carries the LLM's
    // raw "original" field, which can drift to an off-by-N lyric.
    fragment.appendChild(el("h2", "ll-line", card.original || card.line || ""));
    fragment.appendChild(el("div", "ll-translation", card.translation || ""));
    fragment.appendChild(el("div", "ll-section-label", "学习点"));

    const list = el("div", "ll-highlight-list");
    if (Array.isArray(card.highlights) && card.highlights.length) {
      card.highlights.forEach((highlight) => list.appendChild(renderHighlight(highlight, language)));
    } else {
      list.appendChild(el("div", "ll-empty-point", "这一句以语气和情绪表达为主。"));
    }
    fragment.appendChild(list);
    if (typeof card.note === "string" && card.note.trim()) {
      const noteNode = el("div", "ll-note");
      noteNode.appendChild(el("b", "", "注释"));
      noteNode.appendChild(el("span", "", card.note));
      fragment.appendChild(noteNode);
    }
    return fragment;
  }

  function renderMessage(message, className = "ll-empty") {
    const wrapper = el("div", className, message);
    return wrapper;
  }

  const api = { el, renderCard, renderHighlight, renderMessage };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Card = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
