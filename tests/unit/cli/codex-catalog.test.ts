import { describe, expect, test } from "bun:test";
import {
  codexCatalogCommands,
  codexAutoCompactLimit,
  loadBundledCodexCatalogFromCommands,
  patchCodexCatalogForCopilot,
} from "../../../src/cli/codex-catalog";

describe("Codex model catalog overrides", () => {
  test("derives prompt-safe auto-compaction thresholds", () => {
    expect(codexAutoCompactLimit(922_000)).toBe(900_000);
    expect(codexAutoCompactLimit(272_000)).toBe(260_000);
    expect(codexAutoCompactLimit(undefined)).toBeUndefined();
    expect(codexAutoCompactLimit(0)).toBeUndefined();
  });

  test("patches only GPT models present in both catalogs", () => {
    const source = {
      models: [
        {
          slug: "gpt-5.6-sol",
          context_window: 272_000,
          max_context_window: 272_000,
          auto_compact_token_limit: null,
          untouched: "keep",
        },
        {
          slug: "gpt-5.4-mini",
          context_window: 272_000,
          max_context_window: 272_000,
          auto_compact_token_limit: null,
        },
        {
          slug: "gpt-5.2",
          context_window: 272_000,
          max_context_window: 272_000,
        },
        {
          slug: "codex-auto-review",
          context_window: 272_000,
          max_context_window: 1_000_000,
        },
      ],
    };
    const copilot = [
      {
        id: "gpt-5.6-sol",
        capabilities: {
          limits: {
            max_context_window_tokens: 1_050_000,
            max_prompt_tokens: 922_000,
          },
        },
      },
      {
        id: "gpt-5.4-mini",
        capabilities: {
          limits: {
            max_context_window_tokens: 400_000,
            max_prompt_tokens: 272_000,
          },
        },
      },
      {
        id: "gpt-5.3-codex",
        capabilities: {
          limits: {
            max_context_window_tokens: 400_000,
            max_prompt_tokens: 272_000,
          },
        },
      },
      {
        id: "codex-auto-review",
        capabilities: {
          limits: {
            max_context_window_tokens: 1_050_000,
            max_prompt_tokens: 922_000,
          },
        },
      },
    ] as any;

    const result = patchCodexCatalogForCopilot(source, copilot);

    expect(result.overrides.map((item) => item.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.4-mini",
    ]);
    const sol = result.catalog.models.find((model) => model.slug === "gpt-5.6-sol")!;
    expect(sol.context_window).toBe(1_050_000);
    expect(sol.max_context_window).toBe(1_050_000);
    expect(sol.auto_compact_token_limit).toBe(900_000);
    expect(sol.untouched).toBe("keep");

    const mini = result.catalog.models.find((model) => model.slug === "gpt-5.4-mini")!;
    expect(mini.context_window).toBe(400_000);
    expect(mini.max_context_window).toBe(400_000);
    expect(mini.auto_compact_token_limit).toBe(260_000);

    expect(result.catalog.models.some((model) => model.slug === "gpt-5.3-codex")).toBe(false);
    expect(result.catalog.models.find((model) => model.slug === "gpt-5.2")?.context_window)
      .toBe(272_000);
    expect(result.catalog.models.find((model) => model.slug === "codex-auto-review")?.max_context_window)
      .toBe(1_000_000);

    // The official source catalog is cloned, not mutated.
    expect(source.models[0]?.context_window).toBe(272_000);
    expect(source.models[0]?.auto_compact_token_limit).toBeNull();
  });

  test("synthesizes metadata for a selected Copilot GPT missing from Codex", () => {
    const source = {
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "medium", description: "Medium" },
          { effort: "max", description: "Max" },
          { effort: "ultra", description: "Ultra" },
        ],
        additional_speed_tiers: ["fast"],
        service_tiers: [{ id: "priority", name: "Fast" }],
        base_instructions: "You are Codex, an agent based on GPT-5. Work carefully.",
        model_messages: {
          instructions_template: "You are Codex, an agent based on GPT-5. Work carefully.",
        },
        context_window: 272_000,
        max_context_window: 872_000,
        auto_compact_token_limit: null,
      }],
    };
    const copilot = [{
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      capabilities: {
        limits: {
          max_context_window_tokens: 1_000_000,
          max_prompt_tokens: 872_000,
        },
        supports: {
          reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
        },
      },
    }] as any;

    const result = patchCodexCatalogForCopilot(source, copilot, "gpt-6-astra");
    const astra = result.catalog.models.find((model) => model.slug === "gpt-6-astra")!;

    expect(astra.display_name).toBe("GPT-6 Astra");
    expect(astra.description).toBe("GPT-6 Astra through GitHub Copilot.");
    expect(astra.supported_reasoning_levels.map((item: any) => item.effort)).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
    expect(astra.additional_speed_tiers).toEqual([]);
    expect(astra.service_tiers).toEqual([]);
    expect(astra.context_window).toBe(1_000_000);
    expect(astra.max_context_window).toBe(1_000_000);
    expect(astra.auto_compact_token_limit).toBe(850_000);
    expect(astra.base_instructions).toStartWith(
      "You are Codex, an agent based on GPT-6 Astra.",
    );
    expect(astra.model_messages.instructions_template).toStartWith(
      "You are Codex, an agent based on GPT-6 Astra.",
    );
    expect(result.overrides.map((item) => item.id)).toContain("gpt-6-astra");

    expect(source.models).toHaveLength(1);
    expect(source.models[0]?.slug).toBe("gpt-5.6-sol");
  });

  test("fills a missing compact limit even when context already matches", () => {
    const source = {
      models: [{
        slug: "gpt-5.6-sol",
        context_window: 1_050_000,
        max_context_window: 1_050_000,
        auto_compact_token_limit: null,
      }],
    };
    const copilot = [{
      id: "gpt-5.6-sol",
      capabilities: {
        limits: {
          max_context_window_tokens: 1_050_000,
          max_prompt_tokens: 922_000,
        },
      },
    }] as any;

    const result = patchCodexCatalogForCopilot(source, copilot);
    expect(result.overrides).toHaveLength(1);
    expect(result.catalog.models[0]?.context_window).toBe(1_050_000);
    expect(result.catalog.models[0]?.auto_compact_token_limit).toBe(900_000);
  });

  test("preserves an existing stricter compact limit", () => {
    const source = {
      models: [{
        slug: "gpt-5.6-sol",
        context_window: 1_050_000,
        max_context_window: 1_050_000,
        auto_compact_token_limit: 850_000,
      }],
    };
    const copilot = [{
      id: "gpt-5.6-sol",
      capabilities: {
        limits: {
          max_context_window_tokens: 1_050_000,
          max_prompt_tokens: 922_000,
        },
      },
    }] as any;

    const result = patchCodexCatalogForCopilot(source, copilot);
    expect(result.overrides).toEqual([]);
    expect(result.catalog).toEqual(source);
  });

  test("rejects an invalid or empty catalog", () => {
    expect(() => patchCodexCatalogForCopilot({}, [])).toThrow("models array");
    expect(() => patchCodexCatalogForCopilot({ models: [] }, [])).toThrow("at least one");
  });

  test("falls back to Windows Codex when the WSL PATH shim fails", () => {
    const commands = [
      { label: "Codex", command: "codex", args: ["debug", "models", "--bundled"] },
      {
        label: "Windows Codex",
        command: "cmd.exe",
        args: ["/d", "/c", "codex.cmd", "debug", "models", "--bundled"],
      },
    ];
    const calls: string[] = [];
    const catalog = loadBundledCodexCatalogFromCommands(commands, (spec) => {
      calls.push(spec.label);
      if (spec.label === "Codex") {
        throw new Error("Missing optional dependency @openai/codex-linux-x64");
      }
      return JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] });
    });

    expect(calls).toEqual(["Codex", "Windows Codex"]);
    expect(catalog.models[0]?.slug).toBe("gpt-5.6-sol");
  });

  test("uses cmd.exe directly on native Windows", () => {
    const commands = codexCatalogCommands("win32");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.label).toBe("Windows Codex");
    expect(commands[0]?.args).toEqual([
      "/d", "/c", "codex.cmd", "debug", "models", "--bundled",
    ]);
  });

  test("skips an older catalog that lacks the selected model", () => {
    const commands = [
      { label: "Older Codex", command: "old", args: [] },
      { label: "Current Codex", command: "current", args: [] },
    ];
    const catalog = loadBundledCodexCatalogFromCommands(
      commands,
      (spec) => spec.label === "Older Codex"
        ? JSON.stringify({ models: [{ slug: "gpt-5.5" }] })
        : JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] }),
      "gpt-5.6-sol",
    );
    expect(catalog.models[0]?.slug).toBe("gpt-5.6-sol");
  });

  test("returns a valid fallback catalog when synthesis is allowed", () => {
    const commands = [
      { label: "Codex", command: "codex", args: [] },
      { label: "Windows Codex", command: "cmd.exe", args: [] },
    ];
    const catalog = loadBundledCodexCatalogFromCommands(
      commands,
      (spec) => spec.label === "Codex"
        ? JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] })
        : JSON.stringify({ models: [{ slug: "gpt-5.5" }] }),
      "gpt-6-astra",
      true,
    );
    expect(catalog.models[0]?.slug).toBe("gpt-5.6-sol");
  });

  test("explains when installed Codex catalogs lack the selected model", () => {
    const commands = [{ label: "Windows Codex", command: "cmd.exe", args: [] }];
    expect(() => loadBundledCodexCatalogFromCommands(
      commands,
      () => JSON.stringify({ models: [{ slug: "gpt-5.5" }] }),
      "gpt-5.6-sol",
    )).toThrow("catalog does not include gpt-5.6-sol");
  });

  test("reports all catalog command failures", () => {
    const commands = [
      { label: "Codex", command: "codex", args: [] },
      { label: "Windows Codex", command: "cmd.exe", args: [] },
    ];
    expect(() => loadBundledCodexCatalogFromCommands(commands, (spec) => {
      if (spec.label === "Codex") return "not json";
      throw new Error("command not found");
    })).toThrow(/Codex: invalid JSON.*Windows Codex: command not found/);
  });
});
