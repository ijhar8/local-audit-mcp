#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const UA = "LocalAuditMCP/1.0 (agent tool; public pages only)";
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_CHARS = 1_500_000;

const BOOKING_PLATFORMS = [
  "calendly.com", "cal.com", "booksy.com", "fresha.com", "setmore.com",
  "simplybook.me", "vagaro.com", "mindbodyonline.com", "opentable.com",
  "resy.com", "square.site", "book.squareup.com", "tidycal.com", "zcal.co",
  "appointy.com", "picktime.com", "10to8.com", "acuityscheduling.com",
  "schedulicity.com"
];
const BOOKING_PHRASES = [
  "book now", "book online", "book an appointment", "book appointment",
  "schedule online", "request appointment", "make a reservation",
  "reserve a table", "reserve now", "schedule your"
];
const CHAT_WIDGET_MARKERS = [
  "intercom", "tidio", "tawk.to", "tawk", "crisp.chat", "drift.com",
  "livechatinc", "chatbase.co", "manychat", "customerchat", "zendesk",
  "hubspot", "chatway", "chatbot.com"
];
const SOCIAL_HOSTS = {
  instagram: "instagram.com",
  facebook: "facebook.com",
  tiktok: "tiktok.com",
  twitter: "twitter.com",
  x: "x.com",
  youtube: "youtube.com",
  linkedin: "linkedin.com",
  pinterest: "pinterest.com"
};

async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" }
  });
  const raw = await res.text();
  return { status: res.status, finalUrl: res.url, html: raw.slice(0, MAX_HTML_CHARS) };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br[^>]*>|<\/(p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function getTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : null;
}

function getMetaDescription(html) {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].slice(0, 300);
  }
  return null;
}

function getHrefs(html) {
  const hrefs = [];
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) hrefs.push(m[1]);
  return hrefs;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function unique(arr) {
  return [...new Set(arr)];
}

function extractEmails(html, text) {
  const fromMailto = getHrefs(html)
    .filter(h => h.toLowerCase().startsWith("mailto:"))
    .map(h => decodeURIComponent(h.slice(7).split("?")[0]));
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const fromText = text.match(re) || [];
  const bad = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;
  return unique([...fromMailto, ...fromText].map(e => e.toLowerCase()).filter(e => !bad.test(e))).slice(0, 5);
}

function extractPhones(html, text) {
  const fromTel = getHrefs(html)
    .filter(h => h.toLowerCase().startsWith("tel:"))
    .map(h => h.slice(4).split("?")[0].trim());
  const re = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g;
  const candidates = [...fromTel, ...(text.match(re) || [])];
  const seen = new Set();
  const phones = [];
  for (const c of candidates) {
    const digits = c.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    const norm = c.replace(/\s+/g, " ").trim();
    if (seen.has(norm)) continue;
    seen.add(norm);
    phones.push(norm);
    if (phones.length >= 5) break;
  }
  return phones;
}

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) blocks.push(m[1]);
  return blocks;
}

function collectFaqFromJsonLd(html) {
  const faqs = [];
  for (const block of jsonLdBlocks(html)) {
    let data;
    try {
      data = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const type = node["@type"];
      const types = Array.isArray(type) ? type : [type];
      if (types.includes("FAQPage") && Array.isArray(node.mainEntity)) {
        for (const q of node.mainEntity) {
          const question = q.name || q.text;
          const answer = q.acceptedAnswer?.text || q.acceptedAnswer?.name;
          if (question) faqs.push({ question: htmlToText(String(question)), answer: answer ? htmlToText(String(answer)) : undefined });
        }
      }
      if (node["@graph"]) visit(node["@graph"]);
      for (const key of ["mainEntity", "itemListElement", "hasPart"]) {
        if (node[key]) visit(node[key]);
      }
    };
    visit(data);
  }
  return faqs;
}

function headingQuestions(html) {
  const questions = [];
  const re = /<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = htmlToText(m[1]);
    if (t.endsWith("?") && t.length > 8 && t.length < 200) questions.push(t);
  }
  return questions;
}

function textQuestions(text) {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.endsWith("?") && l.length > 10 && l.length < 200)
    .slice(0, 15);
}

