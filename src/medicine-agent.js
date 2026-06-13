const fs = require("node:fs/promises");

let medicines = [];

async function loadMedicines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  medicines = parsed.map(validateMedicine).map(enrichMedicine);
  return medicines;
}

function getStats() {
  return {
    medicines: medicines.length,
    saltGroups: new Set(medicines.map((item) => item.normalizedSalt.key)).size,
    companies: new Set(medicines.map((item) => item.company)).size,
    categories: [...new Set(medicines.map((item) => item.category))].sort(),
  };
}

function searchMedicine(query, options = {}) {
  const limit = options.limit || 10;
  const source = findBestNameMatch(query);
  const sourceMedicine = source && source.score >= 0.42 ? source.medicine : null;
  const sourceSalt = sourceMedicine ? sourceMedicine.salt : query;

  const results = medicines
    .map((medicine) => {
      const saltScore = saltSimilarity(sourceSalt, medicine.salt);
      const nameScore = nameSimilarity(query, medicine.name);
      const score = sourceMedicine ? saltScore : Math.max(saltScore, nameScore * 0.72);
      const matchType = classifyMatch(score, sourceMedicine, medicine);
      return {
        medicine: publicMedicine(medicine),
        score,
        matchType,
        reasons: buildReasons(sourceMedicine, medicine, score),
        safetyFlags: buildSafetyFlags(sourceMedicine, medicine, score),
        matchedTokens: matchedSaltTokens(sourceMedicine?.salt || query, medicine.salt),
      };
    })
    .filter((item) => item.score >= 0.36)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.medicine.priceInr - b.medicine.priceInr;
    })
    .slice(0, limit);

  return {
    query,
    source: sourceMedicine
      ? { medicine: publicMedicine(sourceMedicine), confidence: round(source.score), method: "brand-name" }
      : { medicine: null, confidence: 0, method: "salt-or-fuzzy-name" },
    results: results.map((item) => ({ ...item, score: round(item.score) })),
    disclaimer:
      "Decision support only. Confirm salt, strength, dosage form, route, release type, and patient-specific risks with a licensed clinician or pharmacist.",
  };
}

