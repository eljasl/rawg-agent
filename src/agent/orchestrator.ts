/**
 * =============================================================================
 * AGENT ORCHESTRATOR - Plan-First Execution Pattern
 * =============================================================================
 * 
 * This module implements a "Plan-First" approach to tool orchestration, which
 * differs significantly from the standard Model Context Protocol (MCP) pattern.
 * 
 * ## Standard MCP vs Plan-First
 * 
 * In standard MCP, the LLM makes one tool call at a time, evaluating results
 * after each call before deciding the next action:
 * 
 *   User Query → LLM → Tool 1 → LLM → Tool 2 → LLM → ... → Answer
 *   (N tool calls = N+1 LLM calls)
 * 
 * In our Plan-First approach, the LLM generates a complete execution plan
 * upfront, then we execute ALL actions without LLM intervention:
 * 
 *   User Query → LLM (Plan) → [Tool 1, Tool 2, Tool 3] → LLM (Review) → LLM (Answer)
 *   (N tool calls = 2-3 LLM calls total)
 * 
 * ## Benefits
 * - Lower latency (fewer round-trips to LLM)
 * - Lower cost (LLM calls are expensive)
 * - More predictable (plan is visible upfront)
 * - Better transparency (users can see the full plan before execution)
 * 
 * ## Trade-offs
 * - Less adaptive during execution (can't change strategy mid-stream)
 * - Mitigated by the "review" step which can trigger re-planning if needed
 * 
 * ## Architecture Flow
 * 1. PLAN     - LLM generates a JSON execution plan from the user query
 * 2. VALIDATE - Check that all action references and structure are valid
 * 3. EXECUTE  - Run all fetch/calculate/compare actions sequentially
 * 4. REVIEW   - LLM checks if results are satisfactory (can trigger re-plan)
 * 5. ANSWER   - LLM generates a natural language response from the results
 * 
 * =============================================================================
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { fetchGameData, FetchGameDataInput, PLATFORMS, GENRES, Game } from '../tools/rawg';
import { executeCalculation, CalculationInput, extractField } from '../tools/calculate';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Represents a single step in the agent's processing pipeline.
 * Steps are streamed to the frontend in real-time to show progress.
 * 
 * Step types:
 * - 'thinking'          - Agent is analyzing or processing
 * - 'plan'              - A new execution plan has been created
 * - 'tool_call'         - About to execute a tool (fetch, calculate, compare)
 * - 'tool_result'       - Tool execution completed with results
 * - 'review'            - Reviewing execution results
 * - 'generating_answer' - LLM is generating the final response
 * - 'answer'            - Final answer is ready
 * - 'error'             - An error occurred
 */
export interface Step {
  id: string;
  type: 'thinking' | 'plan' | 'tool_call' | 'tool_result' | 'generating_answer' | 'answer' | 'error' | 'review';
  name: string;
  summary: string;
  details: any;
  timestamp: number;
}

/**
 * The final response from the agent, containing the answer and all processing steps.
 */
export interface AgentResponse {
  answer: string;
  steps: Step[];
}

/**
 * Generates a unique identifier for each step.
 * Uses a random base-36 string for compact, URL-safe IDs.
 */
function generateStepId(): string {
  return Math.random().toString(36).substring(2, 9);
}

// =============================================================================
// ACTION DEFINITIONS
// =============================================================================
// 
// The LLM generates a plan consisting of these action types. Each action has:
// - A unique 'id' that can be referenced by subsequent actions
// - A 'description' shown to users during execution
// - Action-specific parameters
//
// IMPORTANT: Calculate and Compare actions can ONLY reference Fetch action IDs
// as their 'source'. This is validated before execution to prevent errors.
// =============================================================================

/**
 * FETCH ACTION
 * Retrieves game data from the RAWG API with various filters.
 * This is the only action that generates new data - all other actions
 * operate on data retrieved by fetch actions.
 */
interface FetchAction {
  action: 'fetch';
  id: string;                    // Unique identifier for this fetch result
  params: FetchGameDataInput;    // RAWG API query parameters
  description: string;           // Human-readable description
}

/**
 * CALCULATE ACTION
 * Performs a statistical operation on data from a previous fetch action.
 * The 'source' field MUST reference a fetch action's ID, not another calculate action.
 */
interface CalculateAction {
  action: 'calculate';
  id: string;                                                  // Unique identifier for this result
  operation: 'average' | 'sum' | 'count' | 'min' | 'max';      // Statistical operation
  source: string;                                              // ID of the fetch action to get data from
  field: 'metacritic' | 'rating' | 'ratings_count';            // Which game field to extract
  description: string;                                         // Human-readable description
}

/**
 * COMPARE ACTION
 * Compares metrics across multiple groups of data.
 * Each group references a fetch action and specifies which field to compare.
 * Returns averages for each group and identifies the "winner" (highest value).
 */
interface CompareAction {
  action: 'compare';
  id: string;
  groups: { 
    name: string;                                    // Display name for this group
    source: string;                                  // ID of the fetch action
    field: 'metacritic' | 'rating' | 'count';        // Field to compare (count uses total results)
  }[];
  description: string;
}

/**
 * Union type of all possible plan actions.
 */
type PlanAction = FetchAction | CalculateAction | CompareAction;

/**
 * The complete execution plan generated by the LLM.
 * Contains reasoning (for transparency) and an ordered list of actions.
 */
interface ExecutionPlan {
  reasoning: string;      // LLM's explanation of the approach
  actions: PlanAction[];  // Ordered list of actions to execute
}

// =============================================================================
// SYSTEM PROMPT
// =============================================================================
// 
// This is the "brain" of the agent - a carefully crafted prompt that teaches
// the LLM how to generate valid execution plans. Key components:
// 
// 1. ROLE DEFINITION     - Establishes the agent's identity and capabilities
// 2. AVAILABLE RESOURCES - Lists platforms, genres the agent knows about
// 3. PLAN FORMAT         - Specifies the exact JSON structure required
// 4. ACTION SCHEMAS      - Detailed specs for each action type
// 5. EXAMPLES            - Concrete examples showing how to handle common queries
// 6. RULES               - Critical constraints (e.g., source references)
//
// The prompt is injected with actual platform/genre lists from the RAWG tool
// to keep the LLM informed about valid filter values.
// =============================================================================

