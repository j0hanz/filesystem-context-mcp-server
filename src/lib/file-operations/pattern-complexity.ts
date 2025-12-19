/**
 * Estimates the complexity/performance impact of a glob pattern
 * Helps users understand which patterns might be slow
 */

export interface PatternComplexityAnalysis {
  complexity: 'fast' | 'moderate' | 'slow';
  score: number; // 0-100, lower is faster
  factors: string[];
  recommendations: string[];
}

const COMPLEXITY_WEIGHTS = {
  leadingGlobstar: 15, // **/ at start
  extglob: 20, // +(pattern), !(pattern), etc.
  largeBraceExpansion: 25, // {a,b,c,...}
  nestedQuantifiers: 30, // Complex regex
  multiplePatternsInBrace: 10, // {a,b} = 10 points per item
  leadingRecursion: 20, // Starting with **/
};

export function analyzePatternComplexity(
  pattern: string
): PatternComplexityAnalysis {
  let score = 0;
  const factors: string[] = [];
  const recommendations: string[] = [];

  // Check for leading globstar
  if (pattern.startsWith('**/')) {
    score += COMPLEXITY_WEIGHTS.leadingGlobstar;
    factors.push('Pattern starts with **/');
    recommendations.push(
      'Consider using a base directory if available (e.g., src/**/*.ts instead of **/src/**/*.ts)'
    );
  }

  // Check for extglob patterns: +(), !(), ?(), *()
  const extglobMatches = pattern.match(/[+!?*]\(\S+\)/g) ?? [];
  if (extglobMatches.length > 0) {
    score += extglobMatches.length * COMPLEXITY_WEIGHTS.extglob;
    factors.push(`Extglob patterns: ${extglobMatches.join(', ')}`);
    recommendations.push(
      'Extglobs are slower. Use simpler patterns if possible (e.g., *.{js,ts} instead of +(js|ts))'
    );
  }

  // Check for large brace expansions
  const braceMatches = pattern.match(/\{[^}]*\}/g) ?? [];
  for (const brace of braceMatches) {
    const items = brace.slice(1, -1).split(',');
    if (items.length > 20) {
      score += COMPLEXITY_WEIGHTS.largeBraceExpansion;
      factors.push(
        `Large brace expansion: ${items.length} items in {${items.slice(0, 3).join(',')}...}`
      );
      recommendations.push(
        'Use character classes or split into multiple simpler patterns'
      );
    } else if (items.length > 5) {
      score += items.length * COMPLEXITY_WEIGHTS.multiplePatternsInBrace;
    }
  }

  // Check for nested quantifiers (regex complexity)
  if (/([+*?}])\s*\)\s*([+*?{])/.test(pattern)) {
    score += COMPLEXITY_WEIGHTS.nestedQuantifiers;
    factors.push('Nested quantifiers detected');
    recommendations.push('Simplify nested patterns to reduce regex complexity');
  }

  // Check for multiple ** segments
  const globstarCount = (pattern.match(/\*\*/g) ?? []).length;
  if (globstarCount > 2) {
    score += 15;
    factors.push(`Multiple globstars: ${globstarCount}`);
    recommendations.push('Limit use of ** to narrow down search space');
  }

  // Determine complexity level
  let complexity: 'fast' | 'moderate' | 'slow';
  if (score < 20) {
    complexity = 'fast';
  } else if (score < 50) {
    complexity = 'moderate';
  } else {
    complexity = 'slow';
  }

  return {
    complexity,
    score: Math.min(score, 100),
    factors,
    recommendations,
  };
}

/**
 * Provides user-friendly complexity warning
 */
export function getComplexityWarning(
  analysis: PatternComplexityAnalysis
): string | null {
  if (analysis.complexity === 'slow') {
    return `⚠️ Pattern complexity is HIGH (score: ${analysis.score}/100). This search may take longer than expected. ${analysis.recommendations[0] ?? ''}`;
  }
  if (analysis.complexity === 'moderate' && analysis.score > 40) {
    return `ℹ️ Pattern complexity is MODERATE (score: ${analysis.score}/100). Consider optimizing: ${analysis.recommendations[0] ?? ''}`;
  }
  return null;
}
