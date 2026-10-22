// Agreement of an answer with the reference's on the same image: the character error rate, the
// edit distance over Unicode code points divided by the reference's length (0 is identical).

export function characterErrorRate(reference, text) {
  const want = [...reference];
  const got = [...text];
  let previous = Array.from({ length: got.length + 1 }, (_, j) => j);
  for (let i = 1; i <= want.length; i++) {
    const current = [i];
    for (let j = 1; j <= got.length; j++) {
      const substitution = previous[j - 1] + (want[i - 1] === got[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution));
    }
    previous = current;
  }
  const errors = previous[got.length];
  return { rate: errors / Math.max(1, want.length), errors, characters: want.length };
}
