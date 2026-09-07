import { describe, expect, test } from "bun:test";
import {
  extractOpenAIUsage,
  extractResponsesUsage,
} from "../../../src/usage/openai-usage";

describe("OpenAI usage normalization", () => {
  test("splits fresh, cache-write, cache-read, visible, and reasoning tokens", () => {
    expect(extractOpenAIUsage({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 20 },
    })).toEqual({
      input_tokens: 10,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 60,
      output_tokens: 30,
      reasoning_tokens: 20,
    });
  });

  test("normalizes Responses API usage keys", () => {
    expect(extractResponsesUsage({
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 70, cache_write_tokens: 40 },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 5 },
    })).toEqual({
      input_tokens: 10,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 70,
      output_tokens: 20,
      reasoning_tokens: 5,
    });
  });

  test("defaults optional usage details to zero", () => {
    expect(extractResponsesUsage({ input_tokens: 7, output_tokens: 3 })).toEqual({
      input_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
      reasoning_tokens: 0,
    });
  });
});
