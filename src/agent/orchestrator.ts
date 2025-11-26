// Agent Orchestrator - "New MCP" Structured Plan Pattern
// The LLM outputs a structured JSON plan, which we execute step-by-step.
// After execution, the LLM generates a free-form answer based on the results.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { fetchGameData, FetchGameDataInput, PLATFORMS, GENRES, Game } from '../tools/rawg';
import { executeCalculation, CalculationInput, extractField } from '../tools/calculate';

// Step types for tracking the agent's work
export interface Step {
  id: string;
  type: 'thinking' | 'plan' | 'tool_call' | 'tool_result' | 'generating_answer' | 'answer' | 'error' | 'review';
  name: string;
  summary: string;
  details: any;
  timestamp: number;
}

export interface AgentResponse {
  answer: string;
  steps: Step[];
}

// Generate unique step ID
function generateStepId(): string {
  return Math.random().toString(36).substring(2, 9);
}

// Action types for the structured plan (no more 'answer' action)
interface FetchAction {
  action: 'fetch';
  id: string;
  params: FetchGameDataInput;
  description: string;
}

interface CalculateAction {
  action: 'calculate';
  id: string;
  operation: 'average' | 'sum' | 'count' | 'min' | 'max';
  source: string;  // ID of previous fetch action
  field: 'metacritic' | 'rating' | 'ratings_count';
  description: string;
}

interface CompareAction {
  action: 'compare';
  id: string;
  groups: { name: string; source: string; field: 'metacritic' | 'rating' | 'count' }[];
  description: string;
}

type PlanAction = FetchAction | CalculateAction | CompareAction;

interface ExecutionPlan {
  reasoning: string;
  actions: PlanAction[];
}

// System prompt for structured plan generation
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

// Streaming event callback type
export type StreamCallback = (event: {
  type: 'step' | 'answer' | 'error';
  data: any;
}) => Promise<void>;

// Parse LLM response to extract JSON
function parseJsonResponse(response: string): ExecutionPlan | null {
  // Try to parse directly
  try {
    return JSON.parse(response);
  } catch {
    // Try to extract JSON from markdown code block
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        return null;
      }
    }
    
    // Try to find JSON object in the response
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

