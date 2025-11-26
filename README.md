# RAWG Game Analyst

An intelligent video game data analysis chatbot that fetches and analyzes data from the RAWG API. The system uses a structured plan-execute-review architecture powered by Google Gemini 2.5 Flash.

## Quick Start

```bash
cd rawg-agent
npm install
npm run dev
# Open http://localhost:8787
```

## Features

- **Natural Language Queries**: Ask questions about video games in plain English
- **Real-time Data**: Fetches live data from the RAWG Video Games Database
- **Statistical Analysis**: Calculate averages, sums, comparisons across game datasets
- **Transparent Processing**: See every step the agent takes (planning, fetching, calculating)
- **Interactive Widgets**: Expandable data tables and calculation breakdowns
- **Streaming Responses**: Real-time updates via Server-Sent Events

*Psst! Can you find the secret test?*

### Example Queries

```
"What is the average Metacritic score for PC games released in Q1 2024?"
"Which genre had the most highly-rated games in 2023?"
"Compare PlayStation 5 vs Xbox Series ratings"
"How many Super Mario games are there?"
"Top 5 rated indie games of 2024"
```

---

## A Few Words on the Project

The first step in the development process was understanding the tools: *Why is Cloudflare and TS/JS the go-to recommended combination for a system like this?* and *What are the limitations I should expect to face when using these tools?* These questions allowed laying the foundation for the approach for this project.

After creating a very basic setup for testing the MCP system and RAWG API on a minimal UI, I started seeing the limitations and challenges in practice. Namely, how should the calculation step be handled when I can't just execute Python code on Cloudflare. The quirks of using RAWG API also became apparent, for example not being able to query games by platform name but instead having to provide the numeric platform ID, and confusion between Metacritic Score and Rating.

After a couple of iterations of recreating a demo from ground-up and assembling a slightly more complete solution each time, the limitations of the standard MCP approach on the user experience became more noticable. It was slow due to continuous LLM calls whenever multiple different calls were needed on RAWG API. I've previously worked with agentic frameworks that function through execution of generated code like Smolagents, and felt this approach could alleviate the issue of multiple LLM calls.

Since the output of this project is a functional and live solution, the project required spreading attention somewhat evenly across different components. The most challenging part was getting the LLM to use the RAWG API correctly and creating mechanisms to validate and retry. Visualizing and delivering data to the user while providing full transparency also caused some headaches. I have to admit to have relied quite bit on AI assistance on creating the UI and working with TS/JS as I'm mostly specialized in Python for day-to-day work and have limited experience in UI.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Interface                                 │
│                         (Vanilla HTML/CSS/JS)                               │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │ SSE Stream
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Hono API Server                                   │
│                    (Cloudflare Workers Runtime)                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │   POST /api/    │  │ POST /api/chat/ │  │  GET /api/      │              │
│  │      chat       │  │     stream      │  │    health       │              │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────┘              │
└───────────┼────────────────────┼────────────────────────────────────────────┘
            │                    │
            ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Agent Orchestrator                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 1. PLAN    →  Gemini generates JSON execution plan                   │   │
│  │ 2. VALIDATE →  Check action references and structure                 │   │
│  │ 3. EXECUTE →  Run fetch/calculate/compare actions                    │   │
│  │ 4. REVIEW  →  Verify results are satisfactory                        │   │
│  │ 5. ANSWER  →  Gemini generates natural language response             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
┌───────────────────────────┐                     ┌───────────────────────────┐
│      RAWG Tool            │                     │    Calculate Tool         │
│  ┌─────────────────────┐  │                     │  ┌─────────────────────┐  │
│  │ • Fetch games       │  │                     │  │ • average           │  │
│  │ • Filter by:        │  │                     │  │ • sum               │  │
│  │   - Platform        │  │                     │  │ • count             │  │
│  │   - Genre           │  │                     │  │ • min / max         │  │
│  │   - Date range      │  │                     │  │ • compare groups    │  │
│  │   - Metacritic      │  │                     │  └─────────────────────┘  │
│  │   - Search query    │  │                     └───────────────────────────┘
│  │   - Developer       │  │
│  │   - Publisher       │  │
│  └─────────────────────┘  │
│            │              │
│            ▼              │
│    RAWG API (External)    │
└───────────────────────────┘
```

---

## This Is Not Standard MCP

This system takes a different approach from the standard Model Context Protocol (MCP) pattern. Understanding the distinction between standard MCP and this implementation is key to understanding the architecture.

### Standard MCP: Tool-by-Tool Execution

In a typical MCP implementation, the LLM and tools interact in a tight loop:

```
User Query
    │
    ▼
┌─────────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐
│   LLM   │───▶│  Tool 1  │───▶│   LLM   │───▶│  Tool 2  │───▶ ...
│ (call 1)│    │          │    │ (call 2)│    │          │
└─────────┘    └──────────┘    └─────────┘    └──────────┘
                                                    │
                                                    ▼
                                              ┌─────────┐
                                              │   LLM   │───▶ Final Answer
                                              │ (call N)│
                                              └─────────┘
