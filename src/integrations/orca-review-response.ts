import { decodeOrcaJson } from "./orca-json.js";

/** Optional metadata is inert and never supplies verdicts or identity fields. */
export function decodeOrcaReviewResponse(text: string): ReturnType<typeof decodeOrcaJson> {
  const invalid = () => decodeOrcaJson("");
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 262144) return invalid();
  const marker = "\n<oai-mem-citation>\n";
  const offset = text.indexOf(marker);
  if (offset < 0) return decodeOrcaJson(text);
  const rawTrailer = text.slice(offset + 1);
  if (Buffer.byteLength(rawTrailer, "utf8") > 16384) return invalid();
  const trailer = rawTrailer.trimEnd();
  const lines = trailer.split("\n");
  if (lines.shift() !== "<oai-mem-citation>" || lines.shift() !== "<citation_entries>") return invalid();
  let count = 0;
  while (lines.length && lines[0] !== "</citation_entries>") {
    const entry = lines.shift()!;
    const match = /^([A-Za-z0-9_./-]+):(\d{1,9})-(\d{1,9})\|note=\[([^<>\[\]\x00-\x1f]{1,512})\]$/.exec(entry);
    if (!match || ++count > 32 || match[1].startsWith("/") || match[1].split("/").some(p => !p || p === "." || p === "..") ||
      Number(match[2]) < 1 || Number(match[3]) < Number(match[2])) return invalid();
  }
  if (!count || lines.shift() !== "</citation_entries>" || lines.shift() !== "<rollout_ids>") return invalid();
  count = 0;
  while (lines.length && lines[0] !== "</rollout_ids>") {
    if (++count > 32 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(lines.shift()!)) return invalid();
  }
  if (lines.shift() !== "</rollout_ids>" || lines.shift() !== "</oai-mem-citation>" || lines.length) return invalid();
  return decodeOrcaJson(text.slice(0, offset));
}
