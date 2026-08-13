// ---------------------------------------------------------------------------
// Replyzr — configuration
// Edit this file, then hit "Reload" on the extension in chrome://extensions.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // --- xAI ---------------------------------------------------------------
  apiKey: "xai-YOUR-KEY-HERE",
  model: "grok-4.6",
  endpoint: "https://api.x.ai/v1/chat/completions",

  // Replies per API request. Lower it if you hit context or rate limits.
  batchSize: 40,
  // Batches in flight at once. 1 is safest; 3 is roughly 3x faster on a big
  // thread. Drop it back to 1 if xAI starts returning 429s.
  concurrency: 3,
  // Reply text is truncated to this many characters before being sent.
  maxTextChars: 400,
  // Retries on 429 / 5xx, with exponential backoff.
  maxRetries: 3,

  // --- Scraping ----------------------------------------------------------
  // SET ANY OF THESE THREE TO 0 FOR UNLIMITED.
  // With all three at 0 the read runs until X stops serving replies —
  // fine on a small thread, minutes and many API batches on a huge one.
  maxReplies: 150,    // hard cap on replies collected. 0 = unlimited.
  maxScrolls: 400,    // hard cap on scroll steps. 0 = unlimited.
                      // Well above what 150 replies needs; maxReplies should
                      // be what stops a normal read, not this.
  maxRunMinutes: 5,   // wall-clock safety valve. 0 = unlimited.

  // Pause after each scroll step so X can render the next chunk. This backs
  // off automatically (up to idleWaitCeilingMs) while waiting on the network.
  scrollDelayMs: 550,
  idleWaitCeilingMs: 6000,
  // Consecutive empty scroll steps at the bottom of the page before the read
  // is called done. Higher = more patient with slow reply pagination.
  idleRounds: 8,

  // Click "Show more replies" links as they appear. Needed for a full read.
  expandMoreReplies: true,
  // Also click "Show additional replies, including those that may contain
  // offensive content" and probable-spam sections. Off by default because it
  // changes what "the replies" means.
  expandFlaggedReplies: false,
  // Click X's "Retry" button when the timeline throws "Something went wrong"
  // (usually soft rate limiting from scrolling hard).
  recoverFromErrors: true,

  // --- Sorting -----------------------------------------------------------
  // The main section reads the thread in this sort. "relevant" is X's own
  // default (no URL param); "likes" appends ?sort_replies=likes.
  mainSort: "relevant",
  // The "top N by likes" section is read separately, from the likes sort, so
  // it reflects X's own ranking rather than a re-sort of the main pass.
  // Set false to just re-sort the main pass by likes instead (one page load
  // fewer, but only as good as how deep the main read got).
  topFromLikesPass: true,
  // Put the tab back on the URL you started from once the read finishes.
  restoreOriginalUrl: false,
  // Skip the author's own replies (self-threads) — they aren't the crowd.
  excludeOpSelfReplies: true,

  // --- Reporting ---------------------------------------------------------
  // Size of the "top N by likes" section, and the threshold above which a
  // thread gets that second section at all.
  topN: 10,
  // A reply that doesn't beat the OP is reported as "close" if it reaches
  // this fraction of the OP's likes.
  closeRatioThreshold: 0.5,

  // The label set Grok must choose from. Keep it short — a long list makes
  // "two most common" meaningless.
  emotions: [
    "amusement",
    "admiration",
    "joy",
    "gratitude",
    "hope",
    "relief",
    "sadness",
    "anger",
    "disgust",
    "contempt",
    "fear",
    "anxiety",
    "surprise",
    "confusion",
    "sarcasm",
    "neutral"
  ]
};
