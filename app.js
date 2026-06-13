const state = {
  apiAvailable: false,
  medicines: [],
  selected: [],
  searchResults: new Map(),
};

const els = {};

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  bindEvents();
  await loadAgentStatus();
  const query = new URLSearchParams(window.location.search).get("q");
  if (query) await addMedicine(query);
});

function cacheElements() {
  [
    "databaseStatus",
    "medicineInput",
    "searchButton",
    "fileInput",
    "extractButton",
    "ocrProgress",
    "freeText",
    "detectButton",
    "detectedList",
    "results",
    "clearButton",
    "medicineCount",
    "saltCount",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setTab(tab.dataset.tab));
  });
  els.searchButton.addEventListener("click", () => addTypedMedicine());
  els.medicineInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addTypedMedicine();
  });
  els.detectButton.addEventListener("click", () => addDetectedFromText(els.freeText.value));
  els.extractButton.addEventListener("click", extractFromFile);
  els.clearButton.addEventListener("click", () => {
    state.selected = [];
    state.searchResults.clear();
    render();
  });
}

async function loadAgentStatus() {
  try {
    const health = await apiGet("/api/health");
    state.apiAvailable = true;
    els.databaseStatus.textContent = health.llmEnabled ? "API ready + LLM extraction" : "API ready";
    setOptionalText("medicineCount", health.stats.medicines);
    setOptionalText("saltCount", health.stats.saltGroups);
  } catch (error) {
    await loadLocalFallback();
  }
}

async function loadLocalFallback() {
  try {
    const response = await fetch("medicines.json");
    state.medicines = await response.json();
    state.apiAvailable = false;
    els.databaseStatus.textContent = "Local mode";
    setOptionalText("medicineCount", state.medicines.length);
    setOptionalText("saltCount", new Set(state.medicines.map((item) => normalizeSalt(item.salt).key)).size);
  } catch (error) {
    els.databaseStatus.textContent = "Search unavailable";
    els.results.textContent = "Could not load the API or local medicine database.";
    console.error(error);
  }
}

function setTab(tabId) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabId));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
}

async function addTypedMedicine() {
  const value = els.medicineInput.value.trim();
  if (!value) return;
  await addMedicine(value);
  els.medicineInput.value = "";
}

async function addDetectedFromText(text) {
  if (!text.trim()) return;
  els.detectButton.disabled = true;
  els.detectButton.textContent = "Detecting";
  try {
    const extraction = state.apiAvailable
      ? await apiPost("/api/extract", { text })
      : { candidates: extractCandidatesLocally(text), notes: ["Using local extraction because the backend API is not available."] };
    const candidates = extraction.candidates || [];
    if (!candidates.length) {
      await addMedicine(text.trim().split(/\n|,/)[0]);
    } else {
      for (const candidate of candidates) {
        await addMedicine(candidate.name, candidate);
      }
    }
    if (extraction.notes?.length) {
      els.ocrProgress.textContent = extraction.notes.join(" ");
    }
  } catch (error) {
    els.ocrProgress.textContent = "Extraction API failed. Add a medicine by name.";
    console.error(error);
  } finally {
    els.detectButton.disabled = false;
    els.detectButton.textContent = "Detect medicines";
  }
}

async function addMedicine(name, candidateMeta = {}) {
  const cleaned = cleanCandidate(name);
  if (!cleaned) return;
  if (!state.selected.some((item) => item.name.toLowerCase() === cleaned.toLowerCase())) {
    state.selected.push({
      name: cleaned,
      confidence: candidateMeta.confidence ?? 1,
      source: candidateMeta.source || "user",
    });
  }
  renderDetected();
  await fetchSearch(cleaned);
  renderResults();
}

function removeMedicine(name) {
  state.selected = state.selected.filter((item) => item.name !== name);
  state.searchResults.delete(name);
  render();
}

async function fetchSearch(query) {
  state.searchResults.set(query, { loading: true });
  renderResults();
  try {
    const result = state.apiAvailable ? await apiPost("/api/search", { query, limit: 12 }) : searchLocally(query, 12);
    state.searchResults.set(query, { loading: false, result });
  } catch (error) {
    state.searchResults.set(query, { loading: false, error: error.message });
  }
}

async function extractFromFile() {
  const file = els.fileInput.files[0];
  if (!file) {
    els.ocrProgress.textContent = "Choose a file first.";
    return;
  }

  els.extractButton.disabled = true;
  els.ocrProgress.textContent = "Reading file...";
  try {
    let text = "";
    if (file.type.startsWith("image/")) {
      text = await extractImageText(file);
    } else if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      text = await extractPdfText(file);
    } else if (file.name.toLowerCase().endsWith(".docx")) {
      text = await extractDocxText(file);
    } else {
      text = await file.text();
    }
    els.freeText.value = text.trim();
    setTab("text");
    await addDetectedFromText(text);
    els.ocrProgress.textContent = "Text extracted and medicines detected.";
  } catch (error) {
    els.ocrProgress.textContent = "Could not read this file. Paste the prescription text manually.";
    console.error(error);
  } finally {
    els.extractButton.disabled = false;
  }
}

