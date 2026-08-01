# TM Academy AI Operations

A Docker-first replacement for the current n8n processing workflow. The stack includes a Next.js operations UI, Fastify API, durable worker, PostgreSQL 16 with pgvector, MinIO, and Apache Tika.

## Start the stack

Docker Desktop is the only runtime prerequisite.

```powershell
docker compose up -d --build
docker compose ps
```

Open [http://localhost:3100](http://localhost:3100) and sign in with the local account configured in `.env` (defaults: `admin@tm.local` / `Admin@123`). Port `3100` intentionally avoids conflicts with applications already using `3000`.

## Product workflows

- Conversations are isolated into **Live Inbox** and **Test Workspace**. Both use the same classification, policy, retrieval, pricing, model, job, and audit pipeline.
- The n8n bridge accepts either normalized message fields or the original Meta webhook payload and writes only to Live Inbox.
- The direct Meta endpoint verifies the hub challenge and `X-Hub-Signature-256`.
- Knowledge is split into **Documents** and **Structured Data**. Structured Data uses a table registry, so future datasets can define their own typed schema, primary key, records, and CSV imports without new UI code.
- Structured Data now behaves as a lightweight database workspace: table navigation, spreadsheet grid, inline editing, record drawer, saved views, filter, sort, field visibility, pagination, bulk archive, typed schema settings, CSV import, and CSV export.
- Documents support upload/extraction, metadata editing, immutable revisions, publishing, archive, pagination, and hybrid FTS/pgvector search.
- Conversation Flow is a versioned runtime artifact. Each supported stage selects a reusable prompt, shows the required grounded tool, can be previewed through the real model gateway, and must be published and pinned in a release before it can affect customer replies.
- Prompt Registry supports creating new prompt definitions as well as immutable versions. A newly created prompt does nothing until it is published, attached to a Flow stage, evaluated, and released.
- AI Studio contains editable immutable prompt versions, policy rules, model-backed evaluation gates, and approval-controlled releases.

## Import the supplied structured facts

Use the web UI rather than modifying the source files:

1. Open **Knowledge → Structured Data → Course Catalog** and import `docs/TM - Fact - Khóa học.csv`.
2. Open **Pricing Rules** and import `docs/TM - Fact - Học phí.csv`.
3. Review the import summary, then use the edit/archive controls to maintain individual records.

The importer supports quoted multiline fields, validates the complete file before writing, skips blank or duplicate rows, and upserts stable records when a file is imported again.

To add another dataset, choose **New table**, define its stable column keys and primary key, then add records or import a CSV whose headers match those keys. Generic table records are validated, audited, versioned, and archived rather than hard-deleted.

Saved views retain their filter, sort, and hidden-field configuration. Double-click a cell in a custom table to edit it inline, or click a row number to open the full record drawer. Built-in Course Catalog and Pricing Rules remain protected by their domain validation while using the same grid workspace.

## Change the customer response flow

1. Open **AI Studio → Prompts**. Create a prompt or create a new version of an existing prompt.
2. Publish the prompt version after reviewing its system template, allowed tools, and model profile.
3. Open **AI Studio → Conversation Flow** and create a flow version. Choose the published prompt for the appropriate runtime stage.
4. Publish the flow version, then use the interactive preview to inspect the exact decision, prompt, flow, provider, response, and grounding validation.
5. Open **Releases**, create a candidate that pins the published flow and prompt versions, approve it, run the regression gate, and activate it.

Draft prompts and draft flows never change the active runtime. Hard rules, required tool policies, grounded fact validation, and payment handover cannot be disabled from a prompt.

## Connect n8n

Open **System → Integrations** to copy the local endpoint and mapping. Configure these values in `.env` for a protected public deployment:

```dotenv
N8N_WEBHOOK_SECRET=replace-with-a-long-random-secret
PUBLIC_WEBHOOK_BASE_URL=https://your-public-api.example.com
```

In an n8n HTTP Request node, send `POST` with header `x-tm-webhook-secret` and this JSON mapping:

If n8n itself runs in Docker, use the `host.docker.internal` endpoint shown on the Integrations page. Use the `localhost` endpoint only when n8n runs directly on the Windows host.

```json
{
  "sender_id": "={{ $json.sender.id }}",
  "message_id": "={{ $json.message.mid }}",
  "text": "={{ $json.message.text }}",
  "timestamp": "={{ $json.timestamp }}",
  "display_name": "={{ $json.display_name }}",
  "attachments": "={{ $json.message.attachments }}"
}
```

## Direct Meta Messenger

Set the following values and restart the stack:

```dotenv
META_APP_SECRET=
META_VERIFY_TOKEN=
META_PAGE_ACCESS_TOKEN=
META_PAGE_ID=
META_CHANNEL_NAME=TM Academy Messenger
META_GRAPH_VERSION=v22.0
```

The callback path is shown in **System → Integrations**. Subscribe the `messages` and `messaging_postbacks` fields in the Meta App dashboard.

## Model gateway

The platform uses an OpenAI-compatible chat-completions gateway when `OPENAI_API_KEY` is configured. Hard rules and grounded data lookups execute outside the model. The active Release pins the exact published prompt and model profile used at runtime. Responses use a strict JSON schema, reject invented or missing facts, preserve course names, never confirm payments, and receive one repair attempt before a deterministic grounded fallback.

```dotenv
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4.1-mini
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini
```

## Verification and operations

Before activation, a candidate Release must be approved and pass the regression suite. The gate runs routing/handover scenarios plus real model responses for Ice Break, Qualification, Course Q&A, and Pricing Q&A.

```powershell
docker build --target build -t tm-ai-operations-server-test server
docker run --rm -e DATABASE_URL=postgresql://tm_platform:tm_platform_local_only@host.docker.internal:5432/tm_platform -e SESSION_SECRET=tm-local-session-secret-change-me-123456 tm-ai-operations-server-test npm test
docker compose logs -f api worker web
docker compose ps
```

Avoid `docker compose down -v` when the PostgreSQL and MinIO data must be retained. Replace all local credentials before exposing the stack publicly.
