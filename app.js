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


// Offline student tools: these modules use browser state only and do not call the article APIs.
const toolsToggle = document.querySelector("#toolsToggle");
const toolsPanel = document.querySelector("#toolsPanel");
const toolModal = document.querySelector("#toolModal");
const toolContent = document.querySelector("#toolContent");
const toolModalTitle = document.querySelector("#toolModalTitle");
const toolModalEyebrow = document.querySelector("#toolModalEyebrow");
let activeTool = "";

const openToolsMenu = () => { toolsPanel.hidden = false; toolsToggle.setAttribute("aria-expanded", "true"); };
const closeToolsMenu = () => { toolsPanel.hidden = true; toolsToggle.setAttribute("aria-expanded", "false"); };
toolsToggle?.addEventListener("click", () => toolsPanel.hidden ? openToolsMenu() : closeToolsMenu());

const defaultToolTitles = { calculator: "Scientific Calculator", gpa: "GPA Calculator", timer: "Study Timer", notes: "Notes" };
function openTool(tool) {
  activeTool = tool; closeToolsMenu(); toolModal.hidden = false; document.body.classList.add("modal-open");
  toolModalTitle.textContent = defaultToolTitles[tool] || "Student tool";
  toolModalEyebrow.textContent = tool === "notes" ? "PRIVATE ON THIS DEVICE" : "OFFLINE STUDENT TOOL";
  if (tool === "calculator") renderCalculator();
  if (tool === "gpa") renderGpa();
  if (tool === "timer") renderTimer();
  if (tool === "notes") renderNotes();
}
function closeTool() { toolModal.hidden = true; document.body.classList.remove("modal-open"); activeTool = ""; }
document.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => openTool(button.dataset.tool)));
toolModal?.addEventListener("click", (event) => { if (event.target.matches("[data-close-tool]")) closeTool(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !toolModal.hidden) closeTool(); });

function evaluateMath(source) {
  const tokens = source.replace(/\s+/g, "").match(/(?:\d+(?:\.\d*)?|\.\d+|[A-Za-z]+|[()+\-*/%^!])/g) || [];
  if (!tokens.length || tokens.join("") !== source.replace(/\s+/g, "")) throw new Error("Invalid expression");
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const primary = () => {
    const token = take();
    if (token === "(") { const value = expression(); if (take() !== ")") throw new Error("Missing parenthesis"); return value; }
    if (/^\d|^\./.test(token || "")) return Number(token);
    if (/^[A-Za-z]+$/.test(token || "")) {
      if (token.toLowerCase() === "pi") return Math.PI;
      if (token.toLowerCase() === "e") return Math.E;
      if (take() !== "(") throw new Error("Function needs parentheses");
      const value = expression(); if (take() !== ")") throw new Error("Missing parenthesis");
      const functions = { sin: (n) => Math.sin(n * Math.PI / 180), cos: (n) => Math.cos(n * Math.PI / 180), tan: (n) => Math.tan(n * Math.PI / 180), sqrt: Math.sqrt, log: Math.log10, ln: Math.log, abs: Math.abs };
      if (!functions[token.toLowerCase()]) throw new Error("Unknown function");
      return functions[token.toLowerCase()](value);
    }
    throw new Error("Invalid expression");
  };
  const power = () => { let value = primary(); if (peek() === "!") { while (peek() === "!") { take(); if (value < 0 || value > 170 || value % 1) throw new Error("Invalid factorial"); let result = 1; for (let i = 2; i <= value; i += 1) result *= i; value = result; } } if (peek() === "^") { take(); value = Math.pow(value, power()); } return value; };
  const unary = () => { if (peek() === "+") { take(); return unary(); } if (peek() === "-") { take(); return -unary(); } return power(); };
  const term = () => { let value = unary(); while (["*", "/", "%"].includes(peek())) { const operator = take(); const next = unary(); if (operator === "*") value *= next; if (operator === "/") value /= next; if (operator === "%") value %= next; } return value; };
  const expression = () => { let value = term(); while (["+", "-"].includes(peek())) { const operator = take(); const next = term(); value = operator === "+" ? value + next : value - next; } return value; };
  const answer = expression();
  if (position !== tokens.length || !Number.isFinite(answer)) throw new Error("Invalid result");
  return answer;
}
function numberText(value) { return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12))); }
const calculatorState = { expression: "", display: "0" };
function renderCalculator() {
  toolContent.innerHTML = `<div class="calc-display" id="calcDisplay" aria-live="polite">${escapeHtml(calculatorState.display)}</div><p class="calc-hint">Trigonometric functions use degrees. Try <strong>sin(30)</strong>, <strong>sqrt(25)</strong>, or <strong>2^3</strong>.</p><div class="calc-grid">${["sin(","cos(","tan(","sqrt(","log(","7","8","9","/","AC","4","5","6","*","⌫","1","2","3","-","(","0",".","π",")","+","%","^","!","="] .map((key) => `<button class="calc-key ${/[A-Za-zπ]/.test(key) ? "function" : ""} ${key === "=" ? "equals" : ""} ${key === "AC" ? "wide" : ""}" type="button" data-calc="${key}">${key}</button>`).join("")}</div>`;
  toolContent.querySelectorAll("[data-calc]").forEach((button) => button.addEventListener("click", () => handleCalculator(button.dataset.calc)));
}
function handleCalculator(key) {
  if (key === "AC") { calculatorState.expression = ""; calculatorState.display = "0"; }
  else if (key === "⌫") { calculatorState.expression = calculatorState.expression.slice(0, -1); calculatorState.display = calculatorState.expression || "0"; }
  else if (key === "=") { try { calculatorState.display = numberText(evaluateMath(calculatorState.expression.replaceAll("π", "pi"))); calculatorState.expression = calculatorState.display; } catch { calculatorState.display = "Error"; } }
  else { calculatorState.expression += key; calculatorState.display = calculatorState.expression.replaceAll("pi", "π") || "0"; }
  const display = document.querySelector("#calcDisplay"); if (display) display.textContent = calculatorState.display;
}