const SYSTEM_PROMPT = `You are a video game data analyst. You answer questions by creating a structured execution plan.

## Available Data Sources

**Platforms**: ${Object.keys(PLATFORMS).join(', ')}
**Genres**: ${Object.keys(GENRES).join(', ')}

## Plan Format

You MUST respond with ONLY a valid JSON object (no markdown, no explanation outside JSON):

{
  "reasoning": "Brief explanation of your approach",
  "actions": [
    // Array of actions to execute - DO NOT include an "answer" action
  ]
}

## Action Types

### 1. Fetch Action - Get games from RAWG API
{
  "action": "fetch",
  "id": "unique_id",
  "params": {
    "platforms": ["pc"],           // Optional: platform names
    "genres": ["action"],          // Optional: genre names  
    "date_from": "2024-01-01",     // Optional: YYYY-MM-DD
    "date_to": "2024-03-31",       // Optional: YYYY-MM-DD
    "metacritic_min": 1,           // Optional: filter games with scores
    "ordering": "-metacritic",     // Optional: sort order
    "page_size": 40,               // Optional: max 40
    "search": "mario",             // Optional: search query for game names
    "search_exact": false,         // Optional: true for exact matches only
    "developers": "nintendo",      // Optional: filter by developer slug
    "publishers": "nintendo",      // Optional: filter by publisher slug
    "exclude_additions": true      // Optional: exclude DLCs/editions, count only base games
  },
  "description": "Fetching PC games from Q1 2024"
}

## IMPORTANT: How Search Works

The API returns a "count" field showing the TOTAL number of matching games in the database, not just the games returned on the current page. When someone asks "how many X games are there", the "count" from the fetch result gives you the answer directly!

### Search Strategies for Finding Specific Games/Franchises:

1. **For game franchises (e.g., "Super Mario", "Zelda", "Final Fantasy")**:
   - Use simple, core search terms: "mario", "zelda", "final fantasy"
   - AVOID full titles like "Super Mario Bros" - use just "mario"
   - Consider using "exclude_additions": true to count only base games (not DLCs)
   
2. **For specific games**:
   - Use "search_exact": true for precise matching
   - Use the exact game title
   
3. **Combine with filters for better results**:
   - Add platform filters if asking about specific console games
   - Add developer/publisher filters for franchise questions (e.g., "nintendo" for Mario)

### 2. Calculate Action - Compute statistics
{
  "action": "calculate",
  "id": "calc_id",
  "operation": "average",          // average, sum, count, min, max
  "source": "fetch_id",            // MUST be the ID of a FETCH action (not a calculate action)
  "field": "metacritic",           // metacritic, rating, or ratings_count
  "description": "Calculating average metacritic"
}

### 3. Compare Action - Compare multiple groups
{
  "action": "compare",
  "id": "compare_id",
  "groups": [
    { "name": "PlayStation 5", "source": "ps5_fetch", "field": "metacritic" },
    { "name": "Xbox Series", "source": "xbox_fetch", "field": "count" }
  ],
  "description": "Comparing PS5 score vs Xbox game count"
}
// Note: Each group's "source" MUST be the ID of a FETCH action (not a calculate action)
// Supported fields: "metacritic", "rating", "count" (use "count" to compare total number of games found)

## Date Ranges
- Q1 = 01-01 to 03-31
- Q2 = 04-01 to 06-30
- Q3 = 07-01 to 09-30
- Q4 = 10-01 to 12-31

## Examples

### Example 1: Simple average calculation
User: "What's the average Metacritic score for PC games in Q1 2024?"

{
  "reasoning": "I need to fetch PC games from Q1 2024 with metacritic scores, then calculate the average.",
  "actions": [
    {
      "action": "fetch",
      "id": "pc_games",
      "params": {
        "platforms": ["pc"],
        "date_from": "2024-01-01",
        "date_to": "2024-03-31",
        "metacritic_min": 1,
        "ordering": "-metacritic",
        "page_size": 40
      },
      "description": "Fetching PC games from Q1 2024 with metacritic scores"
    },
    {
      "action": "calculate",
      "id": "avg_score",
      "operation": "average",
      "source": "pc_games",
      "field": "metacritic",
      "description": "Calculating average metacritic score"
    }
  ]
}

### Example 2: Comparing multiple groups (e.g., genres or platforms)
User: "Which genre had the highest rated games in 2023?"

{
  "reasoning": "I need to fetch games from multiple genres in 2023, then compare their ratings using a compare action. Each genre needs its own fetch action.",
  "actions": [
    {
      "action": "fetch",
      "id": "action_2023",
      "params": {
        "genres": ["action"],
        "date_from": "2023-01-01",
        "date_to": "2023-12-31",
        "metacritic_min": 1,
        "page_size": 40
      },
      "description": "Fetching Action games from 2023"
    },
    {
      "action": "fetch",
      "id": "rpg_2023",
      "params": {
        "genres": ["rpg"],
        "date_from": "2023-01-01",
        "date_to": "2023-12-31",
        "metacritic_min": 1,
        "page_size": 40
      },
      "description": "Fetching RPG games from 2023"
    },
    {
      "action": "fetch",
      "id": "indie_2023",
      "params": {
        "genres": ["indie"],
        "date_from": "2023-01-01",
        "date_to": "2023-12-31",
        "metacritic_min": 1,
        "page_size": 40
      },
      "description": "Fetching Indie games from 2023"
    },
    {
      "action": "compare",
      "id": "genre_comparison",
      "groups": [
        { "name": "Action", "source": "action_2023", "field": "rating" },
        { "name": "RPG", "source": "rpg_2023", "field": "rating" },
        { "name": "Indie", "source": "indie_2023", "field": "rating" }
      ],
      "description": "Comparing average ratings across genres"
    }
  ]
}

### Example 3: Counting games in a franchise
User: "How many Super Mario games are there?"

{
  "reasoning": "I need to search for Mario games. I'll use a simple search term 'mario' (not 'Super Mario') for better results, and exclude DLC/additions to count only base games. The API's 'count' field will tell me the total number.",
  "actions": [
    {
      "action": "fetch",
      "id": "mario_games",
      "params": {
        "search": "mario",
        "exclude_additions": true,
        "page_size": 40,
        "ordering": "-rating"
      },
      "description": "Searching for all Mario games (excluding DLCs)"
    }
  ]
}

### Example 4: Finding a specific game
User: "What is the Metacritic score for Elden Ring?"

{
  "reasoning": "I need to search for the specific game 'Elden Ring' using an exact search to get precise results.",
  "actions": [
    {
      "action": "fetch",
      "id": "elden_ring",
      "params": {
        "search": "Elden Ring",
        "search_exact": true,
        "page_size": 5
      },
      "description": "Searching for Elden Ring"
    }
  ]
}

### Example 5: Games by a specific developer/publisher
User: "How many games has Nintendo published?"

{
  "reasoning": "I'll search for games with Nintendo as publisher. The 'count' field will give me the total.",
  "actions": [
    {
      "action": "fetch",
      "id": "nintendo_games",
      "params": {
        "publishers": "nintendo",
        "exclude_additions": true,
        "page_size": 40,
        "ordering": "-rating"
      },
      "description": "Fetching games published by Nintendo"
    }
  ]
}

### Example 6: Combining search with platform filter
User: "How many Zelda games are on Nintendo Switch?"

{
  "reasoning": "I'll search for 'zelda' and filter by Nintendo Switch platform to find Zelda games available on Switch.",
  "actions": [
    {
      "action": "fetch",
      "id": "zelda_switch",
      "params": {
        "search": "zelda",
        "platforms": ["switch"],
        "exclude_additions": true,
        "page_size": 40
      },
      "description": "Searching for Zelda games on Nintendo Switch"
    }
  ]
}

## Important Rules
- Calculate and Compare actions can ONLY use fetch action IDs as their source
- Never use a calculate action's ID as a source for another action
- Each group you want to compare needs its own separate fetch action

Now respond to the user's question with ONLY a JSON plan. Do NOT include an "answer" action - I will ask you to write the answer separately after the plan is executed.`;

