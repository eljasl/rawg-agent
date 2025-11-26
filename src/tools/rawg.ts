/**
 * =============================================================================
 * RAWG API TOOL
 * =============================================================================
 * 
 * This tool provides an interface to the RAWG Video Games Database API
 * (https://rawg.io/apidocs). RAWG is one of the largest video game databases,
 * with data on 500,000+ games.
 * 
 * ## Key Concepts
 * 
 * 1. **Platform/Genre IDs**: The RAWG API uses numeric IDs for platforms and
 *    genres. This tool handles the mapping from human-readable names to IDs.
 * 
 * 2. **Count vs Games**: API responses include:
 *    - 'count': Total matching games in the entire database
 *    - 'results': Actual game objects returned (limited by page_size)
 *    This distinction is important for "how many" questions.
 * 
 * 3. **Pagination**: RAWG limits results to 40 per page (page_size max).
 *    For statistical analysis, we typically work with the returned sample.
 * 
 * ## Usage by Orchestrator
 * 
 * The orchestrator calls fetchGameData() with parameters from the execution
 * plan. Results are stored and can be passed to calculate/compare actions.
 * 
 * =============================================================================
 */

// =============================================================================
// PLATFORM AND GENRE MAPPINGS
// =============================================================================

/**
 * Maps human-readable platform names to RAWG API platform IDs.
 * 
 * The LLM generates plans with readable names like "ps5" or "nintendo switch",
 * and this mapping converts them to the numeric IDs the API expects.
 * 
 * Note: Multiple aliases map to the same ID (e.g., 'ps5' and 'playstation 5'
 * both map to 187) for user convenience.
 */
export const PLATFORMS: Record<string, number> = {
  'pc': 4,
  'playstation 5': 187,
  'ps5': 187,
  'playstation 4': 18,
  'ps4': 18,
  'playstation 3': 16,
  'ps3': 16,
  'xbox one': 1,
  'xbox series': 186,
  'xbox series x': 186,
  'xbox series s': 186,
  'xbox 360': 14,
  'xbox': 80,
  'nintendo switch': 7,
  'switch': 7,
  'ios': 3,
  'android': 21,
  'macos': 5,
  'mac': 5,
  'linux': 6,
};

/**
 * Maps human-readable genre names to RAWG API genre IDs.
 * 
 * Used similarly to PLATFORMS - the LLM generates readable names,
 * and this converts them to API IDs.
 */
export const GENRES: Record<string, number> = {
  'action': 4,
  'indie': 51,
  'adventure': 3,
  'rpg': 5,
  'strategy': 10,
  'shooter': 2,
  'casual': 40,
  'simulation': 14,
  'puzzle': 7,
  'arcade': 11,
  'platformer': 83,
  'racing': 1,
  'sports': 15,
  'fighting': 6,
  'family': 19,
  'board games': 28,
  'card': 17,
  'educational': 34,
  'massively multiplayer': 59,
  'mmo': 59,
};

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Input parameters for the fetchGameData function.
 * 
 * These map to the RAWG API query parameters. The LLM generates execution
 * plans with these parameters, and we convert them to API calls.
 * 
 * Common filtering patterns:
 * - By platform: platforms: ['pc', 'ps5']
 * - By genre: genres: ['action', 'rpg']
 * - By date range: date_from + date_to
 * - By Metacritic: metacritic_min (often 1 to get only scored games)
 * - By search: search + optional search_exact
 */
export interface FetchGameDataInput {
  platforms?: string[];      // Platform names like ['pc', 'ps5']
  genres?: string[];         // Genre names like ['action', 'rpg']
  date_from?: string;        // Start date (YYYY-MM-DD format)
  date_to?: string;          // End date (YYYY-MM-DD format)
  metacritic_min?: number;   // Minimum Metacritic score (0-100)
  metacritic_max?: number;   // Maximum Metacritic score (0-100)
  page_size?: number;        // Results per page (max 40, default 40)
  page?: number;             // Page number for pagination
  ordering?: string;         // Sort order (e.g., '-metacritic', '-rating', 'name')
  search?: string;           // Text search query for game names
  search_exact?: boolean;    // If true, require exact name match
  tags?: string;             // Filter by tags (comma-separated slugs)
  developers?: string;       // Filter by developer slug(s)
  publishers?: string;       // Filter by publisher slug(s)
  exclude_additions?: boolean; // Exclude DLCs/editions (count only base games)
}

/**
 * Represents a single game from the RAWG API response.
 * 
 * Key fields for analysis:
 * - metacritic: Professional review aggregate (0-100, null if not scored)
 * - rating: RAWG user rating (0-5 scale)
 * - ratings_count: Number of user ratings
 */
export interface Game {
  id: number;                  // Unique RAWG game ID
  name: string;                // Game title
  released: string | null;     // Release date (YYYY-MM-DD or null)
  metacritic: number | null;   // Metacritic score (null if not available)
  rating: number;              // RAWG user rating (0-5)
  ratings_count: number;       // Number of RAWG user ratings
  platforms: { platform: { id: number; name: string } }[];  // Platforms array
  genres: { id: number; name: string }[];                   // Genres array
}

/**
 * Output from the fetchGameData function.
 * 
 * IMPORTANT: 'count' is the TOTAL matching games in the database,
 * not just the ones returned in 'games'. This is crucial for
 * "how many" questions.
 */