async function extractImageText(file) {
  if (!window.Tesseract) throw new Error("Tesseract.js did not load");
  const result = await Tesseract.recognize(file, "eng", {
    logger: (message) => {
      if (message.status) {
        const percent = message.progress ? ` ${Math.round(message.progress * 100)}%` : "";
        els.ocrProgress.textContent = `${message.status}${percent}`;
      }
    },
  });
  return result.data.text;
}

async function extractPdfText(file) {
  const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.7.76/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.7.76/pdf.worker.min.mjs";
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n");
}

async function extractDocxText(file) {
  if (!window.mammoth) throw new Error("Mammoth did not load");
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value;
}

function render() {
  renderDetected();
  renderResults();
}

function renderDetected() {
  if (!state.selected.length) {
    els.detectedList.className = "chips empty";
    els.detectedList.textContent = "No medicines selected yet.";
    return;
  }

  els.detectedList.className = "chips";
  els.detectedList.innerHTML = "";
  state.selected.forEach((item) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${escapeHtml(item.name)} <small>${Math.round(item.confidence * 100)}%</small>`;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `Remove ${item.name}`);
    button.textContent = "x";
    button.addEventListener("click", () => removeMedicine(item.name));
    chip.appendChild(button);
    els.detectedList.appendChild(chip);
  });
}

function renderResults() {
  if (!state.selected.length) {
    els.results.className = "results empty-state";
    els.results.textContent = "Enter or extract a medicine name to compare salts and prices.";
    return;
  }

  els.results.className = "results";
  els.results.innerHTML = "";

  state.selected.forEach((item) => {
    const block = document.createElement("div");
    block.className = "query-block";
    const stateForQuery = state.searchResults.get(item.name);

    if (!stateForQuery || stateForQuery.loading) {
      block.innerHTML = `<div class="query-heading"><h2>${escapeHtml(item.name)}</h2><span class="source-match">Searching deterministic salt index...</span></div>`;
      els.results.appendChild(block);
      return;
    }

    if (stateForQuery.error) {
      block.innerHTML = `<div class="query-heading"><h2>${escapeHtml(item.name)}</h2><span class="source-match">Search failed: ${escapeHtml(stateForQuery.error)}</span></div>`;
      els.results.appendChild(block);
      return;
    }

    const { result } = stateForQuery;
    const sourceText = result.source?.medicine
      ? `Matched source: ${result.source.medicine.name} (${Math.round(result.source.confidence * 100)}%)`
      : "No confident brand match; showing fuzzy salt/name options";

    const heading = document.createElement("div");
    heading.className = "query-heading";
    heading.innerHTML = `<h2>${escapeHtml(item.name)}</h2><span class="source-match">${escapeHtml(sourceText)}</span>`;
    block.appendChild(heading);

    result.results.forEach((row) => block.appendChild(createResultCard(row)));

    const disclaimer = document.createElement("p");
    disclaimer.className = "disclaimer";
    disclaimer.textContent = result.disclaimer;
    block.appendChild(disclaimer);
    els.results.appendChild(block);
  });
}

function createResultCard(row) {
  const card = document.createElement("article");
  card.className = `result-card ${row.matchType}`;
  const label = row.matchType === "exact" ? "Exact salt" : row.matchType === "close" ? "Close salt" : "Partial match";
  const salt = highlightSalt(row.medicine.salt, row.matchedTokens || []);
  const flags = row.safetyFlags?.length
    ? `<div class="flags">${row.safetyFlags.map((flag) => `<span class="flag ${flag.level}">${escapeHtml(flag.message)}</span>`).join("")}</div>`
    : "";
  const reasons = row.reasons?.length ? `<div class="reasons">${row.reasons.map(escapeHtml).join(" ")}</div>` : "";
  card.innerHTML = `
    <div>
      <div class="medicine-name">${escapeHtml(row.medicine.name)}</div>
      <div class="company">${escapeHtml(row.medicine.company)} · ${escapeHtml(row.medicine.category)}</div>
    </div>
    <div>
      <div class="salt">${salt}</div>
      ${reasons}
      ${flags}
    </div>
    <div>
      <div class="price">MRP</div>
      <strong>Rs ${row.medicine.priceInr}</strong>
      <div class="price">${escapeHtml(row.medicine.pack)}</div>
    </div>
    <div>
      <span class="tag ${row.matchType}">${label}</span>
      <div class="score">${Math.round(row.score * 100)}% match</div>
      <div class="score">${escapeHtml(row.medicine.dosageForm)}, ${escapeHtml(row.medicine.releaseType)}</div>
    </div>
  `;
  return card;
}

function highlightSalt(salt, matchedTokens) {
  const tokens = new Set(matchedTokens);
  if (!tokens.size) return escapeHtml(salt);
  return escapeHtml(salt).replace(/\b([a-z][a-z0-9-]*)\b/gi, (match) => {
    return tokens.has(match.toLowerCase()) ? `<strong>${match}</strong>` : match;
  });
}

async function apiGet(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function cleanCandidate(value) {
  return String(value)
    .replace(/\b(tab|tablet|cap|capsule|syp|syrup|inj|injection|od|bd|tds|sos)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\d.\-)\s]+|[\s.:-]+$/g, "")
    .trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}

function setOptionalText(id, value) {
  if (els[id]) els[id].textContent = value;
}

function searchLocally(query, limit) {
  const source = state.medicines
    .map((medicine) => ({ medicine, score: nameSimilarity(query, medicine.name) }))
    .sort((a, b) => b.score - a.score)[0];
  const sourceMedicine = source && source.score >= 0.42 ? source.medicine : null;
  const sourceSalt = sourceMedicine ? sourceMedicine.salt : query;

  const results = state.medicines
    .map((medicine) => {
      const score = sourceMedicine ? saltSimilarity(sourceSalt, medicine.salt) : Math.max(saltSimilarity(sourceSalt, medicine.salt), nameSimilarity(query, medicine.name) * 0.72);
      const matchType = score >= 0.98 && sameClinicalShape(sourceMedicine, medicine) ? "exact" : score >= 0.72 ? "close" : "partial";
      return {
        medicine: publicMedicine(medicine),
        score: Math.round(score * 100) / 100,
        matchType,
        reasons: buildLocalReasons(sourceMedicine, medicine, score),
        safetyFlags: buildLocalSafetyFlags(sourceMedicine, medicine, score),
        matchedTokens: matchedSaltTokens(sourceMedicine?.salt || query, medicine.salt),
      };
    })
    .filter((item) => item.score >= 0.36)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.medicine.priceInr - b.medicine.priceInr))
    .slice(0, limit);

  return {
    query,
    source: sourceMedicine
      ? { medicine: publicMedicine(sourceMedicine), confidence: Math.round(source.score * 100) / 100, method: "local-brand-name" }
      : { medicine: null, confidence: 0, method: "local-fuzzy" },
    results,
    disclaimer: "Decision support only. Confirm salt, strength, dosage form, route, release type, and patient-specific risks with a licensed clinician or pharmacist.",
  };
}

function extractCandidatesLocally(text) {
  const normalized = text.replace(/[^\w\s.+/%-]/g, " ");
  const lower = normalized.toLowerCase();
  const directMatches = state.medicines
    .filter((medicine) => lower.includes(medicine.name.toLowerCase()))
    .map((medicine) => ({ name: medicine.name, confidence: 0.96, rawText: medicine.name, source: "local-database" }));
  const directNames = directMatches.map((item) => item.name.toLowerCase());
  const lineCandidates = normalized
    .split(/\n|;|,/)
    .map(cleanCandidate)
    .filter(Boolean)
    .filter((candidate) => candidate.length > 2 && candidate.length < 56)
    .filter((candidate) => !/^(rx|date|age|sex|dose|diagnosis|doctor|hospital|clinic)$/i.test(candidate))
    .filter((candidate) => !directNames.some((name) => candidate.toLowerCase().includes(name)))
    .map((candidate) => ({ name: candidate, confidence: 0.58, rawText: candidate, source: "local-rules" }));
  const seen = new Set();
  return [...directMatches, ...lineCandidates].filter((item) => {
    const key = item.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

function normalizeSalt(salt) {
  const strengths = [...String(salt).matchAll(/(\d+\.?\d*)\s*(mg|mcg|gm|g|ml|iu|%)/gi)].map((match) => `${match[1]}${match[2].toLowerCase()}`);
  const tokens = String(salt)
    .toLowerCase()
    .replace(/\d+\.?\d*\s*(mg|mcg|gm|g|ml|iu|%)/g, " ")
    .replace(/\b(ip|bp|usp|tablet|capsule|syrup|injection|mg|mcg|gm|g|ml)\b/g, " ")
    .replace(/[()+,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/[\s/+]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .sort();
  return { tokens, strengths, key: [...new Set(tokens)].join("|") };
}

function saltSimilarity(a, b) {
  const left = normalizeSalt(a);
  const right = normalizeSalt(b);
  if (!left.tokens.length || !right.tokens.length) return 0;
  const intersection = left.tokens.filter((token) => right.tokens.includes(token)).length;
  const union = new Set([...left.tokens, ...right.tokens]).size;
  const strengthPenalty = left.strengths.length && right.strengths.length && left.strengths.join("|") !== right.strengths.join("|") ? 0.12 : 0;
  return Math.max(0, intersection / union - strengthPenalty);
}

function matchedSaltTokens(sourceSalt, candidateSalt) {
  const source = new Set(normalizeSalt(sourceSalt).tokens);
  return normalizeSalt(candidateSalt).tokens.filter((token) => source.has(token));
}

function publicMedicine(medicine) {
  return {
    id: `${medicine.name}-${medicine.company}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name: medicine.name,
    company: medicine.company,
    salt: medicine.salt,
    priceInr: medicine.priceInr,
    pack: medicine.pack,
    category: medicine.category,
    dosageForm: inferDosageForm(medicine.name, medicine.pack),
    releaseType: releaseSignature(medicine.salt, medicine.name),
  };
}