```

Each tool execution requires a round-trip to the LLM:
- **N tool calls = N+1 LLM calls** (initial + one after each tool result)
- The LLM decides the next action after seeing each result

### This System: Plan-First Execution

This implementation generates a complete execution plan upfront, then runs all actions without LLM intervention:

```
User Query
    │
    ▼
┌─────────┐
│   LLM   │──▶ Generate Complete Plan
│ (call 1)│
└─────────┘
    │
    ▼
┌──────────┬──────────┬──────────┐
│  Tool 1  │  Tool 2  │  Tool 3  │  ◀── No LLM calls between actions
└──────────┴──────────┴──────────┘
    │
    ▼
┌─────────┐
│   LLM   │──▶ Review Results (optional re-plan)
│ (call 2)│
└─────────┘
    │
    ▼
┌─────────┐
│   LLM   │──▶ Generate Answer
│ (call 3)│
└─────────┘
```

**N tool calls = 2-3 LLM calls** (plan + optional review + answer)

### Why This Matters

| Aspect | Standard MCP | Plan-First (This System) |
|--------|--------------|--------------------------|
| **LLM Calls** | N+1 for N tools | 2-3 total |
| **Latency** | Compounds with each tool | Fixed overhead |
| **Cost** | Higher (LLM calls are expensive) | Lower |
| **Adaptability** | Can adjust after each result | Adjusts only at review stage |
| **Predictability** | Dynamic, harder to debug | Plan visible upfront |

### Practical Example

For a query like *"Compare average ratings: Action vs RPG vs Indie games in 2023"*:

**Standard MCP approach:**
1. LLM call → decides to fetch Action games
2. Fetch Action games
3. LLM call → decides to fetch RPG games  
4. Fetch RPG games
5. LLM call → decides to fetch Indie games
6. Fetch Indie games
7. LLM call → decides to compare
8. Run comparison
9. LLM call → generate answer

**Total: 5 LLM calls, 4 tool executions**

**This system:**
1. LLM call → generates plan with 4 actions (3 fetches + 1 compare)
2. Execute all 4 actions sequentially (no LLM)
3. LLM call → review results
4. LLM call → generate answer

**Total: 3 LLM calls, 4 tool executions**

### Trade-offs

The plan-first approach is optimized for:
- Queries where the required actions are predictable
- Reducing latency and API costs
- Transparency (users can see the full plan before execution)

Standard MCP may be better for:
- Highly dynamic tasks requiring real-time decision making
- Exploratory workflows where next steps depend heavily on intermediate results

This system mitigates the adaptability trade-off with a **review step** that can trigger re-planning if initial results are unsatisfactory (e.g., a search returns 0 results).

---

### Why choose the trade-offs?
In early testing, the standard MCP structure often produced either a frustratingly slow user experience due to multiple sequential LLM calls, or incomplete results due to not having a proper execution plan to follow. I felt the alternative approach yielded better results. Also, I believe LLM-produced code execution is simply a more elegant way to orchestrate tasks in general.

---

## Project Structure

```
rawg-agent/
├── src/
│   ├── index.ts              # Hono server & API routes
│   ├── agent/
│   │   └── orchestrator.ts   # Core agent logic (plan-execute-review)
│   └── tools/
│       ├── rawg.ts           # RAWG API integration
│       └── calculate.ts      # Statistical calculations
├── public/
│   └── index.html            # Frontend UI (single-page app)
├── wrangler.toml             # Cloudflare Worker config
├── package.json
└── tsconfig.json
```

---

## Deep Dive: Agent Architecture

### The Plan-Execute-Review Pattern

The agent follows a structured approach to answering queries:

#### 1. Plan Generation

When a user submits a query, Gemini generates a JSON execution plan:

```json
{
  "reasoning": "To find the average Metacritic score, I need to fetch PC games from Q1 2024 with scores, then calculate the average.",
  "actions": [
    {
      "action": "fetch",
      "id": "pc_games",
      "params": {
        "platforms": ["pc"],
        "date_from": "2024-01-01",
        "date_to": "2024-03-31",
        "metacritic_min": 1
      },
      "description": "Fetching PC games from Q1 2024"
    },
    {
      "action": "calculate",
      "id": "avg_score",
      "operation": "average",
      "source": "pc_games",
      "field": "metacritic",
      "description": "Calculating average metacritic"
    }
  ]
}
```

#### 2. Plan Validation

Before execution, the orchestrator validates:
- All action IDs are unique
- Calculate/compare actions reference valid fetch action IDs
- Required parameters are present

#### 3. Action Execution

Three action types are supported:

| Action | Purpose | Output |
|--------|---------|--------|
| `fetch` | Query RAWG API for games | List of games + total count |
| `calculate` | Compute statistics on fetched data | Numeric result |
| `compare` | Compare metrics across multiple groups | Winner + all values |

#### 4. Result Review

After execution, Gemini reviews the results:
- If data is satisfactory → proceed to answer generation
- If data is insufficient (e.g., 0 results) → generate a new plan with adjusted parameters

#### 5. Answer Generation

Finally, Gemini synthesizes the execution results into a natural language response.

---

## Deep Dive: Tools

### RAWG Tool (`src/tools/rawg.ts`)

Interfaces with the [RAWG Video Games Database API](https://rawg.io/apidocs).

**Supported Filters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `platforms` | `string[]` | Filter by platform (pc, ps5, xbox-series, switch, etc.) |
| `genres` | `string[]` | Filter by genre (action, rpg, indie, shooter, etc.) |
| `date_from` | `string` | Start date (YYYY-MM-DD) |
| `date_to` | `string` | End date (YYYY-MM-DD) |
| `metacritic_min` | `number` | Minimum Metacritic score |
| `metacritic_max` | `number` | Maximum Metacritic score |
| `search` | `string` | Search query for game names |
| `search_exact` | `boolean` | Require exact match |
| `developers` | `string` | Filter by developer slug |
| `publishers` | `string` | Filter by publisher slug |
| `exclude_additions` | `boolean` | Exclude DLCs/editions |
| `ordering` | `string` | Sort order (e.g., `-metacritic`, `-rating`) |
| `page_size` | `number` | Results per page (max 40) |

**Supported Platforms:**
```
pc, playstation 5, ps5, playstation 4, ps4, playstation 3, ps3,
xbox one, xbox series, xbox 360, nintendo switch, switch,
ios, android, macos, mac, linux
```

**Supported Genres:**
```
action, indie, adventure, rpg, strategy, shooter, casual,
simulation, puzzle, arcade, platformer, racing, sports,
fighting, family, board games, card, educational, mmo
```

### Calculate Tool (`src/tools/calculate.ts`)

Performs statistical operations on game data.

**Operations:**

| Operation | Input | Output |
|-----------|-------|--------|
| `average` | Array of numbers | Mean value |
| `sum` | Array of numbers | Total sum |
| `count` | Array | Number of items |
| `min` | Array of numbers | Minimum value |
| `max` | Array of numbers | Maximum value |
| `compare` | Record<string, number[]> | Averages per group + winner |

**Supported Fields:**
- `metacritic` - Metacritic score (0-100)
- `rating` - RAWG user rating (0-5)
- `ratings_count` - Number of ratings

---

## Deep Dive: Frontend

The frontend is a single-page application with no build step required.

### Key Features

**Processing Steps Display**
- Collapsible timeline showing every agent step
- Real-time updates during processing
- Click any step to view raw JSON details

**Calculation Widgets**
- Interactive cards showing calculation results
- Expandable data tables with game information
- Tab-based views for breakdown vs. raw data

**Streaming Architecture**
- Uses Server-Sent Events (SSE) for real-time updates
- Each step is streamed as it completes
- No page refresh required

**API Key Management**
- Settings modal for custom API keys
- Keys stored in localStorage
- Falls back to server-configured keys

---

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `RAWG_API_KEY` | Your RAWG API key ([get one here](https://rawg.io/apidocs)) |
| `GEMINI_API_KEY` | Your Google Gemini API key ([get one here](https://aistudio.google.com/app/apikey)) |

### Local Development

For local development, add keys to `wrangler.toml` or set them as secrets:

```bash
npx wrangler secret put RAWG_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

