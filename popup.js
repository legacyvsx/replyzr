// popup.js — thin client. All work happens in the service worker.

const els = {
  run: document.getElementById("run"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
  notice: document.getElementById("notice"),
  report: document.getElementById("report"),
  subject: document.getElementById("subject"),
  model: document.getElementById("model"),
  foot: document.getElementById("foot")
};

let tabId = null;
const port = chrome.runtime.connect({ name: "replyzr" });

port.onMessage.addListener((msg) => {
  if (msg.type === "heartbeat") {
    return; // keeps the service worker awake; nothing to draw
  } else if (msg.type === "progress") {
    els.status.textContent = msg.text;
  } else if (msg.type === "result") {
    busy(false);
    els.status.textContent = "";
    render(msg.result);
  } else if (msg.type === "error") {
    busy(false);
    els.status.textContent = "";
    fail(msg.error);
  }
});

function busy(on) {
  els.run.disabled = on;
  els.run.textContent = on ? "Reading…" : "Read again";
  els.stop.hidden = !on;
  els.stop.disabled = false;
  els.stop.textContent = "Stop";
}

function fail(text) {
  els.notice.hidden = false;
  els.notice.textContent = text;
}

els.stop.addEventListener("click", () => {
  els.stop.disabled = true;
  els.stop.textContent = "Stopping…";
  port.postMessage({ type: "stop", tabId });
});

els.run.addEventListener("click", () => {
  els.notice.hidden = true;
  els.report.innerHTML = "";
  els.foot.hidden = true;
  busy(true);
  els.status.textContent = "Starting…";
  port.postMessage({ type: "run", tabId });
});

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;

  const onPost = /^(https:\/\/)(www\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/.test(tab.url || "");
  if (!onPost) {
    els.run.disabled = true;
    els.report.innerHTML = `<p class="empty">Open a post on x.com to read its replies.</p>`;
    return;
  }

  // Show the last read for this tab immediately, if there is one.
  const key = `replyzr:${tabId}`;
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached && sameThread(cached.url, tab.url)) {
    render(cached.result);
    els.run.textContent = "Read again";
  } else {
    els.report.innerHTML = `<p class="empty">Nothing read yet.</p>`;
  }
  els.stop.hidden = true;
})();

function sameThread(a, b) {
  try {
    const ia = new URL(a).pathname.match(/\/status\/(\d+)/);
    const ib = new URL(b).pathname.match(/\/status\/(\d+)/);
    return ia && ib && ia[1] === ib[1];
  } catch (_) {
    return false;
  }
}

// --- formatting ------------------------------------------------------------

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

const num = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "K" : String(n));
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2);
const times = (r) => `${r.toFixed(r >= 10 ? 0 : 2).replace(/\.?0+$/, "")}×`;

function sentimentWord(v) {
  if (v == null) return "no reading";
  if (v <= -0.6) return "hostile";
  if (v <= -0.2) return "negative";
  if (v < 0.2) return "mixed";
  if (v < 0.6) return "positive";
  return "warm";
}

function dotColour(a) {
  if (!a || typeof a.sentiment !== "number") return "#4a5468";
  if (a.sentiment > 0.15) return "var(--pos)";
  if (a.sentiment < -0.15) return "var(--neg)";
  return "#4a5468";
}

// --- rendering -------------------------------------------------------------

function render(result) {
  els.model.textContent = result.model;
  els.notice.hidden = true;

  els.subject.hidden = false;
  els.subject.innerHTML =
    `<b>@${esc(result.op.handle)}</b> · ${num(result.op.likes)} likes on the post` +
    (result.op.text ? `<span class="snippet">${esc(result.op.text)}</span>` : "");

  const many = !!result.top;
  const mainSort = result.mainSort === "likes" ? "likes sort" : "relevant sort";
  let html = section(
    many ? `${result.all.n} replies` : "Replies",
    mainSort,
    result.all
  );
  if (many) {
    html += section(
      `Top ${result.topN} replies by likes`,
      result.topSource || "likes sort",
      result.top,
      true
    );
  }
  els.report.innerHTML = html;

  const r = result.read || {};
  const bits = [];
  bits.push(endedLabel(r));
  if (r.seconds) bits.push(`${r.seconds}s read`);
  if (r.analysed) {
    const extra = r.extraFromLikesPass ? ` (${r.mainCount} + ${r.extraFromLikesPass} from likes pass)` : "";
    bits.push(`${r.analysed} scored${extra} · ${r.batches} ${r.batches === 1 ? "batch" : "batches"}`);
  }
  if (r.recoveries) bits.push(`${r.recoveries} timeline ${r.recoveries === 1 ? "retry" : "retries"}`);
  if (r.selfRepliesSkipped) bits.push(`${r.selfRepliesSkipped} self-replies skipped`);
  els.foot.hidden = false;
  els.foot.innerHTML =
    `<span>${esc(bits.join(" · ") || "read complete")}</span>` +
    `<span>${new Date(result.scrapedAt).toLocaleTimeString()}</span>`;
}

function endedLabel(r) {
  switch (r.ended) {
    case "end-of-thread":
      return "whole thread read";
    case "exhausted":
      return "X stopped serving replies";
    case "cap":
      return `stopped at maxReplies (${r.maxReplies})`;
    case "timeout":
      return "stopped at maxRunMinutes";
    case "scrolls":
      return "stopped at maxScrolls";
    case "stopped":
      return "stopped early — partial thread";
    case "stalled":
      return "timeline stalled — partial thread";
    default:
      return r.complete ? "read complete" : "partial read";
  }
}

