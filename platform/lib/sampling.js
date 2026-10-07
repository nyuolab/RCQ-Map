function requireInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer.`);
  }
}

/**
 * Small, deterministic 32-bit pseudo-random number generator.
 * Keeping the algorithm here makes a seed reproduce the same cohort on any
 * supported Node.js version instead of depending on an implementation detail.
 */
export function createMulberry32(seed) {
  requireInteger(seed, "Seed");
  let state = seed >>> 0;

  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleIndices(populationSize, sampleSize, seed) {
  requireInteger(populationSize, "Population size");
  requireInteger(sampleSize, "Sample size");
  requireInteger(seed, "Seed");

  if (populationSize < 0) throw new RangeError("Population size cannot be negative.");
  if (sampleSize < 0 || sampleSize > populationSize) {
    throw new RangeError("Sample size must be between zero and the population size.");
  }

  const random = createMulberry32(seed);
  const indices = Array.from({ length: populationSize }, (_, index) => index);

  // Fisher-Yates produces a uniform sample without replacement.
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [indices[index], indices[swapIndex]] = [indices[swapIndex], indices[index]];
  }

  // Keep selected records in source order so the annotator display is stable.
  return indices.slice(0, sampleSize).sort((left, right) => left - right);
}

export function sampleRows(rows, sampleSize, seed) {
  if (!Array.isArray(rows)) throw new TypeError("Rows must be an array.");
  return sampleIndices(rows.length, sampleSize, seed).map((index) => rows[index]);
}
