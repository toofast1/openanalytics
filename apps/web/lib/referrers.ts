/**
 * Referrer domain → presentable source. Pure display-layer normalization
 * (Plausible-style): the wire keeps raw domains, this maps the known ones to
 * their household names and folds host variants (`www.`, `m.`, country TLDs,
 * link shorteners like `t.co`) onto one canonical identity. Unknown domains
 * pass through untouched, so nothing here ever hides data — and when ingest
 * later normalizes at the source, this keeps working with no change.
 */

export type ReferrerInfo = {
  /** Display name — "Google", or the bare host when unrecognized. */
  name: string;
  /** Canonical domain to fetch a favicon for. */
  domain: string;
  /**
   * `ai` marks an assistant: a chat or answer product whose links out are
   * clicks on an answer rather than on a search result or a post. The AI
   * referrals card is the set of rows wearing this; everything else about
   * the row is the same. Display-layer classification, like the names: the
   * wire still carries the raw domain.
   */
  kind?: "ai";
};

const AI = "ai" as const;

/** Full-host matches, after `www.` stripping — checked before suffixes so
 *  `mail.google.com` can be Gmail while `google.com` stays Google. */
const EXACT: Record<string, ReferrerInfo> = {
  "t.co": { name: "X", domain: "x.com" },
  "x.com": { name: "X", domain: "x.com" },
  "twitter.com": { name: "X", domain: "x.com" },
  "youtu.be": { name: "YouTube", domain: "youtube.com" },
  "news.ycombinator.com": {
    name: "Hacker News",
    domain: "news.ycombinator.com",
  },
  "hn.algolia.com": { name: "Hacker News", domain: "news.ycombinator.com" },
  "mail.google.com": { name: "Gmail", domain: "mail.google.com" },
  "news.google.com": { name: "Google News", domain: "news.google.com" },
  "accounts.google.com": {
    name: "Google Accounts",
    domain: "google.com",
  },
  "gemini.google.com": { name: "Gemini", domain: "gemini.google.com", kind: AI },
  "notebooklm.google.com": {
    name: "NotebookLM",
    domain: "notebooklm.google.com",
    kind: AI,
  },
  "copilot.microsoft.com": {
    name: "Copilot",
    domain: "copilot.microsoft.com",
    kind: AI,
  },
  "t.me": { name: "Telegram", domain: "telegram.org" },
  "telegram.me": { name: "Telegram", domain: "telegram.org" },
  "lnkd.in": { name: "LinkedIn", domain: "linkedin.com" },
  "fb.com": { name: "Facebook", domain: "facebook.com" },
  "bsky.app": { name: "Bluesky", domain: "bsky.app" },
  "dev.to": { name: "DEV", domain: "dev.to" },
  "search.brave.com": { name: "Brave Search", domain: "search.brave.com" },
  "chat.openai.com": { name: "ChatGPT", domain: "chatgpt.com", kind: AI },
  "chatgpt.com": { name: "ChatGPT", domain: "chatgpt.com", kind: AI },
  "openai.com": { name: "ChatGPT", domain: "chatgpt.com", kind: AI },
  "claude.ai": { name: "Claude", domain: "claude.ai", kind: AI },
  "anthropic.com": { name: "Claude", domain: "claude.ai", kind: AI },
  "perplexity.ai": { name: "Perplexity", domain: "perplexity.ai", kind: AI },
  "grok.com": { name: "Grok", domain: "grok.com", kind: AI },
  "x.ai": { name: "Grok", domain: "grok.com", kind: AI },
  "grok.x.ai": { name: "Grok", domain: "grok.com", kind: AI },
  "deepseek.com": { name: "DeepSeek", domain: "deepseek.com", kind: AI },
  "chat.deepseek.com": { name: "DeepSeek", domain: "deepseek.com", kind: AI },
  "mistral.ai": { name: "Le Chat", domain: "mistral.ai", kind: AI },
  "chat.mistral.ai": { name: "Le Chat", domain: "mistral.ai", kind: AI },
  "qwen.ai": { name: "Qwen", domain: "qwen.ai", kind: AI },
  "chat.qwen.ai": { name: "Qwen", domain: "qwen.ai", kind: AI },
  "meta.ai": { name: "Meta AI", domain: "meta.ai", kind: AI },
  "you.com": { name: "You.com", domain: "you.com", kind: AI },
  "poe.com": { name: "Poe", domain: "poe.com", kind: AI },
  "phind.com": { name: "Phind", domain: "phind.com", kind: AI },
  "kimi.com": { name: "Kimi", domain: "kimi.com", kind: AI },
  "duck.ai": { name: "Duck.ai", domain: "duck.ai", kind: AI },
  "discord.gg": { name: "Discord", domain: "discord.com" },
};

/**
 * The utm values an assistant writes onto the links it hands out. ChatGPT
 * tags every link `utm_source=chatgpt.com`; Claude's tag arrives as
 * `utm_source=Claude AI` with `utm_medium=claude.ai` (seen on our own site,
 * 2026-09-10). A click from an assistant's apps carries the tag and no
 * referrer at all, which is the one case where the tag is the only trace of
 * the assistant. Keyed by the value with everything but letters and digits
 * removed, so "Claude AI", "claude_ai" and "ClaudeAI" are one key; a
 * host-shaped value goes through `resolveReferrer` instead, so this list
 * only needs the bare spellings.
 */