// =============================================================================
// STREAMING INFRASTRUCTURE
// =============================================================================

/**
 * Callback function type for streaming events to the client.
 * Used by runAgentStreaming() to send real-time updates via Server-Sent Events.
 * 
 * Event types:
 * - 'step'   - A processing step occurred (planning, fetching, calculating, etc.)
 * - 'answer' - The final answer is ready, includes calculation widgets
 * - 'error'  - An error occurred during processing
 */
export type StreamCallback = (event: {
  type: 'step' | 'answer' | 'error';
  data: any;
}) => Promise<void>;

// =============================================================================
// LLM RESPONSE PARSING
// =============================================================================

/**
 * Extracts a JSON execution plan from the LLM's response.
 * 
 * LLMs sometimes wrap JSON in markdown code blocks or include extra text,
 * so we try multiple extraction strategies:
 * 
 * 1. Direct JSON.parse() - Works when response is pure JSON
 * 2. Extract from ```json ... ``` code blocks - Common LLM behavior
 * 3. Find any JSON object in the response - Fallback for mixed responses
 * 
 * @param response - Raw text response from the LLM
 * @returns Parsed ExecutionPlan or null if extraction fails
 */
function parseJsonResponse(response: string): ExecutionPlan | null {
  // Strategy 1: Try to parse the response directly as JSON
  try {
    return JSON.parse(response);
  } catch {
    // Strategy 2: Extract JSON from markdown code block (```json ... ```)
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        return null;
      }
    }
    
    // Strategy 3: Find any JSON object pattern in the response
    const objectMatch = response.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// =============================================================================
// PLAN VALIDATION
// =============================================================================

/**
 * Validates the execution plan before running it.
 * 
 * This is a critical safety check that catches common LLM mistakes:
 * 
 * 1. Missing or malformed actions array
 * 2. Calculate/Compare actions referencing non-existent fetch actions
 * 3. Calculate actions trying to use other calculate action IDs as sources
 * 
 * The validation uses a two-pass approach:
 * - First pass: Collect all fetch action IDs
 * - Second pass: Verify all source references point to valid fetch IDs
 * 
 * Why is this needed? LLMs sometimes hallucinate action IDs or try to chain
 * calculate actions together (which isn't supported). This catches those
 * errors early with helpful messages.
 * 
 * @param plan - The execution plan to validate
 * @returns Object with 'valid' boolean and array of error messages
 */