function sameClinicalShape(sourceMedicine, candidate) {
  if (!sourceMedicine) return false;
  return (
    normalizeSalt(sourceMedicine.salt).strengths.join("|") === normalizeSalt(candidate.salt).strengths.join("|") &&
    releaseSignature(sourceMedicine.salt, sourceMedicine.name) === releaseSignature(candidate.salt, candidate.name) &&
    inferDosageForm(sourceMedicine.name, sourceMedicine.pack) === inferDosageForm(candidate.name, candidate.pack)
  );
}

function buildLocalReasons(sourceMedicine, candidate, score) {
  if (!sourceMedicine) return ["Ranked by local fuzzy brand/salt similarity because the source brand was not confidently found."];
  const overlap = matchedSaltTokens(sourceMedicine.salt, candidate.salt);
  const reasons = overlap.length ? [`Shared active ingredient token(s): ${overlap.join(", ")}.`] : [];
  if (score >= 0.98) reasons.push("Same normalized salt composition.");
  if (normalizeSalt(sourceMedicine.salt).strengths.join("|") !== normalizeSalt(candidate.salt).strengths.join("|")) {
    reasons.push("Strength differs, so substitution needs dose verification.");
  }
  return reasons;
}

function buildLocalSafetyFlags(sourceMedicine, candidate, score) {
  if (!sourceMedicine) return [{ level: "review", message: "Source medicine not confidently identified." }];
  const flags = [];
  if (score < 0.72) flags.push({ level: "caution", message: "Partial salt match only." });
  if (normalizeSalt(sourceMedicine.salt).strengths.join("|") !== normalizeSalt(candidate.salt).strengths.join("|")) flags.push({ level: "caution", message: "Different strength." });
  if (inferDosageForm(sourceMedicine.name, sourceMedicine.pack) !== inferDosageForm(candidate.name, candidate.pack)) flags.push({ level: "caution", message: "Different dosage form or route." });
  if (/antibiotic/i.test(sourceMedicine.category)) flags.push({ level: "review", message: "Antibiotic substitution should be pharmacist/doctor approved." });
  if (/thyroid|diabetes|hypertension|antiplatelet/i.test(sourceMedicine.category)) flags.push({ level: "review", message: "Chronic therapy substitution needs patient-specific review." });
  return flags;
}

