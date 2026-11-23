// Finding a capture by the title the pipeline asks about.

// A title's letters and digits in lower case, so a title the pipeline has tidied still finds its capture.
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function wordsOf(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== ""),
  );
}

// Which of a listing's captured titles a classification question is about: the same title, then the same letters
// and digits, then the only one left, then the one that shares the most words. The pipeline tidies an extracted
// title (capitals, pipes, punctuation), so the title asked about is not always the capture's own, and a capture
// must never be cut off from its own classification. -1 when none is left, or none shares a word.
export function capturedIndex(captured: string[], title: string): number {
  const exact = captured.findIndex((one) => one.trim() === title);
  if (exact !== -1) return exact;
  const alike = captured.findIndex((one) => titleKey(one) === titleKey(title));
  if (alike !== -1) return alike;
  if (captured.length <= 1) return captured.length - 1;
  const asked = wordsOf(title);
  let best = -1;
  let most = 0;
  captured.forEach((one, index) => {
    const shared = [...wordsOf(one)].filter((word) => asked.has(word)).length;
    if (shared > most) {
      most = shared;
      best = index;
    }
  });
  return best;
}
