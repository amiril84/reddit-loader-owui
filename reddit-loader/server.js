import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { Agent, fetch } from "undici";

const port = Number(process.env.PORT || 8080);
const apiKey = process.env.LOADER_API_KEY || "";
const browserDataDir = process.env.BROWSER_DATA_DIR || "/data/browser";
const navigationTimeout = Number(process.env.NAVIGATION_TIMEOUT_MS || 45000);
const requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const maxResponseBytes = Number(process.env.MAX_RESPONSE_BYTES || 10 * 1024 * 1024);
const browserHeadless = process.env.BROWSER_HEADLESS === "true";
const maxBatchSize = 20;

const proxyHost = process.env.PROXY_HOST || "";
const proxyPort = process.env.PROXY_PORT || "";
const proxyUser = process.env.PROXY_USER || "";
const proxyPass = process.env.PROXY_PASS || "";

let browserContext;
let browserStarting;
let activeProxyUsername;
let browserQueue = Promise.resolve();

const redditHosts = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
  "redd.it",
  "www.redd.it",
]);

const threadsHosts = new Set([
  "threads.com",
  "www.threads.com",
  "threads.net",
  "www.threads.net",
]);

function log(level, message, fields = {}) {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !/pass|secret|token|key|auth|proxy/i.test(key)),
  );
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...safeFields }));
}

function isRedditHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return redditHosts.has(host) || host.endsWith(".reddit.com");
}

function isThreadsHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return threadsHosts.has(host);
}

function isPublicAddress(address) {
  if (!net.isIP(address)) return false;

  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPublicAddress(normalized.slice(7));
  }
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  );
}

async function validateUrl(rawUrl, { redditOnly = false, threadsOnly = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("unsupported URL scheme");
  }
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }
  if (redditOnly && !isRedditHost(url.hostname)) {
    throw new Error("Reddit navigation left an allowed domain");
  }
  if (threadsOnly && !isThreadsHost(url.hostname)) {
    throw new Error("Threads navigation left an allowed domain");
  }

  if (!isRedditHost(url.hostname) && !isThreadsHost(url.hostname)) {
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error("target resolves to a non-public address");
    }
  }
  return url;
}

function queueBrowserTask(task) {
  const queued = browserQueue.then(task);
  browserQueue = queued.catch(() => {});
  return queued;
}

async function createSafeDispatcher(hostname) {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("target resolves to a non-public address");
  }

  let cursor = 0;
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options?.all) {
          callback(null, addresses);
          return;
        }
        const selected = addresses[cursor % addresses.length];
        cursor += 1;
        callback(null, selected.address, selected.family);
      },
    },
  });
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readBodyLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel();
      throw new Error("response exceeds size limit");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchWithSafeRedirects(initialUrl) {
  let current = await validateUrl(initialUrl);

  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const dispatcher = await createSafeDispatcher(current.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const response = await fetch(current, {
        dispatcher,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; OpenWebUIExternalLoader/1.0)",
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error(`redirect ${response.status} missing Location`);
        current = await validateUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
      const body = await readBodyLimited(response);
      return {
        body,
        finalUrl: current,
        contentType: response.headers.get("content-type") || "",
      };
    } finally {
      clearTimeout(timer);
      await dispatcher.close();
    }
  }

  throw new Error("too many redirects");
}