function extractCandidatesWithRules(text) {
  const normalized = text.replace(/[^\w\s.+/%-]/g, " ");
  const lower = normalized.toLowerCase();
  const directMatches = medicines
    .filter((medicine) => lower.includes(medicine.name.toLowerCase()))
    .map((medicine) => ({ name: medicine.name, confidence: 0.96, rawText: medicine.name, source: "database" }));
  const directNames = directMatches.map((item) => item.name.toLowerCase());

  const lineCandidates = normalized
    .split(/\n|;|,/)
    .map(cleanCandidate)
    .filter(Boolean)
    .filter((candidate) => candidate.length > 2 && candidate.length < 56)
    .filter((candidate) => !stopLine(candidate))
    .filter((candidate) => !directNames.some((name) => candidate.toLowerCase().includes(name)))
    .map((candidate) => ({ name: candidate, confidence: 0.58, rawText: candidate, source: "rules" }));

  const seen = new Set();
  return [...directMatches, ...lineCandidates].filter((item) => {
    const key = item.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

function findBestNameMatch(query) {
  return medicines
    .map((medicine) => ({ medicine, score: nameSimilarity(query, medicine.name) }))
    .sort((a, b) => b.score - a.score)[0];
}

function validateMedicine(item) {
  const required = ["name", "company", "salt", "priceInr", "pack", "category"];
  required.forEach((key) => {
    if (item[key] === undefined || item[key] === "") {
      throw new Error(`Medicine record missing ${key}`);
    }
  });
  return item;
}

function enrichMedicine(item) {
  return {
    ...item,
    id: slugify(`${item.name}-${item.company}-${item.salt}`),
    normalizedSalt: normalizeSalt(item.salt),
  };
}

function publicMedicine(medicine) {
  return {
    id: medicine.id,
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

function normalizeSalt(salt) {
  const strengthMatches = [...salt.matchAll(/(\d+\.?\d*)\s*(mg|mcg|gm|g|ml|iu|%)/gi)].map((match) => `${match[1]}${match[2].toLowerCase()}`);
  const tokens = salt
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

  return {
    tokens,
    key: [...new Set(tokens)].join("|"),
    strengths: strengthMatches,
  };
}

function saltSimilarity(a, b) {
  const left = normalizeSalt(a);
  const right = normalizeSalt(b);
  if (!left.tokens.length || !right.tokens.length) return 0;
  const intersection = left.tokens.filter((token) => right.tokens.includes(token)).length;
  const union = new Set([...left.tokens, ...right.tokens]).size;
  const jaccard = intersection / union;
  const strengthPenalty = left.strengths.length && right.strengths.length && left.strengths.join("|") !== right.strengths.join("|") ? 0.12 : 0;
  return Math.max(0, jaccard - strengthPenalty);
}

function matchedSaltTokens(sourceSalt, candidateSalt) {
  const source = new Set(normalizeSalt(sourceSalt).tokens);
  return normalizeSalt(candidateSalt).tokens.filter((token) => source.has(token));
}

function classifyMatch(score, sourceMedicine, candidate) {
  if (score >= 0.98 && sameClinicalShape(sourceMedicine, candidate)) return "exact";
  if (score >= 0.72) return "close";
  return "partial";
}

function sameClinicalShape(sourceMedicine, candidate) {
  if (!sourceMedicine) return false;
  return (
    normalizeSalt(sourceMedicine.salt).strengths.join("|") === normalizeSalt(candidate.salt).strengths.join("|") &&
    releaseSignature(sourceMedicine.salt, sourceMedicine.name) === releaseSignature(candidate.salt, candidate.name) &&
    inferDosageForm(sourceMedicine.name, sourceMedicine.pack) === inferDosageForm(candidate.name, candidate.pack)
  );
}

function buildReasons(sourceMedicine, candidate, score) {
  if (!sourceMedicine) return ["Ranked by fuzzy brand/salt similarity because the source brand was not confidently found."];
  const reasons = [];
  const sourceTokens = normalizeSalt(sourceMedicine.salt).tokens;
  const candidateTokens = normalizeSalt(candidate.salt).tokens;
  const overlap = candidateTokens.filter((token) => sourceTokens.includes(token));
  if (overlap.length) reasons.push(`Shared active ingredient token(s): ${overlap.join(", ")}.`);
  if (score >= 0.98) reasons.push("Same normalized salt composition.");
  if (normalizeSalt(sourceMedicine.salt).strengths.join("|") !== normalizeSalt(candidate.salt).strengths.join("|")) {
    reasons.push("Strength differs, so substitution needs dose verification.");
  }
  if (releaseSignature(sourceMedicine.salt, sourceMedicine.name) !== releaseSignature(candidate.salt, candidate.name)) {
    reasons.push("Release type differs or is unclear.");
  }
  return reasons;
}

function buildSafetyFlags(sourceMedicine, candidate, score) {
  const flags = [];
  if (!sourceMedicine) {
    flags.push({ level: "review", message: "Source medicine not confidently identified." });
    return flags;
  }
  if (score < 0.72) flags.push({ level: "caution", message: "Partial salt match only." });
  if (normalizeSalt(sourceMedicine.salt).strengths.join("|") !== normalizeSalt(candidate.salt).strengths.join("|")) {
    flags.push({ level: "caution", message: "Different strength." });
  }
  if (inferDosageForm(sourceMedicine.name, sourceMedicine.pack) !== inferDosageForm(candidate.name, candidate.pack)) {
    flags.push({ level: "caution", message: "Different dosage form or route." });
  }
  if (/antibiotic/i.test(sourceMedicine.category)) {
    flags.push({ level: "review", message: "Antibiotic substitution should be pharmacist/doctor approved." });
  }
  if (/thyroid|diabetes|hypertension|antiplatelet/i.test(sourceMedicine.category)) {
    flags.push({ level: "review", message: "Chronic therapy substitution needs patient-specific review." });
  }
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
  const value = `${salt} ${name}`.toLowerCase();
  if (/\b(sr|sustained release|xr|er|cr|modified release)\b/.test(value)) return "modified";
  return "immediate";
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

function cleanCandidate(value) {
  return String(value)
    .replace(/\b(tab|tablet|cap|capsule|syp|syrup|inj|injection|od|bd|tds|sos|before|after|daily|night|morning)\b/gi, " ")
    .replace(/\b(food|meal|meals|breakfast|lunch|dinner|empty stomach)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\d.\-)\s]+|[\s.:-]+$/g, "")
    .trim();
}

function stopLine(candidate) {
  return /^(rx|date|age|sex|male|female|dose|diagnosis|doctor|hospital|clinic|follow up|review)$/i.test(candidate);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function buildAuditEvent(event, requestId, details) {
  return {
    event,
    requestId,
    timestamp: new Date().toISOString(),
    ...details,
  };
}

module.exports = {
  buildAuditEvent,
  extractCandidatesWithRules,
  getStats,
  loadMedicines,
  normalizeSalt,
  saltSimilarity,
  searchMedicine,
};
