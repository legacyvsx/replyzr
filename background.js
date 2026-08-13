// ---------------------------------------------------------------------------
// background.js — orchestrator.
//
// The popup opens a port and says "run". Everything else happens here:
// switch the reply sort, drive the content script, batch the replies through
// the xAI API, aggregate, cache, report back.
//
// A long uncapped read can run for many minutes, which is longer than a MV3
// service worker's idle timeout. Two things keep this one alive: the content
// script's progress messages, and the keepalive ticker below. Both count as
// activity and reset the timer.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ports = new Set();
let running = false;
let keepAlive = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "replyzr") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (msg) => {
    if (!msg) return;

    if (msg.type === "stop") {
      try {
        await chrome.tabs.sendMessage(msg.tabId, { type: "stop" });
        progress("Stopping — will analyse what's been read so far…");
      } catch (_) {}
      return;
    }

    if (msg.type !== "run" || running) return;
    running = true;
    startKeepAlive();
    try {
      const result = await run(msg.tabId);
      broadcast({ type: "result", result });
    } catch (err) {
      broadcast({ type: "error", error: err && err.message ? err.message : String(err) });
    } finally {
      running = false;
      stopKeepAlive();
    }
  });
});

// Progress pings from the content script get forwarded to the popup.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "replyzr-progress") progress(msg.text);
});

function broadcast(msg) {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch (_) {}
  }
}
const progress = (text) => broadcast({ type: "progress", text });

// Touching an extension API every 20s resets the worker's idle countdown.
function startKeepAlive() {
  stopKeepAlive();
  keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
    broadcast({ type: "heartbeat" });
  }, 20000);
}
function stopKeepAlive() {
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
}

// --- tab plumbing ----------------------------------------------------------

function waitForComplete(tabId, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("The page took too long to load."));
    }, timeout);
    const listener = (id, info) => {
      if (id !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Two URLs are the same "view" if they point at the same post with the same
// reply sort. Share links carry junk params (?t=, ?s=) that don't matter.
function sameView(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.pathname === ub.pathname &&
      (ua.searchParams.get("sort_replies") || "") === (ub.searchParams.get("sort_replies") || "")
    );
  } catch (_) {
    return false;
  }
}

async function goTo(tabId, target, label) {
  const current = await chrome.tabs.get(tabId);
  if (sameView(current.url, target)) return;
  progress(label);
  await chrome.tabs.update(tabId, { url: target });
  await waitForComplete(tabId);
  await sleep(1200); // let X hydrate the timeline
}

async function ping(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  for (let i = 0; i < 20; i++) {
    if (await ping(tabId)) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (_) {}
    await sleep(400);
  }
  throw new Error("Can't reach the page. Reload the X tab and try again.");
}

// --- xAI -------------------------------------------------------------------

const SYSTEM_PROMPT = `You annotate replies to a social media post. You receive JSON with the original post ("op") and a list of "replies".

Return ONLY a JSON object shaped like:
{"results":[{"i":0,"sentiment":-0.6,"emotion":"anger","agreement":"disagree"}]}

Rules:
- Emit exactly one entry per reply and echo its "i" value.
- "sentiment": a number from -1.0 (very negative) to 1.0 (very positive); 0 is neutral. Judge the tone of the reply itself, not the tone of the post it answers.
- "emotion": exactly one label from this list: {{EMOTIONS}}. Pick the dominant one.
- "agreement": one of "agree", "disagree", "neutral" — does the reply endorse the OP's claim or stance? Jokes, tangents, questions and unrelated replies are "neutral".
- Read sarcasm and irony for intended meaning, not literal wording.
- Output JSON only. No prose, no markdown, no code fences.`;

