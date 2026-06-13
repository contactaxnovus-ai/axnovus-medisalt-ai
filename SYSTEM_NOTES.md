# Axnovus MediSalt AI System Notes

This file keeps implementation and safety details out of the working UI.

## What The UI Should Show

- Medicine name input
- Prescription image/document/text input
- Detected medicines
- Ranked salt alternatives
- Match type, price, salt, company, and safety flags

The UI should not explain the product architecture or promote the AI system. Those details belong in documentation.

## Matching Approach

- LLM use is optional and limited to extracting likely medicine names from messy prescription/OCR text.
- Final medicine matching is deterministic and handled by `src/medicine-agent.js`.
- Exact matches require same normalized salt, strength, dosage form, and release type.
- Close matches may share active ingredients but differ in strength or formulation.
- Partial matches should remain clearly marked and require review.

## Safety Rules

- Do not present substitutes as prescriptions.
- Highlight strength differences, dosage-form differences, antibiotics, and chronic-therapy medicines.
- Keep the disclaimer in result responses, not as a permanent marketing/sidebar panel.
- Production deployments should use a licensed and regularly updated medicine database.

## Production Notes

- Move medicine data from `medicines.json` to a managed database.
- Add authentication and rate limiting.
- Avoid logging raw prescription text.
- Track audit events for search and extraction requests.
- Add regression tests for high-risk medicine categories.