function section(title, subtitle, agg, withList) {
  const s = agg.avgSentiment;
  const pos = s == null ? 50 : ((s + 1) / 2) * 100;

  const ticks = [0, 25, 50, 75, 100]
    .map((p) => `<i class="tick${p === 50 ? " zero" : ""}" style="left:${p}%"></i>`)
    .join("");

  const spread = agg.emotionSpread || { labelled: 0, unlabelled: 0, distinct: 0, rest: [] };
  const emotions = agg.topEmotions.length
    ? `<div class="emotions">${agg.topEmotions
        .map(
          (e) =>
            `<div class="emotion"><div class="name">${esc(e.label)}</div>` +
            `<div class="share">${e.n} of ${spread.labelled} · ${Math.round(e.pct)}%</div></div>`
        )
        .join("")}</div>${emotionTail(spread)}`
    : `<div class="row-note">No emotion labels came back.</div>`;

  const ag = agg.agreement;
  const judged = ag.agree + ag.neutral + ag.disagree || 1;
  const w = (n) => (n / judged) * 100;

  return `
  <section class="section">
    <div class="section-head">
      <span class="section-title">${esc(title)}<em class="section-sub">${esc(subtitle)}</em></span>
      <span class="section-count">${agg.n}</span>
    </div>

    <div class="section-body">
      <div class="row wide">
        <div class="row-label"><span>Average sentiment</span><span>${esc(sentimentWord(s))}</span></div>
        <div class="row-value">${s == null ? "—" : signed(s)}</div>
        <div class="track">${ticks}<i class="needle" style="left:${pos}%"></i></div>
        <div class="scale"><span>−1.00</span><span>0</span><span>+1.00</span></div>
      </div>

      <div class="row">
        <div class="row-label"><span>Dominant emotions</span></div>
        ${emotions}
      </div>

      <div class="row second">
        <div class="row-label"><span>Agrees with the post</span></div>
        <div class="row-value">${ag.pct == null ? "—" : Math.round(ag.pct) + "%"}</div>
        <div class="stack">
          <i class="agree" style="width:${w(ag.agree)}%"></i>
          <i class="neutral" style="width:${w(ag.neutral)}%"></i>
          <i class="disagree" style="width:${w(ag.disagree)}%"></i>
        </div>
        <div class="legend">
          <span><b>${ag.agree}</b> agree</span>
          <span><b>${ag.neutral}</b> neutral</span>
          <span><b>${ag.disagree}</b> disagree</span>
        </div>
      </div>

      ${ratioRow(agg.ratios)}
    </div>
    ${withList || agg.n <= 10 ? replyList(agg.replies) : ""}
  </section>`;
}

// The two cards above are the top 2 of however many labels came back. Spell
// out what they don't cover, so 40% + 20% doesn't read as a missing 40%.
function emotionTail(spread) {
  const parts = [];
  if (spread.rest && spread.rest.length) {
    const shown = spread.rest
      .slice(0, 4)
      .map((e) => `${esc(e.label)} ${e.n}`)
      .join(", ");
    const more = spread.rest.length > 4 ? `, +${spread.rest.length - 4} more` : "";
    const covered = spread.rest.reduce((n, e) => n + e.n, 0);
    parts.push(
      `Remaining ${covered} across ${spread.rest.length} ` +
        `${spread.rest.length === 1 ? "label" : "labels"}: ${shown}${more}.`
    );
  }
  if (spread.unlabelled > 0) {
    parts.push(`${spread.unlabelled} unlabelled.`);
  }
  return parts.length ? `<div class="row-note">${parts.join(" ")}</div>` : "";
}

function ratioRow(r) {
  let value;
  let note = "";

  if (r.count > 0 && r.max != null) {
    value = `<span class="ratio-value">${r.count}</span>`;
    const range = r.min === r.max ? times(r.max) : `${times(r.min)} – ${times(r.max)}`;
    note = `Ratio range ${range} — top reply @${esc(r.best.handle)} at ${num(r.best.likes)} likes vs ${num(r.opLikes)}.`;
  } else if (r.count > 0) {
    value = `<span class="ratio-value">${r.count}</span>`;
    note = esc(r.note || "");
  } else if (r.closest) {
    const short = Math.round((1 - r.closest.ratio) * 100);
    value = `<span class="ratio-none">0</span>`;
    note = `Closest is @${esc(r.closest.handle)} at ${times(r.closest.ratio)} — ${short}% short of the post (${num(r.closest.likes)} vs ${num(r.opLikes)} likes).`;
  } else {
    value = `<span class="ratio-none">0</span>`;
    const best = r.best && r.best.ratio != null ? ` Best reply reached ${times(r.best.ratio)}.` : "";
    note = `${esc(r.note || "Nothing came close.")}${best}`;
  }

  return `
    <div class="row wide">
      <div class="row-label"><span>Ratios</span><span>replies beating the post</span></div>
      <div class="row-value">${value}</div>
      <div class="row-note">${note}</div>
    </div>`;
}

function replyList(replies) {
  if (!replies.length) return "";
  const items = replies
    .map(
      (r) => `
      <div class="item">
        <div class="likes">${num(r.likes)}</div>
        <div>
          <div class="who">
            <span class="dot" style="background:${dotColour(r.analysis)}"></span>
            <a href="${esc(r.url)}" target="_blank" rel="noreferrer">@${esc(r.handle)}</a>
            ${r.analysis && r.analysis.emotion ? " · " + esc(r.analysis.emotion) : ""}
            ${r.analysis && r.analysis.agreement ? " · " + esc(r.analysis.agreement) : ""}
          </div>
          <div class="body">${esc((r.text || "(no text)").slice(0, 180))}</div>
        </div>
      </div>`
    )
    .join("");
  return `<div class="list"><details><summary>Show the replies</summary>${items}</details></div>`;
}
