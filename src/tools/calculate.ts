/**
 * =============================================================================
 * CALCULATE TOOL
 * =============================================================================
 * 
 * This tool performs statistical calculations on game data fetched from RAWG.
 * It provides a safe, sandboxed way to compute statistics without allowing
 * arbitrary code execution.
 * 
 * ## Supported Operations
 * 
 * | Operation     | Input Type            | Output Type             | Description              |
 * |---------------|----------------------|-------------------------|--------------------------|
 * | average       | number[]             | number                  | Mean of values           |
 * | sum           | number[]             | number                  | Sum of values            |
 * | count         | any[]                | number                  | Number of items          |
 * | min           | number[]             | number                  | Minimum value            |
 * | max           | number[]             | number                  | Maximum value            |
 * | compare       | Record<string, number[]> | Record<string, number> | Averages per group + winner |
 * | group_average | Record<string, number[]> | Record<string, number> | Averages per group       |
 * 
 * ## Design Notes
 * 
 * 1. **Transparency**: Each calculation returns not just a result, but also
 *    a 'formula' and 'details' string. These are shown in the frontend widgets
 *    so users can verify the calculations.
 * 
 * 2. **Null Safety**: All operations filter out null/undefined/NaN values
 *    before computing. This handles games without Metacritic scores, etc.
 * 
 * 3. **Precision**: Results are rounded to 2 decimal places for display.
 * 
 * =============================================================================
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Input for the executeCalculation function.
 * 
 * For simple operations (average, sum, count, min, max):
 *   - data should be number[]
 * 
 * For group operations (compare, group_average):
 *   - data should be Record<string, number[]>
 *   - Each key is a group name, value is the numbers for that group
 */
export interface CalculationInput {
  operation: 'average' | 'sum' | 'count' | 'min' | 'max' | 'compare' | 'filter' | 'group_average';
  data: number[] | Record<string, number[]>;
  field?: string;  // Not used directly, but may be passed from orchestrator
}

/**
 * Output from calculation operations.
 * 
 * All operations return:
 * - result: The computed value(s)
 * - formula: A human-readable representation of the calculation
 * - details: Additional context about the computation
 * 
 * These are displayed in the frontend calculation widgets for transparency.
 */
export interface CalculationOutput {
  result: number | Record<string, number> | string;
  formula: string;   // e.g., "sum(40 values) / 40"
  details: string;   // e.g., "Sum: 3200, Count: 40, Average: 80.00"
}

// =============================================================================
// MAIN CALCULATION FUNCTION
// =============================================================================

/**
 * Executes a statistical calculation on the provided data.
 * 
 * This function is the core of the calculate tool. It takes an operation
 * name and data, performs the calculation, and returns a detailed result
 * with formula and explanation.
 * 
 * ## Null Handling
 * 
 * All numeric operations filter out invalid values (null, undefined, NaN)
 * before computing. This is important because:
 * - Not all games have Metacritic scores
 * - Some games may have incomplete data
 * 
 * If no valid numbers remain after filtering, operations return 0 with
 * an explanatory message rather than throwing an error.
 * 
 * @param input - The calculation input with operation and data
 * @returns CalculationOutput with result, formula, and details
 * @throws Error if operation type doesn't match data type
 */