function inferDosageForm(name, pack) {
  const value = `${name} ${pack}`.toLowerCase();
  if (/inhaler|metered/.test(value)) return "inhaler";
  if (/injection|vial/.test(value)) return "injection";
  if (/syrup|ml/.test(value)) return "liquid";
  if (/capsule/.test(value)) return "capsule";
  if (/ointment|cream|gel/.test(value)) return "topical";
  return "tablet";
}

function releaseSignature(salt, name = "") {
  return /\b(sr|sustained release|xr|er|cr|modified release)\b/i.test(`${salt} ${name}`) ? "modified" : "immediate";
}

function nameSimilarity(a, b) {
  const left = cleanCandidate(a).toLowerCase();
  const right = cleanCandidate(b).toLowerCase();
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.includes(left) || left.includes(right)) return 0.88;
  return diceCoefficient(left, right);
}

function diceCoefficient(a, b) {
  const bigrams = (value) => {
    const compact = value.replace(/\s+/g, "");
    const list = [];
    for (let i = 0; i < compact.length - 1; i += 1) list.push(compact.slice(i, i + 2));
    return list;
  };
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  if (!aBigrams.length || !bBigrams.length) return 0;
  let hits = 0;
  const pool = [...bBigrams];
  aBigrams.forEach((gram) => {
    const index = pool.indexOf(gram);
    if (index >= 0) {
      hits += 1;
      pool.splice(index, 1);
    }
  });
  return (2 * hits) / (aBigrams.length + bBigrams.length);
}