function validatePlan(plan: ExecutionPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Basic structure check - plan must have an actions array
  if (!plan || !plan.actions || !Array.isArray(plan.actions)) {
    return {
      valid: false,
      errors: ['Plan must contain an "actions" array']
    };
  }

  // FIRST PASS: Build a set of all valid fetch action IDs
  // These are the only valid sources for calculate/compare actions
  const fetchActionIds = new Set<string>();
  
  for (const action of plan.actions) {
    if (action.action === 'fetch') {
      fetchActionIds.add(action.id);
    }
  }
  
  // SECOND PASS: Validate that all source references are valid
  for (const action of plan.actions) {
    if (action.action === 'calculate') {
      // Calculate actions must reference a fetch action as their source
      if (!fetchActionIds.has(action.source)) {
        errors.push(
          `Calculate action "${action.id}" has invalid source "${action.source}". ` +
          `The source must be the ID of a fetch action. Available fetch actions: ${Array.from(fetchActionIds).join(', ')}`
        );
      }
    } else if (action.action === 'compare') {
      // Each group in a compare action must reference a valid fetch action
      for (const group of action.groups) {
        if (!fetchActionIds.has(group.source)) {
          errors.push(
            `Compare action "${action.id}" group "${group.name}" has invalid source "${group.source}". ` +
            `The source must be the ID of a fetch action. Available fetch actions: ${Array.from(fetchActionIds).join(', ')}`
          );
        }
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// =============================================================================
// RESULT FORMATTING FOR LLM
// =============================================================================

/**
 * Formats execution results into a structured summary for the LLM.
 * 
 * This creates a markdown-formatted document that the LLM uses to:
 * 1. Understand what data was retrieved
 * 2. See calculation/comparison results
 * 3. Generate a natural language answer
 * 
 * The formatting is optimized for LLM comprehension:
 * - Clear section headers for each action
 * - Emphasis on key numbers (bold for important values)
 * - Sample data to provide context
 * - Special handling for counting questions (emphasizes total count)
 * 
 * @param userQuery - The original user question
 * @param results - Map of action IDs to their execution results
 * @param plan - The execution plan that was run
 * @returns Formatted markdown string for LLM consumption
 */
function formatResultsForLLM(
  userQuery: string,
  results: Record<string, any>,
  plan: ExecutionPlan
): string {
  let summary = `## Original Question\n${userQuery}\n\n## Execution Results\n\n`;
  
  // Detect counting questions to emphasize the total count in results
  // This helps the LLM understand that the 'count' field is the answer
  const isCountingQuestion = /how many|count|number of|total/i.test(userQuery);
  
  // Format each action's results in sequence
  for (const action of plan.actions) {
    const result = results[action.id];
    
    switch (action.action) {
      case 'fetch':
        summary += `### ${action.description}\n`;
        // For counting questions, emphasize that the count is the total in the database
        // (not just the number of results returned on this page)
        if (isCountingQuestion) {
          summary += `- **TOTAL MATCHING GAMES IN DATABASE: ${result.count}** (This is the answer to "how many")\n`;
        } else {
          summary += `- Total games found: ${result.count}\n`;
        }
        summary += `- Games retrieved on this page: ${result.returned}\n`;
        if (result.query_params) {
          summary += `- Search parameters used: ${JSON.stringify(result.query_params)}\n`;
        }
        // Include a sample of games for context
        if (result.games && result.games.length > 0) {
          summary += `- Sample of matching games:\n`;
          result.games.slice(0, 10).forEach((g: any) => {
            summary += `  - ${g.name} (Metacritic: ${g.metacritic ?? 'N/A'}, Rating: ${g.rating}, Released: ${g.released})\n`;
          });
          if (result.count > 10) {
            summary += `  - ... and ${result.count - 10} more games\n`;
          }
        }
        summary += '\n';
        break;
        
      case 'calculate':
        summary += `### ${action.description}\n`;
        summary += `- Operation: ${action.operation}\n`;
        summary += `- Field: ${action.field}\n`;
        summary += `- Result: **${result}**\n\n`;
        break;
        
      case 'compare':
        summary += `### ${action.description}\n`;
        summary += `- Results by group:\n`;
        if (typeof result === 'object') {
          Object.entries(result).forEach(([group, avg]) => {
            summary += `  - ${group}: **${avg}**\n`;
          });
        }
        summary += '\n';
        break;
    }
  }
  
  return summary;
}

// =============================================================================
// PLAN EXECUTION ENGINE
// =============================================================================

/**
 * Executes all actions in the plan sequentially.
 * 
 * This is the core of the Plan-First pattern - we run all actions without
 * consulting the LLM between steps. Each action's result is stored in a
 * results map, keyed by the action's ID.
 * 
 * For each action type:
 * - FETCH: Calls RAWG API, stores games array + metadata
 * - CALCULATE: Runs statistical operation on fetch results
 * - COMPARE: Compares metrics across multiple fetch results
 * 
 * Widget Data:
 * In addition to the raw results, we also create "_widget" entries containing
 * formatted data for the frontend's interactive displays. These include:
 * - Calculation breakdowns with formula and input values
 * - Game data tables for user inspection
 * 
 * @param plan - The validated execution plan
 * @param rawgApiKey - API key for RAWG service
 * @param onStep - Callback to report progress (for streaming)
 * @returns Map of action IDs to their results
 */
async function executePlan(
  plan: ExecutionPlan,
  rawgApiKey: string,
  onStep: (step: Step) => Promise<void>
): Promise<Record<string, any>> {
  // Results map: action.id -> result data
  // Also stores action.id + "_widget" -> frontend display data
  const results: Record<string, any> = {};
  
  // Process each action in order
  // Note: Actions are executed sequentially because later actions may depend
  // on earlier fetch results (e.g., calculate depends on a prior fetch)
  for (const action of plan.actions) {
    switch (action.action) {
      // =========================================
      // FETCH ACTION - Retrieve games from RAWG
      // =========================================
      case 'fetch': {
        // Notify frontend that we're starting a fetch
        await onStep({
          id: generateStepId(),
          type: 'tool_call',
          name: 'Fetching Game Data',
          summary: action.description,
          details: { params: action.params },
          timestamp: Date.now()
        });
        
        // Call the RAWG API tool
        const fetchResult = await fetchGameData(action.params, rawgApiKey);
        
        // Store the raw result for use by subsequent actions
        // Note: 'count' is the TOTAL matches in the database, 'games' is this page
        results[action.id] = {
          games: fetchResult.games,
          count: fetchResult.count,
          returned: fetchResult.games.length,
          query_params: fetchResult.query_params
        };
        
        // Store widget data for the frontend's interactive data tables
        // This is separate from the raw result to include display-specific formatting
        results[`${action.id}_widget`] = {
          type: 'data',
          description: action.description,
          total_count: fetchResult.count,
          returned_count: fetchResult.games.length,
          query_params: fetchResult.query_params,
          games_data: fetchResult.games.map((g: Game) => ({
            name: g.name,
            metacritic: g.metacritic,
            rating: g.rating,
            ratings_count: g.ratings_count,
            released: g.released
          }))
        };
        
        // Notify frontend of successful fetch with summary
        await onStep({
          id: generateStepId(),
          type: 'tool_result',
          name: 'Data Retrieved',
          summary: `Found ${fetchResult.count} total matching games in database`,
          details: {
            count: fetchResult.count,
            returned: fetchResult.games.length,
            query_params: fetchResult.query_params,
            sample: fetchResult.games.slice(0, 8).map(g => ({
              name: g.name,
              metacritic: g.metacritic,
              rating: g.rating,
              released: g.released
            }))
          },
          timestamp: Date.now()
        });
        break;
      }
      
      // =========================================
      // CALCULATE ACTION - Statistical operations
      // =========================================
      case 'calculate': {
        // Notify frontend that we're starting a calculation
        await onStep({
          id: generateStepId(),
          type: 'tool_call',
          name: 'Running Calculation',
          summary: action.description,
          details: { operation: action.operation, field: action.field, source: action.source },
          timestamp: Date.now()
        });
        
        // Look up the source fetch result
        // This should have been validated, but we check again for safety
        const sourceData = results[action.source];
        if (!sourceData || !sourceData.games) {
          const availableSources = Object.keys(results).filter(k => !k.endsWith('_widget'));
          throw new Error(
            `Source data "${action.source}" not found or invalid. ` +
            `Calculate actions must reference a fetch action ID. ` +
            `Available sources: ${availableSources.join(', ') || 'none'}`
          );
        }
        
        // Extract the numeric values from the games array
        // e.g., get all 'metacritic' scores or all 'rating' values
        const numbers = extractField(sourceData.games, action.field);
        
        // Execute the statistical operation
        const calcInput: CalculationInput = {
          operation: action.operation,
          data: numbers
        };
        const calcResult = executeCalculation(calcInput);
        
        // Store the raw result (just the number)
        results[action.id] = calcResult.result;
        
        // Store widget data for the frontend's calculation breakdown display
        // Includes the formula, input values, and source games for transparency
        results[`${action.id}_widget`] = {
          type: 'calculation',
          operation: action.operation,
          field: action.field,
          result: calcResult.result,
          formula: calcResult.formula,
          explanation: calcResult.details,
          input_values: numbers,
          games_data: sourceData.games.map((g: Game) => ({
            name: g.name,
            [action.field]: g[action.field as keyof Game],
            metacritic: g.metacritic,
            rating: g.rating,
            released: g.released
          }))
        };
        
        // Notify frontend of successful calculation
        await onStep({
          id: generateStepId(),
          type: 'tool_result',
          name: 'Calculation Complete',
          summary: `${action.operation} of ${action.field}: ${calcResult.result}`,
          details: {
            result: calcResult.result,
            formula: calcResult.formula,
            explanation: calcResult.details,
            input_count: numbers.length,
            widget_id: `${action.id}_widget`
          },
          timestamp: Date.now()
        });
        break;
      }
      
      // =========================================
      // COMPARE ACTION - Multi-group comparison
      // =========================================
      case 'compare': {
        // Notify frontend that we're starting a comparison
        await onStep({
          id: generateStepId(),
          type: 'tool_call',
          name: 'Comparing Groups',
          summary: action.description,
          details: { groups: action.groups.map(g => g.name) },
          timestamp: Date.now()
        });
        
        // Build data structures for comparison
        // groupData: maps group name -> array of numeric values
        // groupGames: maps group name -> array of game objects (for widgets)
        const groupData: Record<string, number[]> = {};
        const groupGames: Record<string, any[]> = {};
        
        for (const group of action.groups) {
          // Look up the source fetch result for this group
          const sourceData = results[group.source];
          if (!sourceData || !sourceData.games) {
            const availableSources = Object.keys(results).filter(k => !k.endsWith('_widget'));
            throw new Error(
              `Source data "${group.source}" for group "${group.name}" not found or invalid. ` +
              `Compare action groups must reference fetch action IDs. ` +
              `Available sources: ${availableSources.join(', ') || 'none'}`
            );
          }
          
          // Handle 'count' field specially - it uses the total database count,
          // not a field from individual games
          if (group.field === 'count') {
            // Use the total count from the API response (how many games match)
            groupData[group.name] = [sourceData.count];
          } else {
            // Extract the field values from all games
            groupData[group.name] = extractField(sourceData.games, group.field);
          }
          
          // Store game data for the frontend widget
          groupGames[group.name] = sourceData.games.map((g: Game) => ({
            name: g.name,
            [group.field]: g[group.field as keyof Game],
            metacritic: g.metacritic,
            rating: g.rating,
            released: g.released
          }));
        }
        
        // Execute the comparison (calculates averages, finds winner)
        const compareInput: CalculationInput = {
          operation: 'compare',
          data: groupData
        };
        const compareResult = executeCalculation(compareInput);
        
        // Store the raw result (averages per group)
        results[action.id] = compareResult.result;
        
        // Store widget data for the frontend's comparison display
        results[`${action.id}_widget`] = {
          type: 'comparison',
          groups: Object.keys(groupData),
          result: compareResult.result,
          formula: compareResult.formula,
          explanation: compareResult.details,
          group_values: groupData,
          group_games: groupGames
        };
        
        // Notify frontend of successful comparison
        await onStep({
          id: generateStepId(),
          type: 'tool_result',
          name: 'Comparison Complete',
          summary: compareResult.details,
          details: {
            result: compareResult.result,
            formula: compareResult.formula,
            explanation: compareResult.details,
            widget_id: `${action.id}_widget`
          },
          timestamp: Date.now()
        });
        break;
      }
    }
  }
  
  return results;
}

// =============================================================================
// RESULT REVIEW PHASE
// =============================================================================

/**
 * Response from the review LLM call.
 * If results are unsatisfactory, may include a new plan to try.
 */
interface ReviewResult {
  satisfactory: boolean;     // Are the results good enough to answer?
  reasoning: string;         // Explanation of the assessment
  new_plan?: ExecutionPlan;  // Optional: A revised plan if results are bad
}

/**
 * Reviews execution results and potentially generates a new plan.
 * 
 * This is the "adaptability" mechanism in our Plan-First architecture.
 * While we don't consult the LLM between individual tool calls, we do
 * ask it to review the overall results before generating an answer.
 * 
 * Common reasons for revision:
 * - 0 games found (search too restrictive)
 * - Missing Metacritic data (should switch to 'rating' field)
 * - Date range too narrow (should widen it)
 * 
 * The LLM can suggest a new plan which will be validated and executed,
 * replacing the original results.
 * 
 * @param genAI - Google Generative AI instance
 * @param userQuery - Original user question
 * @param results - Execution results from the first plan
 * @param plan - The plan that was executed
 * @returns ReviewResult with satisfactory flag and optional new plan
 */
async function reviewExecutionResults(
  genAI: GoogleGenerativeAI,
  userQuery: string,
  results: Record<string, any>,
  plan: ExecutionPlan
): Promise<ReviewResult> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.1,  // Low temperature for consistent evaluation
      responseMimeType: 'application/json'
    }
  });

  // Format the results for the LLM to review
  const resultsSummary = formatResultsForLLM(userQuery, results, plan);

  const prompt = `You are a video game data analyst reviewing the results of a data fetch.

## Execution Results
${resultsSummary}

## Task
Review the results above.
1. Are the results satisfactory for answering the user's question: "${userQuery}"?
2. If NO (e.g., 0 games found, missing data), create a NEW plan to try a different approach (e.g., use 'rating' instead of 'metacritic', widen date range, remove specific filters).
3. If YES, confirm that we can proceed to answering.

## Response Format
Return ONLY a valid JSON object:
{
  "satisfactory": boolean,
  "reasoning": "Explanation of why results are good or bad",
  "new_plan": { ... } // Optional: A new valid ExecutionPlan if satisfactory is false. MUST follow the same plan format as the original plan.
}
`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();
  
  // Parse the review response (with same fallback strategies as plan parsing)
  try {
    return JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        // Fallback to next strategy
      }
    }
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        // Fallback to default
      }
    }
    // If parsing fails entirely, assume results are okay and proceed
    return { satisfactory: true, reasoning: "Failed to parse review response, proceeding with current results." };
  }
}

