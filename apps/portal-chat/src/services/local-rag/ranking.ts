export interface RankedRecord<T> {
  record: T;
  score: number;
}

/**
 * Scores vectors and keeps only the best `topK` entries. Equal scores retain
 * their input order, matching the stable ordering of the previous full sort.
 */
export function rankCosineTopK<T>(
  records: readonly T[],
  queryVector: Float32Array,
  vectorOf: (record: T) => Float32Array,
  topK: number,
): RankedRecord<T>[] {
  const limit = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 0;
  if (limit === 0 || records.length === 0) return [];

  const ranked: RankedRecord<T>[] = [];
  for (let inputIndex = 0; inputIndex < records.length; inputIndex += 1) {
    const record = records[inputIndex];
    if (record === undefined) continue;
    const score = cosineSimilarity(queryVector, vectorOf(record));

    // Binary insertion avoids materializing and sorting a scored copy of the
    // entire collection. Scanning in input order keeps ties stable.
    let low = 0;
    let high = ranked.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((ranked[middle]?.score ?? Number.NEGATIVE_INFINITY) >= score) low = middle + 1;
      else high = middle;
    }
    if (low >= limit) continue;
    ranked.splice(low, 0, { record, score });
    if (ranked.length > limit) ranked.pop();
  }

  return ranked;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue ** 2;
    rightNorm += rightValue ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}