async function extractDirect(rawUrl) {
  const { body, finalUrl, contentType: responseContentType } =
    await fetchWithSafeRedirects(rawUrl);
  const contentType = responseContentType.toLowerCase();

  if (contentType.includes("json")) {
    const parsed = JSON.parse(body);
    return {
      page_content: normalizeWhitespace(JSON.stringify(parsed, null, 2)),
      metadata: { source: rawUrl, final_url: finalUrl.toString(), content_type: contentType },
    };
  }
  if (!contentType.includes("html") && !contentType.includes("xml")) {
    return {
      page_content: normalizeWhitespace(body),
      metadata: { source: rawUrl, final_url: finalUrl.toString(), content_type: contentType },
    };
  }

  const dom = new JSDOM(body, { url: finalUrl.toString() });
  const document = dom.window.document;
  const title = normalizeWhitespace(document.querySelector("title")?.textContent);
  const description =
    document.querySelector('meta[name="description"]')?.getAttribute("content") ||
    document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
    "";
  const reader = new Readability(document.cloneNode(true));
  const article = reader.parse();
  const text =
    normalizeWhitespace(article?.textContent) ||
    normalizeWhitespace(document.body?.textContent);

  return {
    page_content: [article?.title || title, description, text].filter(Boolean).join("\n\n"),
    metadata: {
      source: rawUrl,
      final_url: finalUrl.toString(),
      title: article?.title || title,
      description: normalizeWhitespace(description),
      content_type: contentType,
      loader: "direct",
    },
  };
}

