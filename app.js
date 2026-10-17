const form = document.querySelector("#searchForm");
const topicInput = document.querySelector("#topic");
const fromYearInput = document.querySelector("#fromYear");
const toYearInput = document.querySelector("#toYear");
const resultsNode = document.querySelector("#results");
const statusNode = document.querySelector("#status");
const resultsTitle = document.querySelector("#resultsTitle");
const resultCount = document.querySelector("#resultCount");
const resultsSection = document.querySelector(".results-section");
const installButton = document.querySelector("#installButton");
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.hidden = true;
});
window.addEventListener("appinstalled", () => { installButton.hidden = true; });

const clean = (value) => typeof value === "string" ? value.trim() : "";
const text = (value) => clean(Array.isArray(value) ? value[0] : value);
const yearOf = (value) => {
  if (Array.isArray(value)) return Number(value[0]?.year || value[0]);
  if (value?.["date-parts"]) return Number(value["date-parts"]?.[0]?.[0]);
  if (value?.year) return Number(value.year);
  return Number(String(value || "").slice(0, 4)) || null;
};
const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
const safeUrl = (value) => {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
};
const doiUrl = (doi) => doi ? safeUrl(`https://doi.org/${encodeURIComponent(doi.replace(/^https?:\/\/doi.org\//i, ""))}`) : "";
const titleKey = (title) => clean(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function methodQuery(topic, method) {
  if (method === "qualitative") return `${topic} qualitative`; 
  if (method === "quantitative") return `${topic} quantitative`;
  return topic;
}
function authorNames(authors) {
  return (authors || []).slice(0, 4).map((author) => author?.author?.display_name || author?.family || author?.name || "").filter(Boolean).join(", ");
}
function normalizeOpenAlex(work) {
  const doi = clean(work.doi).replace(/^https?:\/\/doi.org\//i, "");
  const oa = work.open_access || {};
  const best = work.best_oa_location || {};
  return { title: text(work.title) || "Untitled article", authors: authorNames(work.authorships), year: yearOf(work.publication_year), source: "OpenAlex", doi, doiLink: doiUrl(doi), pdf: safeUrl(best.pdf_url || ""), landing: safeUrl(best.landing_page_url || oa.oa_url || work.id || ""), method: "Indexed" };
}
function normalizeCrossref(item) {
  const doi = clean(item.DOI);
  const links = Array.isArray(item.link) ? item.link : [];
  const pdf = links.find((link) => /pdf/i.test(link["content-type"] || ""))?.URL || "";
  const landing = item.URL || doiUrl(doi);
  return { title: text(item.title) || "Untitled article", authors: (item.author || []).slice(0, 4).map((a) => [a.given, a.family].filter(Boolean).join(" ")).join(", "), year: yearOf(item.published || item["published-print"] || item["published-online"]), source: "Crossref", doi, doiLink: doiUrl(doi), pdf: safeUrl(pdf), landing: safeUrl(landing), method: "Indexed" };
}
function normalizeSemantic(item) {
  const oa = item.openAccessPdf || {};
  const doi = clean(item.externalIds?.DOI);
  return { title: text(item.title) || "Untitled article", authors: (item.authors || []).slice(0, 4).map((a) => a.name).filter(Boolean).join(", "), year: Number(item.year) || null, source: "Semantic Scholar", doi, doiLink: doiUrl(doi), pdf: safeUrl(oa.url), landing: safeUrl(item.url), method: "Indexed" };
}

async function fetchOpenAlex(query, fromYear, toYear) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query); url.searchParams.set("per-page", "12");
  url.searchParams.set("select", "id,doi,title,publication_year,authorships,open_access,best_oa_location");
  const filters = [];
  if (fromYear) filters.push(`from_publication_date:${fromYear}-01-01`);
  if (toYear) filters.push(`to_publication_date:${toYear}-12-31`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  const response = await fetch(url); if (!response.ok) throw new Error(`OpenAlex ${response.status}`);
  return (await response.json()).results.map(normalizeOpenAlex);
}
async function fetchCrossref(query, fromYear, toYear) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query); url.searchParams.set("rows", "12");
  url.searchParams.set("select", "DOI,title,author,published,published-print,published-online,URL,link");
  const filters = [];
  if (fromYear) filters.push(`from-pub-date:${fromYear}-01-01`);
  if (toYear) filters.push(`until-pub-date:${toYear}-12-31`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  const response = await fetch(url); if (!response.ok) throw new Error(`Crossref ${response.status}`);
  return (await response.json()).message.items.map(normalizeCrossref);
}
async function fetchSemantic(query, fromYear, toYear) {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query); url.searchParams.set("limit", "12");
  url.searchParams.set("fields", "title,authors,year,externalIds,url,openAccessPdf");
  // Semantic Scholar supports closed ranges. Open-ended bounds are applied locally below.
  if (fromYear && toYear) url.searchParams.set("year", `${fromYear}-${toYear}`);
  const response = await fetch(url); if (!response.ok) throw new Error(`Semantic Scholar ${response.status}`);
  return (await response.json()).data.map(normalizeSemantic);
}
function rankAndDeduplicate(items, method) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.doi ? `doi:${item.doi.toLowerCase()}` : `title:${titleKey(item.title)}`;
    if (!key || seen.has(key)) return false; seen.add(key); return true;
  }).map((item) => {
    const haystack = `${item.title} ${item.authors}`.toLowerCase();
    const relevance = method === "qualitative" ? /qualitative|interview|ethnograph|phenomenolog|lived experience|thematic/.test(haystack) : method === "quantitative" ? /quantitative|survey|regression|statistical|experiment|correlation/.test(haystack) : false;
    return { ...item, method: relevance ? method[0].toUpperCase() + method.slice(1) : "Indexed", relevance };
  }).sort((a, b) => Number(b.relevance) - Number(a.relevance) || (b.year || 0) - (a.year || 0)).slice(0, 24);
}
function renderStatus(message, detail, error = false) {
  statusNode.hidden = false; statusNode.innerHTML = `<span class="status-icon">${error ? "!" : "⌕"}</span><div><strong>${escapeHtml(message)}</strong><p>${escapeHtml(detail)}</p></div>`;
}
function renderResults(items, topic) {
  resultsNode.innerHTML = items.map((item) => {
    const actions = [item.doiLink && `<a class="primary" href="${item.doiLink}" target="_blank" rel="noopener">DOI record</a>`, item.pdf && `<a href="${item.pdf}" target="_blank" rel="noopener">Free PDF</a>`, item.landing && `<a href="${item.landing}" target="_blank" rel="noopener">Source page</a>`].filter(Boolean).join("");
    return `<article class="article-card"><div class="article-top"><span class="provider">${escapeHtml(item.source)}</span><span class="method-badge">${escapeHtml(item.method)}</span></div><h3>${escapeHtml(item.title)}</h3><p class="authors">${escapeHtml(item.authors || "Author details not listed by provider")}</p><p class="meta">${item.year ? escapeHtml(item.year) : "Publication year unavailable"}${item.doi ? ` · DOI: ${escapeHtml(item.doi)}` : ""}</p><div class="article-actions">${actions || "<span class=\"meta\">No direct link supplied by provider</span>"}</div></article>`;
  }).join("");
  statusNode.hidden = true; resultsTitle.textContent = `Results for “${topic}”`; resultCount.textContent = `${items.length} verified records`;
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const topic = clean(topicInput.value); const method = document.querySelector("input[name=method]:checked")?.value || "any";
  const fromYear = Number.parseInt(clean(fromYearInput.value), 10) || null;
  const toYear = Number.parseInt(clean(toYearInput.value), 10) || null;
  if (topic.length < 3) return;
  if (fromYear && toYear && fromYear > toYear) {
    resultsNode.innerHTML = "";
    resultCount.textContent = "";
    renderStatus("Invalid year range", "From Year must be earlier than or equal to To Year.", true);
    return;
  }
  resultsSection.setAttribute("aria-busy", "true"); resultsNode.innerHTML = ""; resultCount.textContent = ""; renderStatus("Searching trusted indexes…", "OpenAlex, Crossref, and Semantic Scholar are being queried directly from your browser.");
  const query = methodQuery(topic, method);
  const responses = await Promise.allSettled([fetchOpenAlex(query, fromYear, toYear), fetchCrossref(query, fromYear, toYear), fetchSemantic(query, fromYear, toYear)]);
  const items = responses.flatMap((result) => result.status === "fulfilled" ? result.value : []).filter((item) => (!fromYear || (item.year && item.year >= fromYear)) && (!toYear || (item.year && item.year <= toYear)));
  const failed = responses.filter((result) => result.status === "rejected").length;
  if (!items.length) renderStatus("No records returned", failed === 3 ? "The providers could not be reached. Check your internet connection and try again." : "Try a broader topic or remove the year filter.", true);
  else { const ranked = rankAndDeduplicate(items, method); renderResults(ranked, topic); if (failed) resultCount.textContent += ` · ${failed} provider unavailable`; }
  resultsSection.setAttribute("aria-busy", "false");
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
});

const shortcutMethod = new URLSearchParams(window.location.search).get("method");
if (["qualitative", "quantitative", "any"].includes(shortcutMethod)) {
  const radio = document.querySelector(`input[name="method"][value="${shortcutMethod}"]`);
  if (radio) radio.checked = true;
}
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