// Validate the execution plan before running it
function validatePlan(plan: ExecutionPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check if plan and actions exist
  if (!plan || !plan.actions || !Array.isArray(plan.actions)) {
    return {
      valid: false,
      errors: ['Plan must contain an "actions" array']
    };
  }

  const fetchActionIds = new Set<string>();
  
  // First pass: collect all fetch action IDs
  for (const action of plan.actions) {
    if (action.action === 'fetch') {
      fetchActionIds.add(action.id);
    }
  }
  
  // Second pass: validate calculate and compare actions
  for (const action of plan.actions) {
    if (action.action === 'calculate') {
      // Check if source references a fetch action
      if (!fetchActionIds.has(action.source)) {
        errors.push(
          `Calculate action "${action.id}" has invalid source "${action.source}". ` +
          `The source must be the ID of a fetch action. Available fetch actions: ${Array.from(fetchActionIds).join(', ')}`
        );
      }
    } else if (action.action === 'compare') {
      // Check if all group sources reference fetch actions
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

// Format results for the LLM to generate an answer
function formatResultsForLLM(
  userQuery: string,
  results: Record<string, any>,
  plan: ExecutionPlan
): string {
  let summary = `## Original Question\n${userQuery}\n\n## Execution Results\n\n`;
  
  // Check if this is a counting question
  const isCountingQuestion = /how many|count|number of|total/i.test(userQuery);
  
  for (const action of plan.actions) {
    const result = results[action.id];
    
    switch (action.action) {
      case 'fetch':
        summary += `### ${action.description}\n`;
        // Emphasize total count for counting questions
        if (isCountingQuestion) {
          summary += `- **TOTAL MATCHING GAMES IN DATABASE: ${result.count}** (This is the answer to "how many")\n`;
        } else {
          summary += `- Total games found: ${result.count}\n`;
        }
        summary += `- Games retrieved on this page: ${result.returned}\n`;
        if (result.query_params) {
          summary += `- Search parameters used: ${JSON.stringify(result.query_params)}\n`;
        }
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

// Execute the plan (no longer handles 'answer' action)
async function executePlan(
  plan: ExecutionPlan,
  rawgApiKey: string,
  onStep: (step: Step) => Promise<void>
): Promise<Record<string, any>> {
  const results: Record<string, any> = {};
  
  for (const action of plan.actions) {
    switch (action.action) {
      case 'fetch': {
        await onStep({
          id: generateStepId(),
          type: 'tool_call',
          name: 'Fetching Game Data',
          summary: action.description,
          details: { params: action.params },
          timestamp: Date.now()
        });
        
        const fetchResult = await fetchGameData(action.params, rawgApiKey);
        results[action.id] = {
          games: fetchResult.games,
          count: fetchResult.count,
          returned: fetchResult.games.length,
          query_params: fetchResult.query_params
        };
        
        // Store data widget for the frontend (allows users to inspect fetched data)
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
      
      case 'calculate': {
        await onStep({
          id: generateStepId(),
          type: 'tool_call',
          name: 'Running Calculation',
          summary: action.description,
          details: { operation: action.operation, field: action.field, source: action.source },
          timestamp: Date.now()
        });
        
        const sourceData = results[action.source];
        if (!sourceData || !sourceData.games) {
          const availableSources = Object.keys(results).filter(k => !k.endsWith('_widget'));
          throw new Error(
            `Source data "${action.source}" not found or invalid. ` +
            `Calculate actions must reference a fetch action ID. ` +
            `Available sources: ${availableSources.join(', ') || 'none'}`
          );
        }
        
        const numbers = extractField(sourceData.games, action.field);
        const calcInput: CalculationInput = {
          operation: action.operation,
          data: numbers
        };
        const calcResult = executeCalculation(calcInput);
        results[action.id] = calcResult.result;
        
        // Store calculation widget data for the frontend
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
      
      case 'compare': {
        await onStep({
          id: generateStepId(),
          type: 'tool_call',
          name: 'Comparing Groups',
          summary: action.description,
          details: { groups: action.groups.map(g => g.name) },
          timestamp: Date.now()
        });
        
        const groupData: Record<string, number[]> = {};
        const groupGames: Record<string, any[]> = {};
        for (const group of action.groups) {
          const sourceData = results[group.source];
          if (!sourceData || !sourceData.games) {
            const availableSources = Object.keys(results).filter(k => !k.endsWith('_widget'));
            throw new Error(
              `Source data "${group.source}" for group "${group.name}" not found or invalid. ` +
              `Compare action groups must reference fetch action IDs. ` +
              `Available sources: ${availableSources.join(', ') || 'none'}`
            );
          }
          if (group.field === 'count') {
            // Special handling for counting total results
            groupData[group.name] = [sourceData.count];
          } else {
            groupData[group.name] = extractField(sourceData.games, group.field);
          }
          groupGames[group.name] = sourceData.games.map((g: Game) => ({
            name: g.name,
            [group.field]: g[group.field as keyof Game],
            metacritic: g.metacritic,
            rating: g.rating,
            released: g.released
          }));
        }
        
        const compareInput: CalculationInput = {
          operation: 'compare',
          data: groupData
        };
        const compareResult = executeCalculation(compareInput);
        results[action.id] = compareResult.result;
        
        // Store comparison widget data for the frontend
        results[`${action.id}_widget`] = {
          type: 'comparison',
          groups: Object.keys(groupData),
          result: compareResult.result,
          formula: compareResult.formula,
          explanation: compareResult.details,
          group_values: groupData,
          group_games: groupGames
        };
        
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

// Review response interface
interface ReviewResult {
  satisfactory: boolean;
  reasoning: string;
  new_plan?: ExecutionPlan;
}

// Review execution results and potentially generate a new plan
async function reviewExecutionResults(
  genAI: GoogleGenerativeAI,
  userQuery: string,
  results: Record<string, any>,
  plan: ExecutionPlan
): Promise<ReviewResult> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  });

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
  
  try {
    return JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        // Fallback
      }
    }
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        // Fallback
      }
    }
    return { satisfactory: true, reasoning: "Failed to parse review response, proceeding with current results." };
  }
}

// Generate final answer using LLM
async function generateFinalAnswer(
  genAI: GoogleGenerativeAI,
  userQuery: string,
  results: Record<string, any>,
  plan: ExecutionPlan
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.3, // Slightly higher for more natural language
    }
  });
  
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

// Main orchestrator function (non-streaming)
export async function runAgent(
  userQuery: string,
  geminiApiKey: string,
  rawgApiKey: string
): Promise<AgentResponse> {
  const steps: Step[] = [];
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  });

  steps.push({
    id: generateStepId(),
    type: 'thinking',
    name: 'Analyzing Query',
    summary: `Understanding: "${userQuery}"`,
    details: { query: userQuery },
    timestamp: Date.now()
  });

  try {
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
    
    steps.push({
      id: generateStepId(),
      type: 'plan',
      name: 'Plan Created',
      summary: plan.reasoning,
      details: { plan },
      timestamp: Date.now()
    });
    
    // Validate the plan before execution
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
    
    const onStep = async (step: Step) => {
      steps.push(step);
    };
    
    // Execute the plan
    let results = await executePlan(plan, rawgApiKey, onStep);

    // Review Phase
    steps.push({
      id: generateStepId(),
      type: 'thinking',
      name: 'Reviewing Results',
      summary: 'Checking if results are satisfactory...',
      details: {},
      timestamp: Date.now()
    });

    const review = await reviewExecutionResults(genAI, userQuery, results, plan);
    
    if (!review.satisfactory && review.new_plan) {
      steps.push({
        id: generateStepId(),
        type: 'review',
        name: 'Plan Revision Needed',
        summary: review.reasoning,
        details: { original_results_summary: Object.keys(results), review },
        timestamp: Date.now()
      });

      // Validate new plan
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
          
          // Execute new plan
          results = await executePlan(plan, rawgApiKey, onStep);
        } else {
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
      steps.push({
        id: generateStepId(),
        type: 'review',
        name: 'Results Satisfactory',
        summary: 'Proceeding to answer generation.',
        details: { review },
        timestamp: Date.now()
      });
    }
    
    // Generate final answer using LLM
    steps.push({
      id: generateStepId(),
      type: 'generating_answer',
      name: 'Generating Answer',
      summary: 'Analyzing results and writing response...',
      details: { results_summary: Object.keys(results) },
      timestamp: Date.now()
    });
    
    const answer = await generateFinalAnswer(genAI, userQuery, results, plan);
    
    // Collect all widget data from results
    const widgets: any[] = [];
    for (const [key, value] of Object.entries(results)) {
      if (key.endsWith('_widget') && value) {
        widgets.push(value);
      }
    }
    
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

// Streaming version
export async function runAgentStreaming(
  userQuery: string,
  geminiApiKey: string,
  rawgApiKey: string,
  streamCallback: StreamCallback
): Promise<void> {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  });

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