let gpaRows = [{ name: "", grade: "", credits: "" }, { name: "", grade: "", credits: "" }, { name: "", grade: "", credits: "" }];
function renderGpa(result = "") {
  toolContent.innerHTML = `<p class="calc-hint">Enter each course's grade point and credit hours. GPA is calculated as Σ(grade point × credits) ÷ Σ credits.</p><table class="gpa-table"><thead><tr><th>Course</th><th>Grade point</th><th>Credits</th><th></th></tr></thead><tbody>${gpaRows.map((row, index) => `<tr><td><input data-gpa="name" data-row="${index}" value="${escapeHtml(row.name)}" placeholder="Course ${index + 1}" /></td><td><input data-gpa="grade" data-row="${index}" type="number" min="0" max="4" step="0.01" value="${escapeHtml(row.grade)}" placeholder="3.5" /></td><td><input data-gpa="credits" data-row="${index}" type="number" min="0" step="0.5" value="${escapeHtml(row.credits)}" placeholder="3" /></td><td><button class="gpa-remove" type="button" data-remove-gpa="${index}" aria-label="Remove course">×</button></td></tr>`).join("")}</tbody></table><div class="tool-actions"><button class="tool-secondary" type="button" id="addGpaRow">+ Add course</button><button class="tool-primary" type="button" id="calculateGpa">Calculate GPA</button></div><div class="gpa-result" id="gpaResult" ${result ? "" : "hidden"}>${result}</div>`;
  toolContent.querySelectorAll("[data-gpa]").forEach((input) => input.addEventListener("input", () => { gpaRows[Number(input.dataset.row)][input.dataset.gpa] = input.value; }));
  toolContent.querySelectorAll("[data-remove-gpa]").forEach((button) => button.addEventListener("click", () => { if (gpaRows.length > 1) { gpaRows.splice(Number(button.dataset.removeGpa), 1); renderGpa(); } }));
  document.querySelector("#addGpaRow").addEventListener("click", () => { gpaRows.push({ name: "", grade: "", credits: "" }); renderGpa(); });
  document.querySelector("#calculateGpa").addEventListener("click", () => { const valid = gpaRows.map((row) => ({ grade: Number(row.grade), credits: Number(row.credits) })).filter((row) => row.credits > 0 && Number.isFinite(row.grade)); const credits = valid.reduce((sum, row) => sum + row.credits, 0); const points = valid.reduce((sum, row) => sum + row.grade * row.credits, 0); const resultNode = document.querySelector("#gpaResult"); if (!valid.length || !credits) { resultNode.textContent = "Enter at least one course with grade points and credit hours."; } else { resultNode.innerHTML = `<strong>${(points / credits).toFixed(2)}</strong> GPA <span>· ${credits} weighted credits</span>`; } resultNode.hidden = false; });
}

