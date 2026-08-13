# Replyzr

A Chrome/Brave extension that reads the first-level replies on any X post and reports:

- **Average sentiment** across the replies, on a −1 to +1 track
- **The two most common emotions**, with counts and share
- **Agreement with the post**, as a percentage plus the agree/neutral/disagree split
- **Ratios** — replies with more likes than the post, how many and the range (e.g. `1.1× – 2.4×`). If nothing beat the post, it reports the closest reply and how far short it fell.

Threads with more than 10 replies get a second section, **Top 10 replies by likes**, with the same four readings computed over just that subset.

## Install

1. Put your xAI key in `config.js`:
   ```js
   apiKey: "xai-…",
   model: "grok-4.6",
   ```
2. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder.
3. Open any `x.com/<user>/status/<id>` page and click the toolbar icon → **Read the replies**.

After editing `config.js`, hit **Reload** on the extension card.

## How it works

`popup.js` is a thin client. `background.js` (the service worker) does everything, in two passes:

1. **Main pass — relevant sort.** The tab is put on the bare post URL (no `sort_replies` param, which is X's own default ranking) and `content.js` scrolls the thread, harvesting replies until X stops serving them. This pass is the `n replies` section.
2. **Likes pass — `?sort_replies=likes`.** Only if the main pass found more than `topN` replies. The tab reloads sorted by likes and reads just the head of the list, which *is* the top 10. This pass is the `Top 10 replies by likes` section.
3. **One analysis over the union.** The two passes overlap heavily, so replies are deduplicated by status id and each one is sent to `api.x.ai/v1/chat/completions` exactly once — batched, `concurrency` batches at a time, `response_format: json_object`. The annotations are then aggregated separately per section. Two reads, one bill.
4. Ratios are computed locally from like counts; the model never sees them.

Each section header says which sort it came from, so the two are never confused. If the likes pass fails for any reason, that section falls back to re-sorting the main read and labels itself `main read, re-sorted`.

Results are cached in `chrome.storage.session` per tab, so reopening the popup shows the last read instantly.

### Why two passes

Re-sorting the main pass by likes is *not* the same thing. Relevance ranking isn't a shuffled version of likes ranking — X's relevance model weighs your network, verification, recency and reply quality, and on a large thread a high-liked reply can sit well below wherever the main read stopped. The likes pass asks X directly, so the top 10 is X's answer, not an inference from a sample.

It also means the two sections are honestly different measurements: the main section is *the conversation as a reader encounters it*, the top-10 section is *the conversation as engagement ranks it*. Comparing their sentiment and agreement numbers is the interesting part.

## Reading a whole thread

`maxReplies`, `maxScrolls` and `maxRunMinutes` all accept **0, meaning no limit**. They ship at `150` / `400` / `5` — a bounded read that finishes in about a minute on most threads. Set `maxReplies: 0` (and raise or zero the other two) and the read instead ends when X stops producing replies. Three things make an unbounded read safe to run:

- **A MutationObserver harvests rows the moment they mount.** X virtualises the timeline, so a row can appear and be unmounted again between two scroll steps. The observer catches those; the scroll loop is only a backstop and a terminator. Without it, scrolling fast on a long thread quietly drops replies.
- **The service worker is kept awake.** MV3 workers idle out in 30 seconds. Progress messages from the content script plus a 20-second keepalive ticker reset that timer for the length of the run. *Leave the popup open* — closing it drops the port and can take the read with it.
- **The scroll loop backs off instead of giving up.** An empty step doesn't immediately count as "thread over": it first clicks any "Show more replies" button, and clicks X's **Retry** when the timeline throws "Something went wrong" (soft rate limiting from scrolling hard). Only after `idleRounds` genuinely empty steps *at the bottom of the page* does it stop.

**Stop** applies to the main pass and appears while a read is running. It ends the scroll immediately and analyses whatever has been collected — useful when you can see the thread is bigger than you want to pay for. The footer always says how the read ended: `whole thread read`, `stopped early — partial thread`, `stopped at maxReplies`, or `stopped at maxRunMinutes`.

Two honest limits on "the entire thread":

- X itself stops paginating replies at some depth on very large threads. Nothing client-side gets past that — when the footer says the whole thread was read, it means X stopped offering more, which isn't always the same as there being no more.
- Cost and time scale linearly. 4,000 replies is 100 API batches. At `concurrency: 3` that's minutes, not seconds, and the scroll alone will take a while. `maxRunMinutes` exists as a safety valve if you'd rather bound it.

## Config

| Key | Default | Notes |
| --- | --- | --- |
| `apiKey` | — | xAI key. Required. |
| `model` | `grok-4.6` | Any xAI chat model. |
| `batchSize` | `40` | Replies per API request. |
| `concurrency` | `3` | Batches in flight. Drop to 1 if xAI returns 429s. |
| `maxReplies` | `150` | Replies collected in the main pass. **0 = unlimited.** |
| `maxScrolls` | `400` | Scroll steps. **0 = unlimited.** Headroom — `maxReplies` should be what stops a normal read. |
| `maxRunMinutes` | `5` | Wall-clock safety valve. **0 = unlimited.** |
| `scrollDelayMs` | `550` | Base pause per scroll step; backs off automatically when idle. |
| `idleWaitCeilingMs` | `6000` | Longest the backoff will wait for more replies. |
| `idleRounds` | `8` | Empty steps at the page bottom before the read is called done. |
| `expandMoreReplies` | `true` | Clicks "Show more replies". Needed for a full read. |
| `expandFlaggedReplies` | `false` | Also expands offensive/spam-flagged replies. |
| `recoverFromErrors` | `true` | Clicks Retry when the timeline errors out. |
| `mainSort` | `"relevant"` | Sort for the main section. `"relevant"` is X's default; `"likes"` also available. |
| `topFromLikesPass` | `true` | Read the top N in a separate likes-sorted pass. False = re-sort the main pass instead. |
| `restoreOriginalUrl` | `false` | Send the tab back to where it started afterwards. |
| `closeRatioThreshold` | `0.5` | A non-ratio is reported as "close" above this share of the OP's likes. |
| `topN` | `10` | Size of the second section and the threshold for showing it. |
| `emotions` | 16 labels | Keep the list short or "two most common" stops meaning anything. |

## Known limits

- **The key sits in the extension bundle.** Anyone with the folder has it. Fine for personal use; for anything shared, proxy through a backend and put the key there.
- **Like counts are read from the rendered DOM.** Exact counts come from the like button's `aria-label`; if X changes that markup the parser needs updating. Same for the `data-testid` selectors — that's the fragile part of any X scraper.
- **A partial read is a sample, not a census.** At the default `maxReplies: 150` most large threads *will* be partial reads — the footer says how the read ended. Sentiment over the first 150 of a 4,000-reply thread is a real number about a biased subset — biased by whatever X's relevance model favours, which includes your own network.
- **The tab moves.** A full run reloads the page once or twice. `restoreOriginalUrl: true` sends it back afterwards.
- **Reply-level detection is heuristic**, based on the presence and content of the "Replying to" line.
- **Non-English UI**: the aria-label and section-header matching assumes X is set to English.

<a href="https://x.com/h45hb4ng">@h45hb4ng</a> | <a href="https://morallyrelative.com">morallyrelative.com</a> 