function extractSignalsFromHtml(url, html) {
  const text = htmlToText(html);
  const lower = text.toLowerCase();
  const hrefs = getHrefs(html);
  const hosts = hrefs.map(hostOf).filter(Boolean);

  const bookingPlatforms = unique(BOOKING_PLATFORMS.filter(p => hosts.some(h => h === p || h.endsWith("." + p))));
  const bookingPhrases = BOOKING_PHRASES.filter(p => lower.includes(p));

  const socials = {};
  for (const [name, host] of Object.entries(SOCIAL_HOSTS)) {
    const match = hrefs.find(h => {
      const hh = hostOf(h);
      return hh && (hh === host || hh.endsWith("." + host));
    });
    if (match) socials[name] = match;
  }

  const htmlLower = html.toLowerCase();
  const chatWidgets = unique(CHAT_WIDGET_MARKERS.filter(marker => htmlLower.includes(marker)));
  const whatsappLinks = unique(hrefs.filter(h => /wa\.me|api\.whatsapp\.com/i.test(h)));
  const mapLinks = hrefs.some(h => /google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(h));

  const priceMatches = (text.match(/(?:[$€£]\s?\d[\d.,]*|from\s+[$€£]?\d[\d.,]*)/gi) || []).slice(0, 5);
  const pricingWords = /\b(pricing|price list|our prices|menu with prices)\b/i.test(text);

  const hoursMentioned = /\b(opening hours|business hours|mon(day)?\s*[-–to]|open(ing)?\s+(at|from))\b/i.test(text);

  const faqJsonLd = collectFaqFromJsonLd(html);
  const hQuestions = headingQuestions(html);
  const tQuestions = textQuestions(text);

  return {
    url,
    fetched: true,
    http_status: null,
    final_url: null,
    title: getTitle(html),
    meta_description: getMetaDescription(html),
    mobile_viewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    https: url.startsWith("https://"),
    contact_form: /<form[\s>]/i.test(html) && /type=["'](email|tel)["']/i.test(html),
    emails: extractEmails(html, text),
    phones: extractPhones(html, text),
    whatsapp_links: whatsappLinks,
    booking: { platforms: bookingPlatforms, phrases: bookingPhrases },
    socials,
    hours_mentioned: hoursMentioned,
    price_hints: priceMatches,
    pricing_page: pricingWords,
    map_links: mapLinks,
    chat_widgets: chatWidgets,
    faq_jsonld_count: faqJsonLd.length,
    question_count: hQuestions.length + tQuestions.length
  };
}

const REVENUE_IMPACT = {
  online_booking: 5,
  fast_response: 4,
  contact_visible: 4,
  faq_answers: 3,
  google_profile: 3,
  review_replies: 2,
  pricing_listed: 2,
  automation_visible: 2,
  mobile_ready: 2,
  social_active: 1
};

function scoreSignals(signals, overrides = {}) {
  const b = signals.booking || { platforms: [], phrases: [] };
  const strongBookingPhrase = b.phrases.some(p => ["book now", "book online", "book an appointment", "book appointment", "reserve now", "make a reservation"].includes(p));
  const hasSocial = Object.keys(signals.socials || {}).length > 0;

  const checks = [
    { id: "mobile_ready", name: "Site works on mobile", status: signals.mobile_viewport ? "pass" : "fail", detail: signals.mobile_viewport ? "Viewport meta present" : "No viewport meta found — likely poor on phones" },
    { id: "contact_visible", name: "Contact info easy to find", status: (signals.phones.length || signals.emails.length || signals.whatsapp_links.length) ? "pass" : "fail", detail: `${signals.phones.length} phone(s), ${signals.emails.length} email(s), ${signals.whatsapp_links.length} WhatsApp link(s)` },
    { id: "google_profile", name: "Google profile claimed + complete", status: overrides.google_claimed == null ? "manual" : overrides.google_claimed ? "pass" : "fail", detail: "Check Google Maps listing manually" },
    { id: "review_replies", name: "Replies to reviews", status: overrides.replies_to_reviews == null ? "manual" : overrides.replies_to_reviews ? "pass" : "fail", detail: "Check recent review responses manually" },
    { id: "social_active", name: "Active social in last 90 days", status: overrides.social_active_90d != null ? (overrides.social_active_90d ? "pass" : "fail") : (hasSocial ? "manual" : "fail"), detail: hasSocial ? "Accounts found — verify last post date" : "No social links found on site" },
    { id: "online_booking", name: "Online booking / ordering", status: (b.platforms.length > 0 || strongBookingPhrase) ? "pass" : "fail", detail: b.platforms.length ? `Platform: ${b.platforms.join(", ")}` : b.phrases.length ? `Phrases only: ${b.phrases.join(", ")}` : "No booking system found" },
    { id: "faq_answers", name: "FAQ answers common questions", status: (signals.faq_jsonld_count > 0 || signals.question_count >= 2) ? "pass" : "fail", detail: `${signals.faq_jsonld_count} structured FAQ(s), ${signals.question_count} question heading(s)` },
    { id: "pricing_listed", name: "Prices / services clearly listed", status: (signals.price_hints.length > 0 || signals.pricing_page) ? "pass" : "fail", detail: signals.price_hints.length ? `Price hints: ${signals.price_hints.slice(0, 3).join(", ")}` : "No price info found" },
    { id: "fast_response", name: "Responds to enquiries < 24h", status: overrides.fast_response_24h == null ? "manual" : overrides.fast_response_24h ? "pass" : "fail", detail: "Test by submitting an enquiry manually" },
    { id: "automation_visible", name: "Any automation visible", status: (signals.chat_widgets.length > 0 || b.platforms.length > 0 || signals.whatsapp_links.length > 0) ? "pass" : "fail", detail: signals.chat_widgets.length ? `Chat widget: ${signals.chat_widgets.join(", ")}` : b.platforms.length ? "Booking platform implies confirmation emails" : signals.whatsapp_links.length ? "WhatsApp link (manual replies)" : "None found" }
  ];

  const score = checks.filter(c => c.status === "pass").length;
  const manual = checks.filter(c => c.status === "manual");
  const gaps = checks
    .filter(c => c.status === "fail")
    .sort((a, x) => (REVENUE_IMPACT[x.id] || 0) - (REVENUE_IMPACT[a.id] || 0));

  const offer = !checks.find(c => c.id === "online_booking").status.match(/pass/)
    ? { name: "AI assistant: FAQ + booking routing chatbot", price: "$300 setup + $50/mo" }
    : !checks.find(c => c.id === "faq_answers").status.match(/pass/)
    ? { name: "FAQ / knowledge base + assistant add-on", price: "$150–300" }
    : !checks.find(c => c.id === "contact_visible").status.match(/pass/)
    ? { name: "Contact + conversion fixes on site", price: "$150–300" }
    : { name: "Automation add-on (missed-call follow-up / reminders)", price: "$150–500" };

  return {
    score,
    out_of: 10,
    potential_score_if_manual_pass: score + manual.length,
    manual_checks: manual.map(c => c.name),
    gaps: gaps.map(g => ({ checkpoint: g.name, why_it_loses_money: g.detail, revenue_impact_rank: REVENUE_IMPACT[g.id] || 1 })),
    recommended_offer: offer,
    next_step: "Build a 15-min demo for this business (see outreach/demos/README.md), then send the outreach message with the demo link."
  };
}

const server = new McpServer(
  { name: "local-audit", version: "1.0.0" },
  {
    instructions:
      "Audit a local business's public web presence and produce a sales-ready score. Workflow: extract_signals(url) → score_presence(signals + manual overrides) → extract_faqs(url) for demo content. Public pages only; never invent facts; manual checks must be verified by a human."
  }
);

server.registerTool(
  "fetch_page",
  {
    title: "Fetch page as text",
    description: "Fetch a public web page and return its readable text (scripts/styles stripped). Use for quick content checks before deeper analysis.",
    inputSchema: {
      url: z.string().describe("Public page URL (https://...)"),
      max_chars: z.number().int().positive().max(50000).optional().describe("Max characters of text to return (default 8000)")
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  async ({ url, max_chars }) => {
    try {
      const { status, finalUrl, html } = await fetchHtml(url);
      if (status >= 400) {
        return { content: [{ type: "text", text: `Fetch failed: HTTP ${status} for ${url}` }], isError: true };
      }
      const text = htmlToText(html);
      const out = { url, final_url: finalUrl, status, title: getTitle(html), text: text.slice(0, max_chars ?? 8000) };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Fetch error for ${url}: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "extract_signals",
  {
    title: "Extract presence signals",
    description: "Fetch a business's website and extract signals: mobile readiness, contact info, booking system, socials, chat widgets, pricing hints, FAQs. Output feeds score_presence.",
    inputSchema: {
      url: z.string().describe("Business homepage URL (https://...)")
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  async ({ url }) => {
    try {
      const { status, finalUrl, html } = await fetchHtml(url);
      if (status >= 400) {
        return { content: [{ type: "text", text: `Fetch failed: HTTP ${status} for ${url} — site may be down (itself an audit finding)` }], isError: true };
      }
      const signals = extractSignalsFromHtml(url, html);
      signals.http_status = status;
      signals.final_url = finalUrl;
      signals.https = finalUrl.startsWith("https://");
      return { content: [{ type: "text", text: JSON.stringify(signals, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Extract error for ${url}: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "score_presence",
  {
    title: "Score presence out of 10",
    description: "Score a business's web presence using audit checkpoints (0-10), list gaps ranked by revenue impact, and recommend the offer to pitch. Provide either signals (from extract_signals) or a url (will extract first). Manual overrides: google_claimed, replies_to_reviews, social_active_90d, fast_response_24h.",
    inputSchema: {
      signals: z.any().optional().describe("Signals object from extract_signals"),
      url: z.string().optional().describe("Business URL — used if signals not provided"),
      google_claimed: z.boolean().nullable().optional().describe("Google Business Profile claimed + complete?"),
      replies_to_reviews: z.boolean().nullable().optional().describe("Owner replies to Google reviews?"),
      social_active_90d: z.boolean().nullable().optional().describe("Posted on social in last 90 days?"),
      fast_response_24h: z.boolean().nullable().optional().describe("Replies to enquiries within 24h?")
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  async ({ signals, url, google_claimed, replies_to_reviews, social_active_90d, fast_response_24h }) => {
    try {
      let s = signals;
      if (!s) {
        if (!url) {
          return { content: [{ type: "text", text: "Provide either 'signals' or 'url'." }], isError: true };
        }
        const { status, finalUrl, html } = await fetchHtml(url);
        if (status >= 400) {
          return { content: [{ type: "text", text: `Fetch failed: HTTP ${status} for ${url}` }], isError: true };
        }
        s = extractSignalsFromHtml(url, html);
        s.http_status = status;
        s.final_url = finalUrl;
        s.https = finalUrl.startsWith("https://");
      }
      const report = scoreSignals(s, { google_claimed, replies_to_reviews, social_active_90d, fast_response_24h });
      return { content: [{ type: "text", text: JSON.stringify({ business: s.title || s.url, ...report }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Score error: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "extract_faqs",
  {
    title: "Extract FAQ candidates",
    description: "Pull FAQ question/answer pairs from a business website: structured FAQ schema first, then question headings, then question-like text lines. Use to seed chatbot demos.",
    inputSchema: {
      url: z.string().describe("Business page URL (https://...)"),
      max: z.number().int().positive().max(30).optional().describe("Max FAQs to return (default 10)")
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  async ({ url, max }) => {
    const limit = max ?? 10;
    try {
      const { status, html } = await fetchHtml(url);
      if (status >= 400) {
        return { content: [{ type: "text", text: `Fetch failed: HTTP ${status} for ${url}` }], isError: true };
      }
      const jsonLd = collectFaqFromJsonLd(html);
      if (jsonLd.length > 0) {
        return { content: [{ type: "text", text: JSON.stringify({ url, source: "structured_faq_schema", faqs: jsonLd.slice(0, limit) }, null, 2) }] };
      }
      const text = htmlToText(html);
      const questions = unique([...headingQuestions(html), ...textQuestions(text)]).slice(0, limit);
      const out = {
        url,
        source: questions.length ? "question_headings" : "none_found",
        faqs: questions.map(q => ({ question: q })),
        note: questions.length
          ? "Questions only — write answers from the business's public info, mark anything unknown for human follow-up."
          : "No FAQ candidates found on this page. Check a pricing/services/contact page or Google profile Q&A."
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `FAQ error for ${url}: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