const timerState = { seconds: 25 * 60, duration: 25 * 60, interval: null, running: false };
function timerText() { const minutes = Math.floor(timerState.seconds / 60).toString().padStart(2, "0"); const seconds = (timerState.seconds % 60).toString().padStart(2, "0"); return `${minutes}:${seconds}`; }
function updateTimerDisplay() { const display = document.querySelector("#timerDisplay"); const status = document.querySelector("#timerStatus"); if (display) display.textContent = timerText(); if (status) status.textContent = timerState.seconds === 0 ? "Session complete" : timerState.running ? "Focus mode is running" : "Ready when you are"; }
function stopTimerInterval() { if (timerState.interval) { clearInterval(timerState.interval); timerState.interval = null; } timerState.running = false; }
function startTimer() { if (timerState.seconds === 0) timerState.seconds = timerState.duration; timerState.running = true; if (!timerState.interval) timerState.interval = setInterval(() => { if (timerState.seconds > 0) timerState.seconds -= 1; if (timerState.seconds === 0) stopTimerInterval(); updateTimerDisplay(); }, 1000); updateTimerDisplay(); }
function renderTimer() { toolContent.innerHTML = `<div class="timer-wrap"><p class="timer-status" id="timerStatus">Ready when you are</p><div class="timer-display" id="timerDisplay">${timerText()}</div><div class="timer-settings"><label class="tool-label">Minutes<input class="tool-input" id="timerMinutes" type="number" min="1" max="240" value="${Math.round(timerState.duration / 60)}" /></label></div><div class="tool-actions" style="justify-content:center"><button class="tool-primary" type="button" id="timerStart">${timerState.running ? "Pause" : timerState.seconds < timerState.duration ? "Resume" : "Start"}</button><button class="tool-secondary" type="button" id="timerReset">Reset</button></div></div>`; updateTimerDisplay(); document.querySelector("#timerStart").addEventListener("click", () => { if (timerState.running) stopTimerInterval(); else startTimer(); renderTimer(); }); document.querySelector("#timerReset").addEventListener("click", () => { stopTimerInterval(); timerState.seconds = timerState.duration; renderTimer(); }); document.querySelector("#timerMinutes").addEventListener("change", (event) => { if (!timerState.running) { const minutes = Math.min(240, Math.max(1, Number(event.target.value) || 25)); timerState.duration = minutes * 60; timerState.seconds = timerState.duration; renderTimer(); } }); }

const notesKey = "azeemAcademicSolutionNotes";
let notes = (() => { try { const saved = JSON.parse(localStorage.getItem(notesKey) || "[]"); return Array.isArray(saved) ? saved : []; } catch { return []; } })();
let editingNoteId = null;
function saveNotes() { try { localStorage.setItem(notesKey, JSON.stringify(notes)); } catch { /* private browsing may disable storage */ } }
function renderNotes() { const editing = notes.find((note) => note.id === editingNoteId); toolContent.innerHTML = `<div class="note-toolbar"><p>${notes.length} saved note${notes.length === 1 ? "" : "s"} on this device</p><button class="tool-secondary" type="button" id="newNote">+ New note</button></div><div class="note-editor"><label class="tool-label">Title<input class="tool-input" id="noteTitle" maxlength="100" value="${escapeHtml(editing?.title || "")}" placeholder="Research idea" /></label><label class="tool-label">Note<textarea class="note-input" id="noteBody" maxlength="5000" placeholder="Write a thought, task, or reminder…">${escapeHtml(editing?.body || "")}</textarea></label><div class="tool-actions"><button class="tool-primary" type="button" id="saveNote">${editing ? "Update note" : "Save note"}</button>${editing ? "<button class=\"tool-danger\" type=\"button\" id=\"deleteNote\">Delete note</button>" : ""}</div></div><div class="notes-list">${notes.length ? notes.map((note) => `<article class="note-card"><div class="note-card-head"><h3>${escapeHtml(note.title || "Untitled note")}</h3><button class="tool-secondary" type="button" data-edit-note="${note.id}">Edit</button></div><p>${escapeHtml(note.body)}</p><div class="note-date">Updated ${escapeHtml(new Date(note.updated).toLocaleString())}</div></article>`).join("") : "<div class=\"note-empty\">No notes yet. Your notes stay in this browser only.</div>"}</div>`;
  document.querySelector("#newNote").addEventListener("click", () => { editingNoteId = null; renderNotes(); });
  document.querySelector("#saveNote").addEventListener("click", () => { const title = document.querySelector("#noteTitle").value.trim(); const body = document.querySelector("#noteBody").value.trim(); if (!title && !body) return; if (editingNoteId) { const note = notes.find((item) => item.id === editingNoteId); if (note) { note.title = title; note.body = body; note.updated = Date.now(); } } else { notes.unshift({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, title, body, updated: Date.now() }); } saveNotes(); editingNoteId = null; renderNotes(); });
  document.querySelector("#deleteNote")?.addEventListener("click", () => { notes = notes.filter((note) => note.id !== editingNoteId); saveNotes(); editingNoteId = null; renderNotes(); });
  toolContent.querySelectorAll("[data-edit-note]").forEach((button) => button.addEventListener("click", () => { editingNoteId = button.dataset.editNote; renderNotes(); }));
}