### Production Deployment

```bash
npm run deploy
```

API keys should be configured as Cloudflare Worker secrets (not in `wrangler.toml`).

---

## API Reference

### `POST /api/chat`

Non-streaming chat endpoint.

**Request:**
```json
{
  "message": "What's the average rating for indie games?",
  "geminiApiKey": "optional-override",
  "rawgApiKey": "optional-override"
}
```

**Response:**
```json
{
  "answer": "The average rating for indie games is **3.82**...",
  "steps": [
    {
      "id": "abc123",
      "type": "thinking",
      "name": "Analyzing Query",
      "summary": "Understanding the question...",
      "details": {},
      "timestamp": 1234567890
    }
  ]
}
```

### `POST /api/chat/stream`

Streaming chat endpoint using Server-Sent Events.

**Request:** Same as `/api/chat`

**Response:** SSE stream with events:
- `step` - Processing step update
- `answer` - Final answer with calculation widgets
- `error` - Error occurred
- `done` - Stream complete

### `GET /api/health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Backend Framework | Hono |
| LLM | Google Gemini 2.5 Flash |
| Data Source | RAWG Video Games API |
| Frontend | Vanilla HTML/CSS/JS |
| Fonts | Space Grotesk, JetBrains Mono |

---

## Limitations

- **Rate Limits**: Both Gemini and RAWG APIs have rate limits on free tiers
- **Page Size**: RAWG returns max 40 results per request
- **Metacritic Coverage**: Not all games have Metacritic scores
- **Historical Data**: RAWG may not have complete data for very old games

---

## License

MIT