const AI_UTM_NAMES: Record<string, ReferrerInfo> = {
  chatgpt: { name: "ChatGPT", domain: "chatgpt.com", kind: AI },
  openai: { name: "ChatGPT", domain: "chatgpt.com", kind: AI },
  claude: { name: "Claude", domain: "claude.ai", kind: AI },
  claudeai: { name: "Claude", domain: "claude.ai", kind: AI },
  anthropic: { name: "Claude", domain: "claude.ai", kind: AI },
  perplexity: { name: "Perplexity", domain: "perplexity.ai", kind: AI },
  perplexityai: { name: "Perplexity", domain: "perplexity.ai", kind: AI },
  gemini: { name: "Gemini", domain: "gemini.google.com", kind: AI },
  googlegemini: { name: "Gemini", domain: "gemini.google.com", kind: AI },
  copilot: { name: "Copilot", domain: "copilot.microsoft.com", kind: AI },
  microsoftcopilot: {
    name: "Copilot",
    domain: "copilot.microsoft.com",
    kind: AI,
  },
  grok: { name: "Grok", domain: "grok.com", kind: AI },
  deepseek: { name: "DeepSeek", domain: "deepseek.com", kind: AI },
  mistral: { name: "Le Chat", domain: "mistral.ai", kind: AI },
  lechat: { name: "Le Chat", domain: "mistral.ai", kind: AI },
  metaai: { name: "Meta AI", domain: "meta.ai", kind: AI },
};

function aiUtmValue(value: string): ReferrerInfo | null {
  const raw = value.trim().toLowerCase();
  if (raw === "") return null;
  if (raw.includes(".")) {
    const info = resolveReferrer(raw);
    return info.kind === "ai" ? info : null;
  }
  return AI_UTM_NAMES[raw.replace(/[^a-z0-9]/g, "")] ?? null;
}

/**
 * The assistant a link's utm tag names, or null for every other tag.
 * `utm_source` is the tag's home and is read first; `utm_medium` is read
 * only when the source names nothing, because Claude's medium carries the
 * host while its source carries the display name, and a fork of either
 * convention should still resolve.
 */
export function resolveAiUtm(
  source: string,
  medium: string
): ReferrerInfo | null {
  return aiUtmValue(source) ?? aiUtmValue(medium);
}

/** Registrable-domain matches: the host itself or any subdomain of it
 *  (`l.facebook.com`, `old.reddit.com`). */
const SUFFIX: Array<[string, ReferrerInfo]> = [
  ["google.com", { name: "Google", domain: "google.com" }],
  ["bing.com", { name: "Bing", domain: "bing.com" }],
  ["duckduckgo.com", { name: "DuckDuckGo", domain: "duckduckgo.com" }],
  ["yahoo.com", { name: "Yahoo", domain: "yahoo.com" }],
  ["yandex.ru", { name: "Yandex", domain: "yandex.com" }],
  ["yandex.com", { name: "Yandex", domain: "yandex.com" }],
  ["baidu.com", { name: "Baidu", domain: "baidu.com" }],
  ["ecosia.org", { name: "Ecosia", domain: "ecosia.org" }],
  ["facebook.com", { name: "Facebook", domain: "facebook.com" }],
  ["instagram.com", { name: "Instagram", domain: "instagram.com" }],
  ["linkedin.com", { name: "LinkedIn", domain: "linkedin.com" }],
  ["reddit.com", { name: "Reddit", domain: "reddit.com" }],
  ["youtube.com", { name: "YouTube", domain: "youtube.com" }],
  ["tiktok.com", { name: "TikTok", domain: "tiktok.com" }],
  ["pinterest.com", { name: "Pinterest", domain: "pinterest.com" }],
  ["whatsapp.com", { name: "WhatsApp", domain: "whatsapp.com" }],
  ["threads.net", { name: "Threads", domain: "threads.net" }],
  ["twitch.tv", { name: "Twitch", domain: "twitch.tv" }],
  ["github.com", { name: "GitHub", domain: "github.com" }],
  ["gitlab.com", { name: "GitLab", domain: "gitlab.com" }],
  ["stackoverflow.com", { name: "Stack Overflow", domain: "stackoverflow.com" }],
  ["producthunt.com", { name: "Product Hunt", domain: "producthunt.com" }],
  ["medium.com", { name: "Medium", domain: "medium.com" }],
  ["substack.com", { name: "Substack", domain: "substack.com" }],
  ["discord.com", { name: "Discord", domain: "discord.com" }],
  ["slack.com", { name: "Slack", domain: "slack.com" }],
  ["notion.so", { name: "Notion", domain: "notion.so" }],
  ["figma.com", { name: "Figma", domain: "figma.com" }],
  ["dribbble.com", { name: "Dribbble", domain: "dribbble.com" }],
  ["behance.net", { name: "Behance", domain: "behance.net" }],
  ["wikipedia.org", { name: "Wikipedia", domain: "wikipedia.org" }],
  ["npmjs.com", { name: "npm", domain: "npmjs.com" }],
];

/** All Google country properties (`google.de`, `google.com.tr`, …). */
const GOOGLE_TLD = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/;

export function resolveReferrer(raw: string): ReferrerInfo {
  // The wire carries bare domains, but be lenient about a stray URL.
  let host = raw.trim().toLowerCase();
  host = host.replace(/^[a-z+]+:\/\//, "").replace(/[/:?#].*$/, "");
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (host === "") return { name: raw, domain: raw };

  const exact = EXACT[host];
  if (exact !== undefined) return exact;
  for (const [base, info] of SUFFIX) {
    if (host === base || host.endsWith(`.${base}`)) return info;
  }
  if (GOOGLE_TLD.test(host)) return { name: "Google", domain: "google.com" };
  return { name: host, domain: host };
}
