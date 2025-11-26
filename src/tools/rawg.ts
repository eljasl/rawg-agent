// RAWG API Tool - Fetches game data with various filters

// Platform ID mapping for reference
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

// Genre ID mapping for reference
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

// Input parameters for fetch_game_data
export interface FetchGameDataInput {
  platforms?: string[];      // Platform names like ['pc', 'ps5']
  genres?: string[];         // Genre names like ['action', 'rpg']
  date_from?: string;        // Start date YYYY-MM-DD
  date_to?: string;          // End date YYYY-MM-DD
  metacritic_min?: number;   // Minimum metacritic score
  metacritic_max?: number;   // Maximum metacritic score
  page_size?: number;        // Results per page (max 40)
  page?: number;             // Page number
  ordering?: string;         // Field to order by
  search?: string;           // Search query
  search_exact?: boolean;    // Mark the search query as exact match
  tags?: string;             // Filter by tags (e.g., "singleplayer,multiplayer")
  developers?: string;       // Filter by developers (e.g., "nintendo" or "nintendo,sega")
  publishers?: string;       // Filter by publishers (e.g., "nintendo" or "electronic-arts")
  exclude_additions?: boolean; // Exclude DLCs and editions to count only base games
}

// Game data returned from RAWG
export interface Game {
  id: number;
  name: string;
  released: string | null;
  metacritic: number | null;
  rating: number;
  ratings_count: number;
  platforms: { platform: { id: number; name: string } }[];
  genres: { id: number; name: string }[];
}

export interface FetchGameDataOutput {
  count: number;
  games: Game[];
  query_params: Record<string, string>;
}

// Convert platform names to IDs
function getPlatformIds(platforms: string[]): string {
  const ids: number[] = [];
  for (const p of platforms) {
    const id = PLATFORMS[p.toLowerCase()];
    if (id) ids.push(id);
  }
  return ids.join(',');
}

// Convert genre names to IDs
function getGenreIds(genres: string[]): string {
  const ids: number[] = [];
  for (const g of genres) {
    const id = GENRES[g.toLowerCase()];
    if (id) ids.push(id);
  }
  return ids.join(',');
}

// Main function to fetch game data from RAWG API
export async function fetchGameData(
  input: FetchGameDataInput,
  apiKey: string
): Promise<FetchGameDataOutput> {
  const baseUrl = 'https://api.rawg.io/api/games';
  const params = new URLSearchParams();
  
  params.set('key', apiKey);
  params.set('page_size', String(input.page_size || 40));
  
  if (input.page) {
    params.set('page', String(input.page));
  }
  
  if (input.platforms && input.platforms.length > 0) {
    const platformIds = getPlatformIds(input.platforms);
    if (platformIds) params.set('platforms', platformIds);
  }
  
  if (input.genres && input.genres.length > 0) {
    const genreIds = getGenreIds(input.genres);
    if (genreIds) params.set('genres', genreIds);
  }
  
  if (input.date_from || input.date_to) {
    const from = input.date_from || '1970-01-01';
    const to = input.date_to || '2099-12-31';
    params.set('dates', `${from},${to}`);
  }
  
  if (input.metacritic_min !== undefined || input.metacritic_max !== undefined) {
    const min = input.metacritic_min ?? 0;
    const max = input.metacritic_max ?? 100;
    params.set('metacritic', `${min},${max}`);
  }
  
  if (input.ordering) {
    params.set('ordering', input.ordering);
  }
  
  if (input.search) {
    params.set('search', input.search);
    params.set('search_precise', 'true');
    if (input.search_exact) {
      params.set('search_exact', 'true');
    }
  }
  
  if (input.tags) {
    params.set('tags', input.tags);
  }
  
  if (input.developers) {
    params.set('developers', input.developers);
  }
  
  if (input.publishers) {
    params.set('publishers', input.publishers);
  }
  
  if (input.exclude_additions) {
    params.set('exclude_additions', 'true');
  }

  const url = `${baseUrl}?${params.toString()}`;
  
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`RAWG API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json() as {
    count: number;
    results: Game[];
  };
  
  // Convert params to a plain object for logging
  const queryParams: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key !== 'key') queryParams[key] = value; // Don't expose API key
  });
  
  return {
    count: data.count,
    games: data.results,
    query_params: queryParams,
  };
}

