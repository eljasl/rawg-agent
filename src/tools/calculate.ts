// Safe calculation executor for numerical analysis

export interface CalculationInput {
  operation: 'average' | 'sum' | 'count' | 'min' | 'max' | 'compare' | 'filter' | 'group_average';
  data: number[] | Record<string, number[]>;
  field?: string;
}

export interface CalculationOutput {
  result: number | Record<string, number> | string;
  formula: string;
  details: string;
}

// Execute a calculation on the provided data
export function executeCalculation(input: CalculationInput): CalculationOutput {
  const { operation, data } = input;
  
  switch (operation) {
    case 'average': {
      if (!Array.isArray(data)) {
        throw new Error('Average operation requires an array of numbers');
      }
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
        result: Math.round(avg * 100) / 100,
        formula: `sum(${validNumbers.length} values) / ${validNumbers.length}`,
        details: `Sum: ${sum}, Count: ${validNumbers.length}, Average: ${avg.toFixed(2)}`
      };
    }
    
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
    
    case 'compare': {
      // Compare multiple groups (data should be Record<string, number[]>)
      if (Array.isArray(data)) {
        throw new Error('Compare operation requires a Record<string, number[]>');
      }
      const averages: Record<string, number> = {};
      const details: string[] = [];
      
      for (const [key, values] of Object.entries(data)) {
        const validNumbers = values.filter(n => n !== null && !isNaN(n));
        if (validNumbers.length > 0) {
          const avg = validNumbers.reduce((a, b) => a + b, 0) / validNumbers.length;
          averages[key] = Math.round(avg * 100) / 100;
          
          if (validNumbers.length === 1) {
            details.push(`${key}: ${averages[key]}`);
          } else {
            details.push(`${key}: avg=${averages[key]} (n=${validNumbers.length})`);
          }
        }
      }
      
      // Find the winner
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
    
    case 'group_average': {
      // Calculate average for each group in a Record<string, number[]>
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

// Helper function to extract numeric field from game objects
export function extractField(games: any[], field: string): number[] {
  return games
    .map(game => game[field])
    .filter(val => val !== null && val !== undefined && !isNaN(val));
}

