import { describe, expect, it } from "vitest";
import { repairArkInput } from "../../src/ark-proxy.js";

describe("repairArkInput", () => {
  it("adds status to prior-turn items Ark validates", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", summary: [], content: [], encrypted_content: "x" },
        { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    };

    expect(repairArkInput(body)).toBe(4);
    expect(body.input.every((item) => (item as { status?: string }).status === "completed")).toBe(
      true,
    );
  });

  it("never adds status inside nested content parts", () => {
    // Ark REQUIRES status on the item and REJECTS it inside content:
    // "input.content: unknown field \"status\"". Recursing breaks every request.
    const body = {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
    };

    repairArkInput(body);

    const content = (body.input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).not.toHaveProperty("status");
  });

  it("leaves an existing status alone", () => {
    const body = { input: [{ type: "function_call", status: "in_progress", call_id: "c1" }] };
    expect(repairArkInput(body)).toBe(0);
    expect((body.input[0] as { status: string }).status).toBe("in_progress");
  });

  it("ignores item types Ark does not validate", () => {
    const body = { input: [{ type: "item_reference", id: "x" }] };
    expect(repairArkInput(body)).toBe(0);
    expect(body.input[0]).not.toHaveProperty("status");
  });

  it("tolerates bodies without an input array", () => {
    expect(repairArkInput({})).toBe(0);
    expect(repairArkInput({ input: "not-an-array" as unknown as unknown[] })).toBe(0);
  });
});