// =============================================================================
// ANSWER GENERATION
// =============================================================================

/**
 * Generates a natural language answer from the execution results.
 * 
 * This is the final LLM call in the pipeline. It takes the structured
 * execution results and produces a human-friendly response.
 * 
 * Key formatting instructions for the LLM:
 * - Use bold for important numbers
 * - Be conversational but informative
 * - Handle edge cases (0 results, missing data) gracefully
 * - No JSON or technical details in the response
 * 
 * @param genAI - Google Generative AI instance
 * @param userQuery - Original user question
 * @param results - All execution results
 * @param plan - The executed plan
 * @returns Natural language answer string
 */
async function generateFinalAnswer(
  genAI: GoogleGenerativeAI,
  userQuery: string,
  results: Record<string, any>,
  plan: ExecutionPlan
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.3,  // Slightly higher for more natural, varied language
    }
  });
  
  // Prepare the context for answer generation
  const resultsSummary = formatResultsForLLM(userQuery, results, plan);
  
  const prompt = `Based on the following data analysis results, write a clear, helpful answer to the user's question.

${resultsSummary}

Instructions:
- Write a natural, conversational response
- Include the key numbers and findings
- Use **bold** for important values
- Be concise but informative
- If the data shows 0 results or no data, explain that clearly
- Do not include any JSON or technical details

Write your answer now:`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

