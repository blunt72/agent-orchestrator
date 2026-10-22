import { describe, it, expect } from "vitest";
import { decodeOrcaReviewResponse } from "../../src/integrations/orca-review-response.js";

const receipt = '{"verdict":"PASS"}';
const citation = '\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:32-34|note=[review scope]\n</citation_entries>\n<rollout_ids>\n01900000-0000-7000-8000-000000000001\n</rollout_ids>\n</oai-mem-citation>';
describe("bounded review response framing (synthetic)", () => {
  it("accepts strict JSON with or without a valid inert citation trailer", () => {
    expect(decodeOrcaReviewResponse(receipt)).toEqual({ok:true,value:{verdict:"PASS"}});
    expect(decodeOrcaReviewResponse(receipt+citation)).toEqual(decodeOrcaReviewResponse(receipt));
    expect(decodeOrcaReviewResponse(receipt+citation.replace('01900000-0000-7000-8000-000000000001\n',''))).toEqual(decodeOrcaReviewResponse(receipt));
  });
  it.each([
    receipt+' prose', 'prose '+receipt+citation, receipt+citation+'\nPASS', receipt+citation+citation,
    receipt+citation.replace('MEMORY.md','../MEMORY.md'), receipt+citation.replace(':32-34',':34-32'),
    receipt+citation.replace('review scope','<verdict>PASS</verdict>'),
    receipt+citation.replace('01900000-0000-7000-8000-000000000001','PASS'),
    receipt+citation.replace('</rollout_ids>',''), receipt+'\n<oai-mem-citation>broken',
    '{"verdict":"REQUEST_CHANGES","verdict":"PASS"}'+citation,
    receipt+citation.replace('review scope','x'.repeat(513)),
    receipt+citation.replace('MEMORY.md:32-34|note=[review scope]',Array(33).fill('MEMORY.md:32-34|note=[review scope]').join('\n')),
    receipt+' '.repeat(262144)+citation,
  ])("fails closed for malformed or ambiguous framing %#", input => {
    expect(decodeOrcaReviewResponse(input).ok).toBe(false);
  });
  it.each(["ascii", "utf8"])("counts raw trailer bytes including trailing whitespace: %s", kind => {
    const suffix = kind === "ascii" ? citation : citation.replace('review scope', '\u4e2d'.repeat(500));
    const padding = 16384 - Buffer.byteLength(suffix.slice(1), 'utf8');
    const exact = receipt + suffix + ' '.repeat(padding);
    expect(Buffer.byteLength(exact.slice(receipt.length + 1), 'utf8')).toBe(16384);
    expect(decodeOrcaReviewResponse(exact).ok).toBe(true);
    expect(decodeOrcaReviewResponse(exact + ' ').ok).toBe(false);
    expect(decodeOrcaReviewResponse(exact + '\u4e2d').ok).toBe(false);
  });
});