export interface FetchGameDataOutput {
  count: number;                        // Total matching games in database
  games: Game[];                        // Games returned (up to page_size)
  query_params: Record<string, string>; // The query params sent (for debugging)
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Converts an array of platform names to a comma-separated string of IDs.
 * 
 * Example: ['pc', 'ps5'] -> '4,187'
 * 
 * Unknown platform names are silently ignored. This is intentional -
 * if the LLM uses an unknown platform, we filter it out rather than
 * failing the entire request.
 */
function getPlatformIds(platforms: string[]): string {
  const ids: number[] = [];
  for (const p of platforms) {
    const id = PLATFORMS[p.toLowerCase()];
    if (id) ids.push(id);
  }
  return ids.join(',');
}

/**
 * Converts an array of genre names to a comma-separated string of IDs.
 * 
 * Example: ['action', 'rpg'] -> '4,5'
 * 
 * Same behavior as getPlatformIds - unknown genres are silently ignored.
 */
function getGenreIds(genres: string[]): string {
  const ids: number[] = [];
  for (const g of genres) {
    const id = GENRES[g.toLowerCase()];
    if (id) ids.push(id);
  }
  return ids.join(',');
}

// =============================================================================
// MAIN API FUNCTION
// =============================================================================

/**
 * Fetches game data from the RAWG API.
 * 
 * This is the core function that translates our high-level parameters into
 * a RAWG API call. It handles:
 * - Platform/genre name-to-ID conversion
 * - Date range formatting
 * - Metacritic score range
 * - Search parameters
 * - Developer/publisher filters
 * 
 * ## API Response Structure
 * 
 * RAWG returns:
 * ```json
 * {
 *   "count": 12345,           // Total matching games (important!)
 *   "next": "...",            // URL for next page
 *   "previous": null,         // URL for previous page
 *   "results": [...]          // Array of Game objects
 * }
 * ```
 * 
 * ## Important Notes
 * 
 * 1. The 'count' field gives the total database matches, not just results
 *    returned. This is crucial for "how many X games" questions.
 * 
 * 2. Maximum page_size is 40. For statistical analysis, we work with
 *    this sample, which is usually representative.
 * 
 * 3. We always set search_precise=true when searching to get more
 *    relevant results.
 * 
 * @param input - Query parameters from the execution plan
 * @param apiKey - RAWG API key
 * @returns FetchGameDataOutput with count, games, and query params
 */
export async function fetchGameData(
  input: FetchGameDataInput,
  apiKey: string
): Promise<FetchGameDataOutput> {
  const baseUrl = 'https://api.rawg.io/api/games';
  const params = new URLSearchParams();
  
  // Required parameters
  params.set('key', apiKey);
  params.set('page_size', String(input.page_size || 40));
  
  // Pagination
  if (input.page) {
    params.set('page', String(input.page));
  }
  
  // Platform filter - convert names to IDs
  if (input.platforms && input.platforms.length > 0) {
    const platformIds = getPlatformIds(input.platforms);
    if (platformIds) params.set('platforms', platformIds);
  }
  
  // Genre filter - convert names to IDs
  if (input.genres && input.genres.length > 0) {
    const genreIds = getGenreIds(input.genres);
    if (genreIds) params.set('genres', genreIds);
  }
  
  // Date range filter (RAWG uses comma-separated start,end format)
  if (input.date_from || input.date_to) {
    const from = input.date_from || '1970-01-01';  // Default to earliest
    const to = input.date_to || '2099-12-31';      // Default to far future
    params.set('dates', `${from},${to}`);
  }
  
  // Metacritic score range (RAWG uses comma-separated min,max format)
  if (input.metacritic_min !== undefined || input.metacritic_max !== undefined) {
    const min = input.metacritic_min ?? 0;
    const max = input.metacritic_max ?? 100;
    params.set('metacritic', `${min},${max}`);
  }
  
  // Sorting/ordering (e.g., '-metacritic' for descending by Metacritic)
  if (input.ordering) {
    params.set('ordering', input.ordering);
  }
  
  // Text search
  if (input.search) {
    params.set('search', input.search);
    params.set('search_precise', 'true');  // Always use precise search
    if (input.search_exact) {
      params.set('search_exact', 'true');
    }
  }
  
  // Tag filter
  if (input.tags) {
    params.set('tags', input.tags);
  }
  
  // Developer filter
  if (input.developers) {
    params.set('developers', input.developers);
  }
  
  // Publisher filter
  if (input.publishers) {
    params.set('publishers', input.publishers);
  }
  
  // Exclude DLCs and special editions (useful for counting base games only)
  if (input.exclude_additions) {
    params.set('exclude_additions', 'true');
  }

  // Make the API request
  const url = `${baseUrl}?${params.toString()}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`RAWG API error: ${response.status} ${response.statusText}`);
  }
  
  // Parse the response
  const data = await response.json() as {
    count: number;
    results: Game[];
  };
  
  // Build a sanitized query params object for logging/debugging
  // (excludes the API key for security)
  const queryParams: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key !== 'key') queryParams[key] = value;
  });
  
  return {
    count: data.count,      // Total matching games in database
    games: data.results,    // Games returned (up to page_size)
    query_params: queryParams,
  };
}