// =============================================================================
// MAIN ORCHESTRATOR FUNCTIONS
// =============================================================================

/**
 * Main orchestrator function (non-streaming version).
 * 
 * This is the entry point for synchronous chat requests (POST /api/chat).
 * It executes the complete Plan-Execute-Review-Answer pipeline and returns
 * the final result with all processing steps.
 * 
 * Pipeline:
 * 1. Initialize Gemini with system prompt
 * 2. Generate execution plan from user query
 * 3. Validate plan structure and references
 * 4. Execute all actions sequentially
 * 5. Review results (may trigger re-planning)
 * 6. Generate natural language answer
 * 7. Return answer + all steps + widget data
 * 
 * @param userQuery - The user's question about video games
 * @param geminiApiKey - Google Gemini API key
 * @param rawgApiKey - RAWG API key for game data
 * @returns AgentResponse with answer and all processing steps
 */
export async function runAgent(
  userQuery: string,
  geminiApiKey: string,
  rawgApiKey: string
): Promise<AgentResponse> {
  // Collect all steps for the response
  const steps: Step[] = [];
  
  // Initialize Google Generative AI
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  
  // Configure the model for JSON output (plan generation)
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.1,            // Low temperature for consistent plan generation
      responseMimeType: 'application/json'  // Request JSON output
    }
  });

  // STEP 1: Record that we're analyzing the query
  steps.push({
    id: generateStepId(),
    type: 'thinking',
    name: 'Analyzing Query',
    summary: `Understanding: "${userQuery}"`,
    details: { query: userQuery },
    timestamp: Date.now()
  });

  try {
    // STEP 2: Start a chat with the system prompt pre-loaded
    // We use chat history to inject the system prompt as prior context
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
        { role: 'model', parts: [{ text: '{"acknowledged": true}' }] }
      ]
    });
    
    // Send the user query and get the plan
    const result = await chat.sendMessage(userQuery);
    const responseText = result.response.text();
    
    // STEP 3: Parse the plan from the LLM response
    let plan = parseJsonResponse(responseText);
    
    if (!plan || !plan.actions) {
      // Plan generation failed - couldn't extract valid JSON
      steps.push({
        id: generateStepId(),
        type: 'error',
        name: 'Plan Generation Failed',
        summary: 'Could not generate a valid execution plan',
        details: { raw_response: responseText },
        timestamp: Date.now()
      });
      
      return {
        answer: 'Sorry, I could not create a plan to answer your question. Please try rephrasing.',
        steps
      };
    }
    
    // Record the successful plan generation
    steps.push({
      id: generateStepId(),
      type: 'plan',
      name: 'Plan Created',
      summary: plan.reasoning,
      details: { plan },
      timestamp: Date.now()
    });
    
    // STEP 4: Validate the plan before execution
    // This catches invalid source references before we try to execute
    let validation = validatePlan(plan);
    if (!validation.valid) {
      steps.push({
        id: generateStepId(),
        type: 'error',
        name: 'Plan Validation Failed',
        summary: 'The generated plan has invalid source references',
        details: { errors: validation.errors },
        timestamp: Date.now()
      });
      
      return {
        answer: `Sorry, I created an invalid plan. The issue is:\n${validation.errors.join('\n')}`,
        steps
      };
    }
    
    // Step callback to collect execution steps
    const onStep = async (step: Step) => {
      steps.push(step);
    };
    
    // STEP 5: Execute the plan
    // This runs all fetch/calculate/compare actions sequentially
    let results = await executePlan(plan, rawgApiKey, onStep);

    // STEP 6: Review Phase
    // The LLM evaluates if results are good enough to answer the question
    steps.push({
      id: generateStepId(),
      type: 'thinking',
      name: 'Reviewing Results',
      summary: 'Checking if results are satisfactory...',
      details: {},
      timestamp: Date.now()
    });

    const review = await reviewExecutionResults(genAI, userQuery, results, plan);
    
    // Handle unsatisfactory results - may need to re-plan
    if (!review.satisfactory && review.new_plan) {
      steps.push({
        id: generateStepId(),
        type: 'review',
        name: 'Plan Revision Needed',
        summary: review.reasoning,
        details: { original_results_summary: Object.keys(results), review },
        timestamp: Date.now()
      });

      // Validate and execute the new plan if provided
      if (review.new_plan && review.new_plan.actions && Array.isArray(review.new_plan.actions)) {
        const newValidation = validatePlan(review.new_plan);
        if (newValidation.valid) {
          plan = review.new_plan;
          
          steps.push({
            id: generateStepId(),
            type: 'plan',
            name: 'New Plan Created',
            summary: plan.reasoning,
            details: { plan },
            timestamp: Date.now()
          });
          
          // Execute the revised plan
          results = await executePlan(plan, rawgApiKey, onStep);
        } else {
          // New plan was invalid - proceed with original results
          steps.push({
            id: generateStepId(),
            type: 'error',
            name: 'New Plan Invalid',
            summary: 'The revised plan was invalid, proceeding with original results.',
            details: { errors: newValidation.errors },
            timestamp: Date.now()
          });
        }
      } else {
        // New plan was missing required structure
        steps.push({
          id: generateStepId(),
          type: 'error',
          name: 'New Plan Missing Actions',
          summary: 'The revised plan was missing actions, proceeding with original results.',
          details: { review },
          timestamp: Date.now()
        });
      }
    } else {
      // Results are satisfactory - proceed to answer
      steps.push({
        id: generateStepId(),
        type: 'review',
        name: 'Results Satisfactory',
        summary: 'Proceeding to answer generation.',
        details: { review },
        timestamp: Date.now()
      });
    }
    
    // STEP 7: Generate final answer using LLM
    steps.push({
      id: generateStepId(),
      type: 'generating_answer',
      name: 'Generating Answer',
      summary: 'Analyzing results and writing response...',
      details: { results_summary: Object.keys(results) },
      timestamp: Date.now()
    });
    
    const answer = await generateFinalAnswer(genAI, userQuery, results, plan);
    
    // Collect all widget data from results for frontend display
    const widgets: any[] = [];
    for (const [key, value] of Object.entries(results)) {
      if (key.endsWith('_widget') && value) {
        widgets.push(value);
      }
    }
    
    // Record the final answer step
    steps.push({
      id: generateStepId(),
      type: 'answer',
      name: 'Final Answer',
      summary: answer.substring(0, 200) + (answer.length > 200 ? '...' : ''),
      details: { full_answer: answer, execution_results: results, calculation_widgets: widgets },
      timestamp: Date.now()
    });
    
    return { answer, steps };
    
  } catch (error: any) {
    // Handle any unexpected errors during the pipeline
    steps.push({
      id: generateStepId(),
      type: 'error',
      name: 'Error',
      summary: error.message,
      details: { error: error.message, stack: error.stack },
      timestamp: Date.now()
    });
    
    return {
      answer: `Sorry, an error occurred: ${error.message}`,
      steps
    };
  }
}

