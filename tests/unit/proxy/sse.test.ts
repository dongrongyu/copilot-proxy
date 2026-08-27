import { describe, expect, test } from "bun:test";
import { forwardSSEStream } from "../../../src/proxy/sse";

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("forwardSSEStream", () => {
  test("preserves named event framing across upstream chunks", async () => {
    const input = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1}}}',
      "",
      "",
    ].join("\n");
    const encoded = new TextEncoder().encode(input);
    const sourceChunks = [
      encoded.slice(0, 9),
      encoded.slice(9, 31),
      encoded.slice(31, 87),
      encoded.slice(87),
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sourceChunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const forwarded: Uint8Array[] = [];
    const observedData: string[] = [];

    await forwardSSEStream(
      source,
      async (chunk) => { forwarded.push(chunk.slice()); },
      (data) => { observedData.push(data); },
    );

    expect(new TextDecoder().decode(concatenate(forwarded))).toBe(input);
    expect(observedData.map((data) => JSON.parse(data).type)).toEqual([
      "response.created",
      "response.completed",
    ]);
  });
});