function stripFences(s) {
  return String(s)
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

async function callXai(payload) {
  const body = {
    model: CONFIG.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT.replace("{{EMOTIONS}}", CONFIG.emotions.join(", ")) },
      { role: "user", content: JSON.stringify(payload) }
    ]
  };

  let lastError;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (attempt) await sleep(800 * Math.pow(2, attempt - 1));
    let res;
    try {
      res = await fetch(CONFIG.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (_) {
      lastError = new Error("Network error reaching api.x.ai.");
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("xAI rejected the API key. Check apiKey in config.js.");
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`xAI returned ${res.status}.`);
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`xAI returned ${res.status}: ${detail}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("xAI returned an empty response.");
    let parsed;
    try {
      parsed = JSON.parse(stripFences(content));
    } catch (_) {
      lastError = new Error("Couldn't parse the model's JSON.");
      continue;
    }
    return {
      results: Array.isArray(parsed.results) ? parsed.results : [],
      usage: data.usage || null
    };
  }
  throw lastError || new Error("xAI request failed.");
}

// Shared iterator: each worker pulls the next batch when it finishes one.
async function pool(items, limit, worker) {
  const queue = items.entries();
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (const [i, item] of queue) await worker(item, i);
  });
  await Promise.all(lanes);
}

async function analyse(op, replies) {
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const byIndex = new Map();

  const batches = [];
  for (let start = 0; start < replies.length; start += CONFIG.batchSize) {
    batches.push({ start, rows: replies.slice(start, start + CONFIG.batchSize) });
  }

  let done = 0;
  progress(`Analysing ${replies.length} replies in ${batches.length} batches…`);

  await pool(batches, CONFIG.concurrency, async (batch) => {
    const payload = {
      op: { author: op.handle, text: op.text.slice(0, 1000) },
      replies: batch.rows.map((r, idx) => ({
        i: batch.start + idx,
        author: r.handle,
        text: r.text ? r.text.slice(0, CONFIG.maxTextChars) : "(media only, no text)"
      }))
    };
    const { results, usage: u } = await callXai(payload);
    if (u) {
      usage.prompt_tokens += u.prompt_tokens || 0;
      usage.completion_tokens += u.completion_tokens || 0;
    }
    for (const r of results) {
      if (typeof r.i === "number") byIndex.set(r.i, r);
    }
    done++;
    progress(`Analysed batch ${done} of ${batches.length}…`);
  });

  const clamp = (n) => (Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : null);
  const normaliseEmotion = (e) => {
    const key = String(e || "").toLowerCase().trim();
    return CONFIG.emotions.includes(key) ? key : null;
  };

  const scored = replies.map((reply, i) => {
    const a = byIndex.get(i);
    return {
      ...reply,
      analysis: a
        ? {
            sentiment: clamp(Number(a.sentiment)),
            emotion: normaliseEmotion(a.emotion),
            agreement: ["agree", "disagree", "neutral"].includes(a.agreement) ? a.agreement : null
          }
        : null
    };
  });

  return { scored, usage, batches: batches.length };
}

// --- aggregation -----------------------------------------------------------

function ratioStats(opLikes, replies) {
  const out = { opLikes, count: 0, min: null, max: null, closest: null, best: null, note: null };
  if (!replies.length) return out;

  const sorted = [...replies].sort((a, b) => b.likes - a.likes);
  const top = sorted[0];

  if (opLikes <= 0) {
    const liked = sorted.filter((r) => r.likes > 0);
    out.count = liked.length;
    out.note = "The post has no likes, so every liked reply outscores it.";
    out.best = { likes: top.likes, handle: top.handle, url: top.url, ratio: null };
    return out;
  }

  out.best = { likes: top.likes, handle: top.handle, url: top.url, ratio: top.likes / opLikes };

  const beating = sorted.filter((r) => r.likes > opLikes);
  if (beating.length) {
    out.count = beating.length;
    out.max = beating[0].likes / opLikes;
    out.min = beating[beating.length - 1].likes / opLikes;
    return out;
  }

  if (out.best.ratio >= CONFIG.closeRatioThreshold) out.closest = out.best;
  else out.note = "Nothing came close.";
  return out;
}

function aggregate(replies, opLikes) {
  const scored = replies.filter((r) => r.analysis && typeof r.analysis.sentiment === "number");
  const avgSentiment = scored.length
    ? scored.reduce((sum, r) => sum + r.analysis.sentiment, 0) / scored.length
    : null;

  const counts = {};
  for (const r of replies) {
    const e = r.analysis && r.analysis.emotion;
    if (e) counts[e] = (counts[e] || 0) + 1;
  }
  const emotionTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => ({ label, n, pct: emotionTotal ? (n / emotionTotal) * 100 : 0 }));
  const topEmotions = ranked.slice(0, 2);
  // The two most common emotions rarely cover the whole set. Report the rest
  // so the percentages aren't left looking like they should add to 100.
  const emotionSpread = {
    labelled: emotionTotal,
    unlabelled: replies.length - emotionTotal,
    distinct: ranked.length,
    rest: ranked.slice(2)
  };

  const tally = { agree: 0, disagree: 0, neutral: 0, unknown: 0 };
  for (const r of replies) {
    const a = r.analysis && r.analysis.agreement;
    tally[a || "unknown"]++;
  }
  const judged = tally.agree + tally.disagree + tally.neutral;

  return {
    n: replies.length,
    analysed: scored.length,
    avgSentiment,
    topEmotions,
    emotionSpread,
    agreement: { ...tally, pct: judged ? (tally.agree / judged) * 100 : null },
    ratios: ratioStats(opLikes, replies),
    replies: replies
      .map((r) => ({
        handle: r.handle,
        text: r.text,
        likes: r.likes,
        url: r.url,
        analysis: r.analysis
      }))
      .sort((a, b) => b.likes - a.likes)
  };
}

// --- main ------------------------------------------------------------------

async function scrapePass(tabId, opts) {
  await ensureContentScript(tabId);
  const res = await chrome.tabs.sendMessage(tabId, { type: "scrape", opts });
  if (!res || !res.ok) throw new Error((res && res.error) || "The page didn't respond.");
  return res.data;
}

function mainPassOpts() {
  return {
    maxReplies: CONFIG.maxReplies,
    maxScrolls: CONFIG.maxScrolls,
    maxRunMinutes: CONFIG.maxRunMinutes,
    scrollDelayMs: CONFIG.scrollDelayMs,
    idleWaitCeilingMs: CONFIG.idleWaitCeilingMs,
    idleRounds: CONFIG.idleRounds,
    expandMoreReplies: CONFIG.expandMoreReplies,
    expandFlaggedReplies: CONFIG.expandFlaggedReplies,
    recoverFromErrors: CONFIG.recoverFromErrors,
    excludeOpSelfReplies: CONFIG.excludeOpSelfReplies
  };
}

// The likes pass only needs the head of the list. Collect a small multiple of
// topN so that filtering (self-replies, nested, media-only) can't leave the
// section short, then take the top N by likes from what came back.
function likesPassOpts() {
  return {
    maxReplies: Math.max(CONFIG.topN * 3, CONFIG.topN + 10),
    maxScrolls: 0,
    maxRunMinutes: 2,
    scrollDelayMs: CONFIG.scrollDelayMs,
    idleWaitCeilingMs: 3000,
    idleRounds: 4,
    expandMoreReplies: false,
    expandFlaggedReplies: false,
    recoverFromErrors: CONFIG.recoverFromErrors,
    excludeOpSelfReplies: CONFIG.excludeOpSelfReplies
  };
}

async function run(tabId) {
  if (!CONFIG.apiKey || CONFIG.apiKey.includes("PUT-YOUR-KEY")) {
    throw new Error("Add your xAI key to config.js, then reload the extension.");
  }

  const tab = await chrome.tabs.get(tabId);
  const base = new URL(tab.url);
  const host = base.hostname.replace(/^www\./, "");
  if (!/^(x|twitter)\.com$/.test(host) || !/\/status\/\d+/.test(base.pathname)) {
    throw new Error("Open a post on x.com first — a URL with /status/ in it.");
  }

  const originalUrl = tab.url;
  base.hash = "";

  const mainUrl = new URL(base);
  if (CONFIG.mainSort === "likes") mainUrl.searchParams.set("sort_replies", "likes");
  else mainUrl.searchParams.delete("sort_replies");

  const likesUrl = new URL(base);
  likesUrl.searchParams.set("sort_replies", "likes");

  // --- pass 1: the thread as X ranks it by default -------------------------
  await goTo(tabId, mainUrl.toString(), `Loading replies (${CONFIG.mainSort} sort)…`);
  progress("Reading replies…");
  const mainScrape = await scrapePass(tabId, mainPassOpts());
  if (!mainScrape.replies.length) throw new Error("No replies found on this post.");

  const op = mainScrape.op;
  const mainReplies = mainScrape.replies;

  // --- pass 2: the head of the likes-sorted list ---------------------------
  let topReplies = [];
  let topSource = null;
  let likesScrape = null;

  if (mainReplies.length > CONFIG.topN) {
    if (CONFIG.topFromLikesPass) {
      try {
        await goTo(tabId, likesUrl.toString(), "Re-loading, sorted by likes…");
        progress(`Reading the top ${CONFIG.topN} by likes…`);
        likesScrape = await scrapePass(tabId, likesPassOpts());
        topReplies = [...likesScrape.replies]
          .sort((a, b) => b.likes - a.likes)
          .slice(0, CONFIG.topN);
        topSource = "likes sort";
      } catch (err) {
        progress("Likes pass failed — falling back to the main read.");
        topReplies = [];
      }
    }
    if (!topReplies.length) {
      topReplies = [...mainReplies].sort((a, b) => b.likes - a.likes).slice(0, CONFIG.topN);
      topSource = "main read, re-sorted";
    }
  }

  // --- one analysis over the union of both passes --------------------------
  const union = [];
  const seen = new Set();
  for (const r of [...mainReplies, ...topReplies]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    union.push(r);
  }

  const { scored, usage, batches } = await analyse(op, union);
  const byId = new Map(scored.map((r) => [r.id, r]));
  const attach = (rows) => rows.map((r) => byId.get(r.id) || { ...r, analysis: null });

  const result = {
    op: { ...op, text: op.text.slice(0, 400) },
    model: CONFIG.model,
    scrapedAt: Date.now(),
    mainSort: CONFIG.mainSort,
    topSource,
    read: {
      ended: mainScrape.ended,
      capped: mainScrape.capped,
      timedOut: mainScrape.timedOut,
      aborted: mainScrape.aborted,
      stalled: mainScrape.stalled,
      complete: mainScrape.completeThread,
      maxReplies: CONFIG.maxReplies,
      mainCount: mainReplies.length,
      extraFromLikesPass: union.length - mainReplies.length,
      seconds: mainScrape.readSeconds + (likesScrape ? likesScrape.readSeconds : 0),
      scrollSteps: mainScrape.scrollSteps,
      recoveries: mainScrape.recoveries + (likesScrape ? likesScrape.recoveries : 0),
      selfRepliesSkipped: mainScrape.selfRepliesSkipped,
      analysed: union.length,
      batches,
      usage
    },
    all: aggregate(attach(mainReplies), op.likes),
    top: topReplies.length ? aggregate(attach(topReplies), op.likes) : null,
    topN: CONFIG.topN
  };

  if (CONFIG.restoreOriginalUrl) {
    const now = await chrome.tabs.get(tabId);
    if (!sameView(now.url, originalUrl)) chrome.tabs.update(tabId, { url: originalUrl });
  }

  await chrome.storage.session.set({ [`replyzr:${tabId}`]: { url: originalUrl, result } });
  return result;
}