/**
 * Streaming version of the agent orchestrator.
 * 
 * This is the entry point for streaming chat requests (POST /api/chat/stream).
 * It executes the same Plan-Execute-Review-Answer pipeline as runAgent(), but
 * sends real-time updates via Server-Sent Events (SSE).
 * 
 * The streamCallback is called for each step, allowing the frontend to display
 * progress in real-time. This provides better UX for longer operations.
 * 
 * Event Flow:
 * 1. 'step' events for each processing stage
 * 2. 'answer' event with final response + widgets
 * 3. 'error' event if something goes wrong
 * 
 * @param userQuery - The user's question about video games
 * @param geminiApiKey - Google Gemini API key
 * @param rawgApiKey - RAWG API key for game data
 * @param streamCallback - Callback to send events to the client
 */
export async function runAgentStreaming(
  userQuery: string,
  geminiApiKey: string,
  rawgApiKey: string,
  streamCallback: StreamCallback
): Promise<void> {
  // Initialize Google Generative AI
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  
  // Configure the model for JSON output
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  });

  // Stream: Analyzing query
  await streamCallback({
    type: 'step',
    data: {
      id: generateStepId(),
      type: 'thinking',
      name: 'Analyzing Query',
      summary: `Understanding: "${userQuery}"`,
      details: { query: userQuery },
      timestamp: Date.now()
    }
  });

  try {
    await streamCallback({
      type: 'step',
      data: {
        id: generateStepId(),
        type: 'thinking',
        name: 'Creating Plan',
        summary: 'Determining what data to fetch and how to analyze it...',
        details: {},
        timestamp: Date.now()
      }
    });
    
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
        { role: 'model', parts: [{ text: '{"acknowledged": true}' }] }
      ]
    });
    
    const result = await chat.sendMessage(userQuery);
    const responseText = result.response.text();
    
    let plan = parseJsonResponse(responseText);
    
    if (!plan || !plan.actions) {
      await streamCallback({
        type: 'step',
        data: {
          id: generateStepId(),
          type: 'error',
          name: 'Plan Generation Failed',
          summary: 'Could not generate a valid execution plan',
          details: { raw_response: responseText },
          timestamp: Date.now()
        }
      });
      
      await streamCallback({
        type: 'answer',
        data: { answer: 'Sorry, I could not create a plan to answer your question. Please try rephrasing.' }
      });
      return;
    }
    
    await streamCallback({
      type: 'step',
      data: {
        id: generateStepId(),
        type: 'plan',
        name: 'Plan Created',
        summary: plan.reasoning,
        details: { plan },
        timestamp: Date.now()
      }
    });
    
    // Validate the plan before execution
    let validation = validatePlan(plan);
    if (!validation.valid) {
      await streamCallback({
        type: 'step',
        data: {
          id: generateStepId(),
          type: 'error',
          name: 'Plan Validation Failed',
          summary: 'The generated plan has invalid source references',
          details: { errors: validation.errors },
          timestamp: Date.now()
        }
      });
      
      await streamCallback({
        type: 'error',
        data: { error: `Sorry, I created an invalid plan. The issue is:\n${validation.errors.join('\n')}` }
      });
      return;
    }
    
    const onStep = async (step: Step) => {
      await streamCallback({ type: 'step', data: step });
    };
    
    // Execute the plan
    let results = await executePlan(plan, rawgApiKey, onStep);

    // Review Phase
    await streamCallback({
        type: 'step',
        data: {
          id: generateStepId(),
          type: 'thinking',
          name: 'Reviewing Results',
          summary: 'Checking if results are satisfactory...',
          details: {},
          timestamp: Date.now()
        }
    });

    const review = await reviewExecutionResults(genAI, userQuery, results, plan);
    
    if (!review.satisfactory && review.new_plan) {
      await streamCallback({
        type: 'step',
        data: {
          id: generateStepId(),
          type: 'review',
          name: 'Plan Revision Needed',
          summary: review.reasoning,
          details: { original_results_summary: Object.keys(results), review },
          timestamp: Date.now()
        }
      });

      // Validate new plan
      if (review.new_plan && review.new_plan.actions && Array.isArray(review.new_plan.actions)) {
        const newValidation = validatePlan(review.new_plan);
        if (newValidation.valid) {
          plan = review.new_plan;
          
          await streamCallback({
            type: 'step',
            data: {
              id: generateStepId(),
              type: 'plan',
              name: 'New Plan Created',
              summary: plan.reasoning,
              details: { plan },
              timestamp: Date.now()
            }
          });
          
          // Execute new plan
          results = await executePlan(plan, rawgApiKey, onStep);
        } else {
           await streamCallback({
              type: 'step',
              data: {
                id: generateStepId(),
                type: 'error',
                name: 'New Plan Invalid',
                summary: 'The revised plan was invalid, proceeding with original results.',
                details: { errors: newValidation.errors },
                timestamp: Date.now()
              }
            });
        }
      } else {
         await streamCallback({
            type: 'step',
            data: {
              id: generateStepId(),
              type: 'error',
              name: 'New Plan Missing Actions',
              summary: 'The revised plan was missing actions, proceeding with original results.',
              details: { review },
              timestamp: Date.now()
            }
          });
      }
    } else {
       await streamCallback({
          type: 'step',
          data: {
            id: generateStepId(),
            type: 'review',
            name: 'Results Satisfactory',
            summary: 'Proceeding to answer generation.',
            details: { review },
            timestamp: Date.now()
          }
        });
    }
    
    // Generate final answer using LLM
    await streamCallback({
      type: 'step',
      data: {
        id: generateStepId(),
        type: 'generating_answer',
        name: 'Generating Answer',
        summary: 'Analyzing results and writing response...',
        details: { results_summary: Object.keys(results) },
        timestamp: Date.now()
      }
    });
    
    const answer = await generateFinalAnswer(genAI, userQuery, results, plan);
    
    // Collect all widget data from results
    const widgets: any[] = [];
    for (const [key, value] of Object.entries(results)) {
      if (key.endsWith('_widget') && value) {
        widgets.push(value);
      }
    }
    
    await streamCallback({
      type: 'step',
      data: {
        id: generateStepId(),
        type: 'answer',
        name: 'Final Answer',
        summary: answer.substring(0, 200) + (answer.length > 200 ? '...' : ''),
        details: { full_answer: answer, execution_results: results, calculation_widgets: widgets },
        timestamp: Date.now()
      }
    });
    
    await streamCallback({
      type: 'answer',
      data: { answer, calculation_widgets: widgets }
    });
    
  } catch (error: any) {
    await streamCallback({
      type: 'step',
      data: {
        id: generateStepId(),
        type: 'error',
        name: 'Error',
        summary: error.message,
        details: { error: error.message, stack: error.stack },
        timestamp: Date.now()
      }
    });
    
    await streamCallback({
      type: 'error',
      data: { error: `Sorry, an error occurred: ${error.message}` }
    });
  }
}
