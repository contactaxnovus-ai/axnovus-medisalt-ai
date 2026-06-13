# Axnovus MediSalt AI

Axnovus MediSalt AI is a production-shaped medicine alternative search prototype themed for Axnovus. It accepts a medicine name or prescription text, identifies likely medicine names, resolves a source brand to its salt composition, and returns ranked alternatives from a local medicine database.

## Architecture

```text
Browser UI
  - typed medicine input
  - image/PDF/DOCX/TXT text extraction
  - editable detected medicine chips
        |
        v
Backend API
  - optional LLM extraction for messy OCR text
  - deterministic medicine-name lookup
  - deterministic salt similarity search
  - strength, dosage-form, and release-type guardrails
        |
        v
Local medicine database
  - brand
  - company
  - salt composition
  - MRP
  - pack size
  - category
```

## Why LLM Is Optional

The LLM is useful for reading messy OCR output and extracting medicine names. It is intentionally not used as the final judge for salt equivalence. Salt matching is deterministic, auditable, and reproducible in `src/medicine-agent.js`.

## Run

```powershell
npm start
```

Then open:

```text
http://localhost:8000
```

## Enable LLM Extraction

Copy `.env.example` to your environment or set variables directly:

```powershell
$env:OPENAI_API_KEY="your_api_key"
$env:OPENAI_MODEL="gpt-4.1-mini"
npm start
```

Without `OPENAI_API_KEY`, `/api/extract` uses deterministic rule-based extraction.

## API

```http
GET /api/health
GET /api/medicines/stats
POST /api/extract
POST /api/search
```

Example:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/search -ContentType application/json -Body '{"query":"Augmentin 625","limit":5}'
```

## Production Checklist

- Replace `medicines.json` with a licensed, updated drug database.
- Add database migrations and move medicine data to PostgreSQL or another managed datastore.
- Add authentication, rate limiting, request logging, and PHI/PII retention rules.
- Store only minimum necessary prescription text and avoid logging raw prescriptions.
- Add human approval workflow for substitutions.
- Validate market-specific regulatory requirements before recommending alternatives.
- Integrate pharmacy inventory and real-time price feeds only from authorized sources.
- Add regression tests for high-risk categories such as antibiotics, anticoagulants, insulin, thyroid, cardiac, psychiatric, pediatric, and pregnancy-related medicines.

## Safety Note

This is decision support, not a prescribing tool. Always confirm salt, strength, route, dosage form, release type, contraindications, allergies, and patient-specific risks with a licensed clinician or pharmacist.
