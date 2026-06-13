const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  loadMedicines,
  normalizeSalt,
  saltSimilarity,
  searchMedicine,
} = require("../src/medicine-agent");

test("normalizes salts without strength but preserves strength metadata", async () => {
  await loadMedicines(path.join(__dirname, "..", "medicines.json"));
  const normalized = normalizeSalt("Amoxicillin 500 mg + Clavulanic Acid 125 mg");
  assert.deepEqual(normalized.tokens, ["acid", "amoxicillin", "clavulanic"]);
  assert.deepEqual(normalized.strengths, ["500mg", "125mg"]);
});

test("exact alternatives rank ahead of different-strength alternatives", async () => {
  await loadMedicines(path.join(__dirname, "..", "medicines.json"));
  const result = searchMedicine("Crocin Advance", { limit: 6 });
  assert.equal(result.results[0].matchType, "exact");
  assert.ok(result.results.some((item) => item.medicine.name === "Dolo 650" && item.matchType === "close"));
});

test("combination antibiotic alternatives are exact salt matches", async () => {
  await loadMedicines(path.join(__dirname, "..", "medicines.json"));
  const result = searchMedicine("Augmentin 625", { limit: 5 });
  const names = result.results.filter((item) => item.matchType === "exact").map((item) => item.medicine.name);
  assert.ok(names.includes("Moxikind-CV 625"));
  assert.ok(names.includes("Clavam 625"));
});

test("different strengths are penalized but still comparable", () => {
  const score = saltSimilarity("Paracetamol 500 mg", "Paracetamol 650 mg");
  assert.ok(score > 0.7);
  assert.ok(score < 1);
});
