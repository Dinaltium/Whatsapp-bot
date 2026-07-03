/**
 * Parses the trailing `-img` image-request flag off a SELF prompt.
 *
 * `-img` at the end of a question requests a reference image with the answer.
 * A literal hyphen needed inside the question is written quoted (`"-"`) so it
 * isn't mistaken for a flag; it is unescaped back to a hyphen after parsing.
 *
 * Example: `Who is the fastest runner in the world "-" in which country -img`
 *   → { wantImage: true, prompt: "Who is the fastest runner in the world - in which country" }
 */
export function parseImageFlag(prompt: string): {
  wantImage: boolean;
  prompt: string;
} {
  let p = (prompt || "").trim();
  let wantImage = false;
  if (/(^|\s)-img$/i.test(p)) {
    wantImage = true;
    p = p.replace(/(^|\s)-img$/i, "").trim();
  }
  p = p.replace(/"-"/g, "-");
  return { wantImage, prompt: p };
}
