// ---------------------------------------------------------------------------
// content.js — harvests the OP and its first-level replies from an X post page.
//
// Two things collect replies, on purpose:
//   1. A MutationObserver harvests rows the moment they mount. X virtualises
//      the timeline, so a row can appear and be unmounted again between two
//      scroll steps — the observer is what makes an uncapped read safe to run
//      fast without losing replies in the gap.
//   2. The scroll loop harvests too, as a backstop, and owns termination.
//
// Everything is keyed by status id into a Map, so double-harvesting is free.
// ---------------------------------------------------------------------------

(() => {
  if (window.__replyzrInstalled) return;
  window.__replyzrInstalled = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let abort = false;
  let lastReport = 0;

  function report(text, force) {
    const now = Date.now();
    // Also a heartbeat: each message resets the service worker's idle timer,
    // which is what keeps a 20-minute read alive.
    if (!force && now - lastReport < 3000) return;
    lastReport = now;
    try {
      chrome.runtime.sendMessage({ type: "replyzr-progress", text });
    } catch (_) {
      /* worker asleep — progress is cosmetic */
    }
  }

  // --- parsing helpers -----------------------------------------------------

  function parseCount(raw) {
    if (!raw) return 0;
    const s = String(raw).replace(/[,\u00a0\s]/g, "");
    const m = s.match(/(\d+(?:\.\d+)?)([KMB])?/i);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    const suffix = (m[2] || "").toUpperCase();
    if (suffix === "K") n *= 1e3;
    else if (suffix === "M") n *= 1e6;
    else if (suffix === "B") n *= 1e9;
    return Math.round(n);
  }

  // The aria-label carries the exact count ("1234 Likes. Like"); the visible
  // text is abbreviated ("1.2K"). Prefer the label, fall back to the text.
  function likeCount(article) {
    const btn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    if (!btn) return 0;
    const label = (btn.getAttribute("aria-label") || "").replace(/[,\u00a0]/g, "");
    const m = label.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
    return parseCount(btn.textContent);
  }

  function statusLink(article) {
    const time = article.querySelector('a[href*="/status/"] time');
    const anchor = time && time.closest("a");
    if (!anchor) return null;
    const m = (anchor.getAttribute("href") || "").match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    return {
      handle: m[1].toLowerCase(),
      id: m[2],
      timestamp: time.getAttribute("datetime") || null
    };
  }

  // Direct replies on a status page normally render no "Replying to" line.
  // When one is present and it doesn't name the OP author, we're looking at a
  // nested reply — level 2 or deeper — so it gets dropped.
  function replyingToHandles(article) {
    const text = article.innerText || "";
    const idx = text.indexOf("Replying to");
    if (idx === -1) return null;
    const segment = text.slice(idx, idx + 240);
    return (segment.match(/@[A-Za-z0-9_]+/g) || []).map((h) => h.slice(1).toLowerCase());
  }

  function extract(article, link) {
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const nameNode = article.querySelector('[data-testid="User-Name"]');
    return {
      id: link.id,
      handle: link.handle,
      displayName: nameNode ? (nameNode.innerText || "").split("\n")[0] : link.handle,
      text: textNode ? textNode.innerText.trim() : "",
      likes: likeCount(article),
      timestamp: link.timestamp,
      url: `https://x.com/${link.handle}/status/${link.id}`,
      hasMedia: !!article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]')
    };
  }

  function isEndOfConversation(cell) {
    const t = (cell.innerText || "").trim();
    return /^(Discover more|More Tweets|More posts|More replies you might like|Trending now|Who to follow)/i.test(t);
  }

  // --- one harvesting pass over the currently mounted rows -----------------

  function harvest(state) {
    const cells = document.querySelectorAll('div[data-testid="cellInnerDiv"]');
    // Once the OP has been seen in an earlier pass it may have been unmounted
    // above us, so anything left is downstream of it — except the ancestor
    // tweets recorded on the way in.
    let pastOp = state.opSeen;

    for (const cell of cells) {
      if (isEndOfConversation(cell)) {
        state.reachedEnd = true;
        break;
      }
      const article = cell.querySelector('article[data-testid="tweet"]');
      if (!article) continue;
      if (article.closest('[data-testid="placementTracking"]')) continue; // promoted

      const link = statusLink(article);
      if (!link) continue;

      if (link.id === state.targetId) {
        state.op = extract(article, link);
        state.opSeen = true;
        pastOp = true;
        continue;
      }

      if (!pastOp) {
        state.ancestors.add(link.id); // parent thread rendered above the OP
        continue;
      }
      if (state.ancestors.has(link.id)) continue;

      const parents = replyingToHandles(article);
      const opHandle = state.op ? state.op.handle : state.targetHandle;
      if (parents && opHandle && !parents.includes(opHandle)) continue; // nested

      const row = extract(article, link);
      row.isSelfReply = !!opHandle && row.handle === opHandle;

      const prev = state.replies.get(link.id);
      // Keep the larger like count: a row re-rendering mid-scroll can briefly
      // report 0 before the counter hydrates.
      if (prev) {
        prev.likes = Math.max(prev.likes, row.likes);
        if (!prev.text && row.text) prev.text = row.text;
      } else {
        state.replies.set(link.id, row);
      }
    }
  }

  // Harvest on every DOM mutation, throttled. This is what lets the scroll
  // loop move faster than the render cycle without dropping rows.
  function watch(state) {
    let queued = null;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = null;
        try {
          harvest(state);
        } catch (_) {}
      }, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (queued) clearTimeout(queued);
      observer.disconnect();
    };
  }

  // --- buttons X puts in the way -------------------------------------------

  function clickMatching(pattern, limit) {
    let clicked = 0;
    for (const btn of document.querySelectorAll('[role="button"], button')) {
      const label = (btn.innerText || "").trim();
      if (!label || label.length > 90) continue;
      if (pattern.test(label)) {
        btn.click();
        if (++clicked >= (limit || 3)) break;
      }
    }
    return clicked;
  }

  const MORE = /^(Show more replies|Show more|More replies)/i;
  const FLAGGED = /^(Show additional replies|Show probable spam|Show likely spam)/i;
  const RETRY = /^(Retry|Try again|Reload)$/i;

  function timelineErrored() {
    const t = document.body.innerText || "";
    return /Something went wrong\.? ?(Try reloading|Try again)/i.test(t);
  }

  const atBottom = () =>
    window.innerHeight + window.scrollY >=
    document.documentElement.scrollHeight - 400;

  // --- main collect loop ---------------------------------------------------

  async function collect(opts) {
    const cfg = Object.assign(
      {
        maxReplies: 0,
        maxScrolls: 0,
        maxRunMinutes: 0,
        scrollDelayMs: 550,
        idleWaitCeilingMs: 6000,
        idleRounds: 8,
        expandMoreReplies: true,
        expandFlaggedReplies: false,
        recoverFromErrors: true,
        excludeOpSelfReplies: true
      },
      opts || {}
    );

    abort = false;

    const path = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!path) throw new Error("This tab isn't showing a post page.");

    const state = {
      targetHandle: path[1].toLowerCase(),
      targetId: path[2],
      op: null,
      opSeen: false,
      reachedEnd: false,
      ancestors: new Set(),
      replies: new Map()
    };

    // 0 means no limit.
    const capReplies = cfg.maxReplies > 0 ? cfg.maxReplies : Infinity;
    const capScrolls = cfg.maxScrolls > 0 ? cfg.maxScrolls : Infinity;
    const deadline = cfg.maxRunMinutes > 0 ? Date.now() + cfg.maxRunMinutes * 60000 : Infinity;

    // Wait for the post itself to mount.
    for (let i = 0; i < 40 && !state.opSeen; i++) {
      harvest(state);
      if (state.opSeen) break;
      await sleep(250);
    }
    if (!state.op) throw new Error("Couldn't find the post on this page. Reload the tab and retry.");

    const unwatch = watch(state);
    const startY = window.scrollY;
    const startedAt = Date.now();

    let idle = 0;
    let steps = 0;
    let wait = cfg.scrollDelayMs;
    let recoveries = 0;
    // Why the read stopped. This is reported verbatim — "the thread ended"
    // and "the timeline stopped responding" must never look the same.
    let ended = null;

    try {
      while (true) {
        if (abort) {
          ended = "stopped";
          break;
        }
        if (steps >= capScrolls) {
          ended = "scrolls";
          break;
        }
        if (Date.now() > deadline) {
          ended = "timeout";
          break;
        }
        steps++;

        const before = state.replies.size;
        harvest(state);

        if (state.reachedEnd) {
          ended = "end-of-thread";
          break;
        }
        if (state.replies.size >= capReplies) {
          ended = "cap";
          break;
        }

        if (state.replies.size > before) {
          idle = 0;
          wait = cfg.scrollDelayMs;
          report(`${state.replies.size} replies…`);
        } else {
          // Nothing new. Work through the reasons that might be, cheapest
          // first, before spending an idle round on it.
          if (cfg.recoverFromErrors && timelineErrored() && clickMatching(RETRY, 1)) {
            recoveries++;
            report(`Timeline stalled — retrying (${recoveries})…`, true);
            await sleep(2500);
            continue;
          }
          if (cfg.expandMoreReplies && clickMatching(MORE, 3)) {
            await sleep(wait);
            continue;
          }
          if (cfg.expandFlaggedReplies && clickMatching(FLAGGED, 3)) {
            await sleep(wait);
            continue;
          }

          idle++;
          report(`${state.replies.size} replies — waiting for more…`);
          // Back off while the network catches up rather than declaring the
          // thread finished the moment a page load is slow.
          wait = Math.min(cfg.idleWaitCeilingMs, Math.round(wait * 1.6));
          if (idle >= cfg.idleRounds && atBottom()) {
            ended = "exhausted"; // bottom of the page, X offered nothing more
            break;
          }
          if (idle >= cfg.idleRounds * 3) {
            ended = "stalled"; // not at the bottom and nothing is loading
            break;
          }
        }

        window.scrollBy(0, Math.round(window.innerHeight * 0.85));
        await sleep(wait);
      }
    } finally {
      unwatch();
    }

    harvest(state);
    window.scrollTo(0, startY);

    let replies = [...state.replies.values()];
    const selfReplies = replies.filter((r) => r.isSelfReply).length;
    if (cfg.excludeOpSelfReplies) replies = replies.filter((r) => !r.isSelfReply);
    replies = replies.filter((r) => r.text || r.hasMedia);
    if (capReplies !== Infinity) replies = replies.slice(0, capReplies);

    return {
      op: state.op,
      replies,
      selfRepliesSkipped: cfg.excludeOpSelfReplies ? selfReplies : 0,
      ended,
      capped: ended === "cap",
      timedOut: ended === "timeout",
      aborted: ended === "stopped",
      stalled: ended === "stalled",
      recoveries,
      scrollSteps: steps,
      readSeconds: Math.round((Date.now() - startedAt) / 1000),
      // Only these two mean X had nothing left to give.
      completeThread: ended === "end-of-thread" || ended === "exhausted",
      sortedByLikes: new URLSearchParams(location.search).get("sort_replies") === "likes",
      url: location.href
    };
  }

  // --- messaging -----------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === "stop") {
      abort = true;
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === "scrape") {
      collect(msg.opts)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true; // async
    }
    return false;
  });
})();
