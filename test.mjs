import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Glow Studio — Hair & Beauty in Springfield</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Glow Studio: haircuts, coloring, bridal. Book online.">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      { "@type": "Question", "name": "Do you take walk-ins?",
        "acceptedAnswer": { "@type": "Answer", "text": "Yes, but booking guarantees your slot." } },
      { "@type": "Question", "name": "How much is a color treatment?",
        "acceptedAnswer": { "@type": "Answer", "text": "Coloring starts from $80 depending on hair length." } }
    ]
  }
  </script>
</head>
<body>
  <h1>Glow Studio</h1>
  <p>Call us at <a href="tel:+15550134567">+1 (555) 013-4567</a> or email <a href="mailto:hello@glowstudio.example">hello@glowstudio.example</a></p>
  <a href="https://booksy.com/en-us/glow-studio">Book Now</a>
  <a href="https://instagram.com/glowstudio">Instagram</a>
  <h2>What are your opening hours?</h2>
  <p>Mon-Fri 9am-7pm, Sat 9am-5pm.</p>
  <h2>Where are you located?</h2>
  <p>123 Main Street, Springfield. <a href="https://maps.app.goo.gl/abc123">Find us on the map</a></p>
  <h2>Prices</h2>
  <ul><li>Haircut from $35</li><li>Coloring from $80</li><li>Bridal from $250</li></ul>
</body>
</html>`;

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const server = await startFixtureServer();
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
console.log(`Fixture site running at ${base}\n`);

const client = new Client({ name: "local-audit-test", version: "1.0.0" });
const transport = new StdioClientTransport({ command: "node", args: ["index.js"] });
await client.connect(transport);

console.log("listTools:");
const tools = await client.listTools();
const toolNames = tools.tools.map(t => t.name).sort();
check("4 tools registered", toolNames.length === 4, toolNames.join(","));
for (const expected of ["extract_faqs", "extract_signals", "fetch_page", "score_presence"]) {
  check(`tool ${expected} exists`, toolNames.includes(expected));
}

console.log("\nfetch_page:");
const fetchRes = await client.callTool({ name: "fetch_page", arguments: { url: base } });
const fetchData = JSON.parse(fetchRes.content[0].text);
check("returns page text", fetchData.text.includes("Glow Studio"));
check("returns title", fetchData.title === "Glow Studio — Hair & Beauty in Springfield");

console.log("\nextract_signals:");
const sigRes = await client.callTool({ name: "extract_signals", arguments: { url: base } });
const sig = JSON.parse(sigRes.content[0].text);
check("finds phone from tel: link", sig.phones.some(p => p.replace(/\D/g, "").includes("5550134567")), JSON.stringify(sig.phones));
check("finds email", sig.emails.includes("hello@glowstudio.example"), JSON.stringify(sig.emails));
check("detects booking platform", sig.booking.platforms.includes("booksy.com"), JSON.stringify(sig.booking));
check("detects instagram", Boolean(sig.socials.instagram));
check("mobile viewport detected", sig.mobile_viewport === true);
check("price hints found", sig.price_hints.length >= 2, JSON.stringify(sig.price_hints));
check("FAQ schema counted", sig.faq_jsonld_count === 2, String(sig.faq_jsonld_count));
check("hours mentioned", sig.hours_mentioned === true);
check("user agent blocked nothing (status 200)", sig.http_status === 200);
check("no false-positive chat widgets", sig.chat_widgets.length === 0, JSON.stringify(sig.chat_widgets));

console.log("\nscore_presence (from signals):");
const scoreRes = await client.callTool({ name: "score_presence", arguments: { signals: sig } });
const score = JSON.parse(scoreRes.content[0].text);
check("score is 6-7 (auto passes only)", score.score >= 6 && score.score <= 7, `score=${score.score}`);
check("4 manual checks listed", score.manual_checks.length === 4, JSON.stringify(score.manual_checks));
check("no auto gaps on good site", score.gaps.length === 0, JSON.stringify(score.gaps));
check("offer is sensible", typeof score.recommended_offer.name === "string");

console.log("\nscore_presence (bad site: fetch error path via url with overrides):");
const score2Res = await client.callTool({
  name: "score_presence",
  arguments: {
    signals: {
      url: base, title: "Bare page", mobile_viewport: false, https: false,
      emails: [], phones: [], whatsapp_links: [], contact_form: false,
      booking: { platforms: [], phrases: [] }, socials: {},
      hours_mentioned: false, price_hints: [], pricing_page: false,
      map_links: false, chat_widgets: [], faq_jsonld_count: 0, question_count: 0
    },
    google_claimed: false, replies_to_reviews: false, social_active_90d: false, fast_response_24h: false
  }
});
const score2 = JSON.parse(score2Res.content[0].text);
check("bad site scores low", score2.score <= 1, `score=${score2.score}`);
check("gaps ranked, booking first", score2.gaps.length >= 8 && score2.gaps[0].checkpoint.includes("booking"), JSON.stringify(score2.gaps.map(g => g.checkpoint)));
check("recommends chatbot offer", score2.recommended_offer.name.includes("AI assistant"));

console.log("\nextract_faqs:");
const faqRes = await client.callTool({ name: "extract_faqs", arguments: { url: base } });
const faq = JSON.parse(faqRes.content[0].text);
check("source is structured schema", faq.source === "structured_faq_schema", faq.source);
check("2 FAQs with answers", faq.faqs.length === 2 && Boolean(faq.faqs[0].answer));

console.log("\nerror handling:");
const errRes = await client.callTool({ name: "fetch_page", arguments: { url: "http://127.0.0.1:1" } });
check("connection refused reported as error", errRes.isError === true, JSON.stringify(errRes.content?.[0]?.text)?.slice(0, 80));

await client.close();
server.close();

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