export function executeCalculation(input: CalculationInput): CalculationOutput {
  const { operation, data } = input;
  
  switch (operation) {
    // =========================================
    // AVERAGE - Mean of numeric values
    // =========================================
    case 'average': {
      if (!Array.isArray(data)) {
        throw new Error('Average operation requires an array of numbers');
      }
      // Filter out null/undefined/NaN values
      const validNumbers = data.filter(n => n !== null && !isNaN(n));
      if (validNumbers.length === 0) {
        return {
          result: 0,
          formula: 'No valid numbers to average',
          details: 'Input contained no valid numeric values'
        };
      }
      const sum = validNumbers.reduce((a, b) => a + b, 0);
      const avg = sum / validNumbers.length;
      return {
        result: Math.round(avg * 100) / 100,  // Round to 2 decimal places
        formula: `sum(${validNumbers.length} values) / ${validNumbers.length}`,
        details: `Sum: ${sum}, Count: ${validNumbers.length}, Average: ${avg.toFixed(2)}`
      };
    }
    
    // =========================================
    // SUM - Total of numeric values
    // =========================================
    case 'sum': {
      if (!Array.isArray(data)) {
        throw new Error('Sum operation requires an array of numbers');
      }
      const validNumbers = data.filter(n => n !== null && !isNaN(n));
      const sum = validNumbers.reduce((a, b) => a + b, 0);
      return {
        result: sum,
        formula: `sum(${validNumbers.length} values)`,
        details: `Added ${validNumbers.length} numbers together`
      };
    }
    
    // =========================================
    // COUNT - Number of items in array
    // =========================================
    case 'count': {
      if (!Array.isArray(data)) {
        throw new Error('Count operation requires an array');
      }
      return {
        result: data.length,
        formula: `count(data)`,
        details: `Counted ${data.length} items`
      };
    }
    
    // =========================================
    // MIN - Minimum numeric value
    // =========================================
    case 'min': {
      if (!Array.isArray(data)) {
        throw new Error('Min operation requires an array of numbers');
      }
      const validNumbers = data.filter(n => n !== null && !isNaN(n));
      if (validNumbers.length === 0) {
        return { result: 0, formula: 'No valid numbers', details: 'No valid numbers found' };
      }
      const min = Math.min(...validNumbers);
      return {
        result: min,
        formula: `min(${validNumbers.length} values)`,
        details: `Minimum value from ${validNumbers.length} numbers`
      };
    }
    
    // =========================================
    // MAX - Maximum numeric value
    // =========================================
    case 'max': {
      if (!Array.isArray(data)) {
        throw new Error('Max operation requires an array of numbers');
      }
      const validNumbers = data.filter(n => n !== null && !isNaN(n));
      if (validNumbers.length === 0) {
        return { result: 0, formula: 'No valid numbers', details: 'No valid numbers found' };
      }
      const max = Math.max(...validNumbers);
      return {
        result: max,
        formula: `max(${validNumbers.length} values)`,
        details: `Maximum value from ${validNumbers.length} numbers`
      };
    }
    
    // =========================================
    // COMPARE - Compare averages across groups
    // =========================================
    // This is used for questions like "Which genre has the highest rating?"
    // It calculates the average for each group and identifies the winner.
    case 'compare': {
      if (Array.isArray(data)) {
        throw new Error('Compare operation requires a Record<string, number[]>');
      }
      
      const averages: Record<string, number> = {};
      const details: string[] = [];
      
      // Calculate average for each group
      for (const [key, values] of Object.entries(data)) {
        const validNumbers = values.filter(n => n !== null && !isNaN(n));
        if (validNumbers.length > 0) {
          const avg = validNumbers.reduce((a, b) => a + b, 0) / validNumbers.length;
          averages[key] = Math.round(avg * 100) / 100;
          
          // Format details - show sample size when > 1
          if (validNumbers.length === 1) {
            details.push(`${key}: ${averages[key]}`);
          } else {
            details.push(`${key}: avg=${averages[key]} (n=${validNumbers.length})`);
          }
        }
      }
      
      // Determine the winner (highest average)
      let winner = '';
      let highestAvg = -Infinity;
      for (const [key, avg] of Object.entries(averages)) {
        if (avg > highestAvg) {
          highestAvg = avg;
          winner = key;
        }
      }
      
      return {
        result: averages,
        formula: `compare_averages(${Object.keys(averages).join(', ')})`,
        details: `Compared: ${details.join('; ')}. Winner: ${winner} with ${highestAvg}`
      };
    }
    
    // =========================================
    // GROUP_AVERAGE - Average per group (no winner)
    // =========================================
    // Similar to compare, but doesn't identify a winner
    case 'group_average': {
      if (Array.isArray(data)) {
        throw new Error('Group average operation requires a Record<string, number[]>');
      }
      
      const averages: Record<string, number> = {};
      const details: string[] = [];
      
      for (const [key, values] of Object.entries(data)) {
        const validNumbers = values.filter(n => n !== null && !isNaN(n));
        if (validNumbers.length > 0) {
          const avg = validNumbers.reduce((a, b) => a + b, 0) / validNumbers.length;
          averages[key] = Math.round(avg * 100) / 100;
          details.push(`${key}: ${averages[key]} (n=${validNumbers.length})`);
        }
      }
      
      return {
        result: averages,
        formula: `group_average(${Object.keys(averages).length} groups)`,
        details: details.join('; ')
      };
    }
    
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Extracts a numeric field from an array of game objects.
 * 
 * This is used to pull out specific fields (like 'metacritic' or 'rating')
 * from the games returned by a fetch action. Invalid values are filtered out.
 * 
 * Example:
 *   const games = [{ metacritic: 85 }, { metacritic: null }, { metacritic: 90 }];
 *   extractField(games, 'metacritic') // Returns [85, 90]
 * 
 * @param games - Array of game objects from RAWG
 * @param field - Field name to extract ('metacritic', 'rating', 'ratings_count')
 * @returns Array of valid numeric values
 */
export function extractField(games: any[], field: string): number[] {
  return games
    .map(game => game[field])
    .filter(val => val !== null && val !== undefined && !isNaN(val));
}

