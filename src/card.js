(function initLyricLensCard(root) {
  "use strict";

  const POINT_TYPE_LABELS = {
    vocabulary: "词汇",
    grammar: "语法",
    culture: "文化背景",
    pronunciation: "发音",
    tone: "语感"
  };

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
    // Typed point: {type, text} (+ optional surface/reading since prompt v4)
    if (highlight && typeof highlight === "object" && typeof highlight.text === "string") {
      const node = el("section", "ll-highlight");
      const head = el("div", "ll-highlight-head");
      const typeLabel = POINT_TYPE_LABELS[highlight.type];
      if (typeLabel) {
        head.appendChild(el("span", "ll-highlight-type", typeLabel));
      }
      head.appendChild(el("span", "ll-meaning", highlight.text));
      appendDictSlots(head, highlight);
      node.appendChild(head);
      return node;
    }
    // Legacy {phrase, meaning, ...} shape — kept for old cached cards.
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

    // Only render the "学习点" section when there's actually something
    // typed to show — otherwise we used to print a misleading hardcoded
    // tone fallback. note remains the catch-all for general remarks.
    if (Array.isArray(card.highlights) && card.highlights.length) {
      fragment.appendChild(el("div", "ll-section-label", "学习点"));
      const list = el("div", "ll-highlight-list");
      card.highlights.forEach((highlight) => list.appendChild(renderHighlight(highlight, language)));
      fragment.appendChild(list);
    }
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

  // ── Dictionary badge slots + hydration ──────────────────────────
  //
  // Two-phase like the desktop host: renderHighlight emits empty slot
  // spans carrying the lookup key in data attributes; hydrateDictBadges
  // fills them from the in-memory stores. Lookups are synchronous here
  // (no IPC), but the stores bootstrap asynchronously after plugin
  // start — main.js re-renders once they're ready, and the panel
  // rebuilds its DOM on every render anyway, so hydration runs fresh
  // each time.

  function appendDictSlots(head, highlight) {
    // Only vocabulary/grammar points carry a dictionary form; see the
    // matching guard in api.js normalizePoints.
    if (highlight.type !== "vocabulary" && highlight.type !== "grammar") return;
    const surface = typeof highlight.surface === "string" ? highlight.surface.trim() : "";
    if (!surface) return;
    const reading = typeof highlight.reading === "string" ? highlight.reading.trim() : "";

    const jlpt = el("span", "ll-dict-slot ll-jlpt-slot");
    jlpt.dataset.surface = surface;
    jlpt.dataset.reading = reading;
    head.appendChild(jlpt);

    const enexam = el("span", "ll-dict-slot ll-enexam-slot");
    enexam.dataset.word = surface;
    head.appendChild(enexam);

    const cefrj = el("span", "ll-dict-slot ll-cefrj-slot");
    cefrj.dataset.word = surface;
    head.appendChild(cefrj);
  }

  function makeBadge(text, title) {
    const badge = el("span", "ll-dict-badge", text);
    badge.title = title;
    return badge;
  }

  function fillSlot(slot, badge) {
    slot.innerHTML = "";
    if (badge) slot.appendChild(badge);
  }

  // Fill every dict slot under rootNode from the current stores.
  // Idempotent: each call recomputes from scratch, so re-running after
  // a store becomes ready or targetExam changes is always safe.
  function hydrateDictBadges(rootNode, options = {}) {
    const Dicts = root.LyricLens?.Dicts;
    if (!Dicts || !rootNode?.querySelectorAll) return;
    const targetExam = options.targetExam || "off";

    for (const slot of Array.from(rootNode.querySelectorAll(".ll-jlpt-slot"))) {
      const entries = Dicts.jlptLookup(slot.dataset.surface, slot.dataset.reading || undefined);
      const label = Dicts.formatJlptBadgeLabel(entries);
      if (!label) {
        // Miss → no badge, no「未知」noise (schema doc §UI 渲染规则).
        fillSlot(slot, null);
        continue;
      }
      const marker = Dicts.jlptAmbiguityMarker(entries);
      fillSlot(slot, makeBadge(
        marker ? `${label}${marker}` : label,
        marker ? Dicts.JLPT_BADGE_TITLE_AMBIGUOUS : Dicts.JLPT_BADGE_TITLE
      ));
    }

    for (const slot of Array.from(rootNode.querySelectorAll(".ll-enexam-slot"))) {
      if (targetExam === "off") {
        fillSlot(slot, null);
        continue;
      }
      const tags = Dicts.enexamLookup(slot.dataset.word);
      // Only the user's selected exam system renders; the store returns
      // every tag so switching exams is a re-render, not a re-fetch.
      if (!tags.includes(targetExam)) {
        fillSlot(slot, null);
        continue;
      }
      fillSlot(slot, makeBadge(Dicts.EXAM_TAG_LABELS[targetExam] || targetExam, Dicts.EXAM_BADGE_TITLE));
    }

    for (const slot of Array.from(rootNode.querySelectorAll(".ll-cefrj-slot"))) {
      const level = Dicts.cefrjLookup(slot.dataset.word);
      fillSlot(slot, level ? makeBadge(level, Dicts.CEFRJ_BADGE_TITLE) : null);
    }
  }

  const api = { el, renderCard, renderHighlight, renderMessage, hydrateDictBadges };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Card = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