async function getBrowserContext() {
  if (browserContext) return browserContext;
  if (browserStarting) return browserStarting;

  browserStarting = (async () => {
    if (!proxyHost || !proxyPort || !proxyUser || !proxyPass) {
      throw new Error("residential proxy configuration is incomplete");
    }

    if (!activeProxyUsername) {
      const sessionId = String(Math.floor(1000 + Math.random() * 9000));
      const parts = proxyUser.split("-");
      activeProxyUsername =
        parts.length >= 3
          ? [...parts.slice(0, -1), sessionId].join("-")
          : `${proxyUser}-${sessionId}`;
    }

    for (const lockName of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      await unlink(path.join(browserDataDir, lockName)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }

    const context = await chromium.launchPersistentContext(browserDataDir, {
      headless: browserHeadless,
      proxy: {
        server: `http://${proxyHost}:${proxyPort}`,
        username: activeProxyUsername,
        password: proxyPass,
      },
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "Asia/Jakarta",
      args: [
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    context.setDefaultNavigationTimeout(navigationTimeout);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    await context.route("**/*", async (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    context.on("close", () => {
      browserContext = undefined;
    });
    browserContext = context;
    log("info", "persistent Chromium context started");
    return context;
  })();

  try {
    return await browserStarting;
  } finally {
    browserStarting = undefined;
  }
}

async function rotateBrowserSession() {
  if (browserContext) {
    try {
      await browserContext.clearCookies();
      await browserContext.close();
    } catch (error) {
      log("warn", "failed to close browser context cleanly", { error: error.message });
    }
  }
  browserContext = undefined;
  browserStarting = undefined;
  activeProxyUsername = undefined;
  log("info", "rotating residential browser session");
}

function detectRedditFailure(title, text) {
  const haystack = `${title}\n${text}`.toLowerCase();
  if (haystack.includes("please wait for verification")) return "Reddit verification did not complete";
  if (haystack.includes("you've been blocked") || haystack.includes("network security")) {
    return "Reddit blocked the current session";
  }
  if (haystack.includes("captcha")) return "Reddit requested a CAPTCHA";
  if (haystack.includes("log in to continue") && text.length < 2000) {
    return "Reddit requires login for this page";
  }
  return "";
}

function detectThreadsFailure(title, text, usefulLength) {
  const haystack = `${title}\n${text}`.toLowerCase();
  if (haystack.includes("captcha") || haystack.includes("confirm you're not a robot")) {
    return "Threads requested a CAPTCHA or challenge";
  }
  if (haystack.includes("challenge") && usefulLength < 200) {
    return "Threads requested a challenge";
  }
  if (
    usefulLength < 120 &&
    (haystack.includes("this content isn't available") ||
      haystack.includes("this page isn't available") ||
      haystack.includes("post unavailable") ||
      haystack.includes("private"))
  ) {
    return "Threads post is private or unavailable";
  }
  if (
    usefulLength < 120 &&
    (haystack.includes("log in") || haystack.includes("sign up")) &&
    !haystack.includes("/post/")
  ) {
    return "Threads requires login for this page";
  }
  return "";
}

async function extractRedditUnlocked(rawUrl) {
  await validateUrl(rawUrl, { redditOnly: true });
  const context = await getBrowserContext();
  const page = await context.newPage();
  const startedAt = Date.now();

  try {
    const response = await page.goto(rawUrl, { waitUntil: "domcontentloaded" });
    let title = "";
    let bodyText = "";
    for (let waited = 0; waited <= 20000; waited += 2000) {
      if (waited) await page.waitForTimeout(2000);
      title = normalizeWhitespace(await page.title().catch(() => ""));
      bodyText = normalizeWhitespace(
        await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""),
      );
      const failure = detectRedditFailure(title, bodyText);
      if (failure) throw new Error(failure);
      const hasRedditContent = await page
        .locator("shreddit-post, [data-testid='post-container'], shreddit-comment")
        .count()
        .catch(() => 0);
      if (hasRedditContent || bodyText.length >= 500) break;
    }

    const finalUrl = page.url();
    await validateUrl(finalUrl, { redditOnly: true });

    const extracted = await page.evaluate(() => {
      const clean = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

      const postNodes = Array.from(
        document.querySelectorAll("shreddit-post, [data-testid='post-container']"),
      ).slice(0, 30);
      const posts = postNodes
        .map((node) => {
          const title =
            node.getAttribute("post-title") ||
            node.querySelector("h1, h2, h3, [slot='title']")?.textContent ||
            "";
          const author = node.getAttribute("author") || "";
          const subreddit = node.getAttribute("subreddit-prefixed-name") || "";
          const score = node.getAttribute("score") || "";
          const comments = node.getAttribute("comment-count") || "";
          const content =
            node.querySelector("[slot='text-body'], [data-post-click-location='text-body']")?.textContent ||
            "";
          const permalink = node.getAttribute("permalink") || "";
          return clean(
            [
              title,
              subreddit && `Subreddit: ${subreddit}`,
              author && `Author: u/${author}`,
              score && `Score: ${score}`,
              comments && `Comments: ${comments}`,
              content,
              permalink && `Permalink: https://www.reddit.com${permalink}`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        })
        .filter(Boolean);

      const commentNodes = Array.from(
        document.querySelectorAll("shreddit-comment, [data-testid='comment']"),
      ).slice(0, 100);
      const comments = commentNodes
        .map((node) => {
          const author = node.getAttribute("author") || "";
          const score = node.getAttribute("score") || "";
          const depth = node.getAttribute("depth") || "";
          const content =
            node.querySelector("[slot='comment'], [data-testid='comment'] p, .md")?.textContent ||
            node.textContent ||
            "";
          return clean(
            [
              `Comment${author ? ` by u/${author}` : ""}${score ? ` (${score} points)` : ""}`,
              depth && `Depth: ${depth}`,
              content,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        })
        .filter(Boolean);

      const mainText = clean(
        document.querySelector("main")?.innerText || document.body?.innerText || "",
      );
      return { posts, comments, mainText };
    });

    const sections = [];
    if (extracted.posts.length) sections.push(`POSTS\n\n${extracted.posts.join("\n\n---\n\n")}`);
    if (extracted.comments.length) {
      sections.push(`COMMENTS\n\n${extracted.comments.join("\n\n---\n\n")}`);
    }
    if (!sections.length) sections.push(extracted.mainText);
    const pageContent = normalizeWhitespace([title, ...sections].filter(Boolean).join("\n\n"));
    if (pageContent.length < 200) throw new Error("Reddit page contained too little readable content");

    return {
      page_content: pageContent,
      metadata: {
        source: rawUrl,
        final_url: finalUrl,
        title,
        http_status: response?.status() || null,
        post_count: extracted.posts.length,
        comment_count: extracted.comments.length,
        elapsed_ms: Date.now() - startedAt,
        loader: "reddit-playwright",
      },
    };
  } finally {
    await page.close();
  }
}

function extractReddit(rawUrl) {
  return queueBrowserTask(async () => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await extractRedditUnlocked(rawUrl);
      } catch (error) {
        lastError = error;
        const retryable =
          /blocked|verification|captcha|too little readable content/i.test(error.message);
        if (!retryable || attempt === 3) throw error;
        log("warn", "Reddit session rejected; rotating exit", { attempt, error: error.message });
        await rotateBrowserSession();
      }
    }
    throw lastError;
  });
}

async function extractThreadsUnlocked(rawUrl) {
  await validateUrl(rawUrl, { threadsOnly: true });
  const context = await getBrowserContext();
  const page = await context.newPage();
  const startedAt = Date.now();

  try {
    const response = await page.goto(rawUrl, { waitUntil: "domcontentloaded" });
    let title = "";
    let bodyText = "";
    for (let waited = 0; waited <= 20000; waited += 2000) {
      if (waited) await page.waitForTimeout(2000);
      title = normalizeWhitespace(await page.title().catch(() => ""));
      bodyText = normalizeWhitespace(
        await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""),
      );
      const contentSignals = await page
        .locator("main, article, [role='article'], a[href*='/post/']")
        .count()
        .catch(() => 0);
      if (contentSignals || bodyText.length >= 500 || detectThreadsFailure(title, bodyText, bodyText.length)) {
        break;
      }
    }

    await page.keyboard.press("Home").catch(() => {});
    await page.waitForTimeout(1000);
    let stableScrolls = 0;
    for (let scroll = 0; scroll < 12; scroll += 1) {
      const before = normalizeWhitespace(
        await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""),
      ).length;
      await page.mouse.wheel(0, 1200).catch(() => {});
      await page.waitForTimeout(1200);
      const after = normalizeWhitespace(
        await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""),
      ).length;
      stableScrolls = after - before < 100 ? stableScrolls + 1 : 0;
      if (stableScrolls >= 3) break;
    }

    const finalUrl = page.url();
    await validateUrl(finalUrl, { threadsOnly: true });

    const extracted = await page.evaluate(() => {
      const clean = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

      const cutNoise = (value) => {
        const markers = [
          "\nUtas terkait",
          "\nRelated threads",
          "\nLog in to see more replies",
          "\nLog in to see more",
          "\nLog in or sign up for Threads",
          "\nMasuk untuk melihat balasan lainnya",
          "\nMasuk untuk melihat lainnya",
        ];
        let text = clean(value);
        for (const marker of markers) {
          const index = text.toLowerCase().indexOf(marker.toLowerCase());
          if (index >= 0) text = text.slice(0, index);
        }
        return clean(text);
      };

      const isUsefulPostText = (value) => {
        const text = clean(value);
        const lower = text.toLowerCase();
        if (text.length < 20) return false;
        if (/^(home|search|create|activity|profile|threads|log in|sign up)$/i.test(text)) return false;
        if (lower.includes("\u00a9") && text.length < 80) return false;
        return true;
      };

      const bodyText = clean(document.body?.innerText || "");
      const mainText = cutNoise(document.querySelector("main")?.innerText || bodyText);
      const loginWall =
        /log in to see more replies|log in to see more|masuk untuk melihat balasan|masuk untuk melihat lainnya/i.test(
          bodyText,
        );

      const articleNodes = Array.from(
        document.querySelectorAll("article, [role='article']"),
      ).slice(0, 80);
      const seenPosts = new Set();
      const posts = articleNodes
        .map((node) => cutNoise(node.innerText || node.textContent || ""))
        .filter(isUsefulPostText)
        .filter((text) => {
          const key = text.replace(/\s+/g, " ").slice(0, 240);
          if (seenPosts.has(key)) return false;
          seenPosts.add(key);
          return true;
        });

      const postLinks = Array.from(document.querySelectorAll("a[href*='/post/']"))
        .map((anchor) => {
          try {
            return new URL(anchor.getAttribute("href"), location.href).toString();
          } catch {
            return "";
          }
        })
        .filter((href) => /^https:\/\/(www\.)?threads\.(com|net)\//i.test(href));
      const uniquePostLinks = Array.from(new Set(postLinks)).slice(0, 100);

      const counts = {};
      const countMatches = bodyText.match(/\b[\d,.KMkm]+\s+(likes?|replies|reply|reposts?|quotes?|suka|balasan|posting ulang|kutipan)\b/g);
      if (countMatches) {
        counts.visible = Array.from(new Set(countMatches)).slice(0, 20);
      }

      return {
        bodyText,
        mainText,
        posts,
        postLinks: uniquePostLinks,
        postLinkCount: uniquePostLinks.length,
        loginWall,
        counts,
      };
    });

    const sections = [];
    if (extracted.posts.length) {
      sections.push(`THREAD POSTS\n\n${extracted.posts.join("\n\n---\n\n")}`);
    } else if (extracted.mainText) {
      sections.push(extracted.mainText);
    }

    if (extracted.postLinks.length) {
      sections.push(`VISIBLE POST LINKS\n\n${extracted.postLinks.join("\n")}`);
    }

    const pageContent = normalizeWhitespace([title, ...sections].filter(Boolean).join("\n\n"));
    const usefulText = normalizeWhitespace(sections.join("\n\n"));
    const failure = detectThreadsFailure(title, extracted.bodyText, usefulText.length);
    if (failure) throw new Error(failure);
    if (
      !extracted.posts.length &&
      !extracted.postLinks.length &&
      /\b(log in|sign up)\b|masuk|daftar/i.test(extracted.bodyText)
    ) {
      throw new Error("Threads requires login for this page");
    }
    if (usefulText.length < 80) {
      throw new Error("Threads page contained too little readable content");
    }

    return {
      page_content: pageContent,
      metadata: {
        source: rawUrl,
        final_url: finalUrl,
        title,
        http_status: response?.status() || null,
        post_count: extracted.posts.length,
        post_link_count: extracted.postLinkCount,
        visible_counts: extracted.counts.visible || [],
        login_wall: extracted.loginWall,
        elapsed_ms: Date.now() - startedAt,
        loader: "threads-playwright",
      },
    };
  } finally {
    await page.close();
  }
}

function extractThreads(rawUrl) {
  return queueBrowserTask(() => extractThreadsUnlocked(rawUrl));
}

async function extractUrl(rawUrl) {
  const parsed = await validateUrl(rawUrl);
  if (isRedditHost(parsed.hostname)) return extractReddit(rawUrl);
  if (isThreadsHost(parsed.hostname)) return extractThreads(rawUrl);
  return extractDirect(rawUrl);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return sendJson(response, 200, { status: "ok" });
  }

  if (request.method !== "POST" || request.url !== "/load") {
    return sendJson(response, 404, { error: "not found" });
  }

  if (!apiKey || request.headers.authorization !== `Bearer ${apiKey}`) {
    return sendJson(response, 401, { error: "unauthorized" });
  }

  try {
    const payload = await readJson(request);
    if (!Array.isArray(payload.urls) || payload.urls.length < 1 || payload.urls.length > maxBatchSize) {
      return sendJson(response, 400, { error: "urls must be a non-empty array of at most 20 items" });
    }
    if (payload.urls.some((url) => typeof url !== "string" || url.length > 4096)) {
      return sendJson(response, 400, { error: "each URL must be a string no longer than 4096 characters" });
    }

    const results = [];
    for (const url of payload.urls) {
      try {
        const result = await extractUrl(url);
        results.push(result);
        log("info", "URL extracted", {
          host: new URL(url).hostname,
          loader: result.metadata.loader,
          chars: result.page_content.length,
          elapsed_ms: result.metadata.elapsed_ms,
        });
      } catch (error) {
        log("warn", "URL extraction failed", {
          host: (() => {
            try {
              return new URL(url).hostname;
            } catch {
              return "invalid";
            }
          })(),
          error: error.message,
        });
        results.push({
          page_content: "",
          metadata: { source: url, error: error.message },
        });
      }
    }
    return sendJson(response, 200, results);
  } catch (error) {
    log("warn", "request rejected", { error: error.message });
    return sendJson(response, 400, { error: error.message });
  }
});

async function shutdown(signal) {
  log("info", "shutting down", { signal });
  server.close();
  if (browserContext) await browserContext.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(port, "0.0.0.0", () => {
  log("info", "Reddit loader listening", { port });
});
