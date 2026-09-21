import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { hostEditFile } from "../src/host-breakglass/edit-file.js";

const roots = new Set<string>();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gpt-host-edit-"));
  roots.add(root);
  const context = createHostBreakglassContext(HostBreakglassConfigSchema.parse({
    enabled: true,
    mode: "safe",
    roots: [{ id: "test", root, read: true, write: true, execute: true }]
  }));
  return { root, context };
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("host_edit_file postconditions", () => {
  it("verifies a source-like multiline literal edit and returns bounded evidence", async () => {
    const { root, context } = await fixture();
    const file = join(root, "source.ts");
    const before = [
      "function matcher() {",
      "  const expression = /a+b?/gi;",
      "  return expression.test('aaab');",
      "}",
      ""
    ].join("\n");
    const oldText = "  const expression = /a+b?/gi;\n  return expression.test('aaab');";
    const newText = "  const expression = /a+b?/g;\n  return expression.test('aab');";
    await writeFile(file, before, "utf8");
    const preSha256 = createHash("sha256").update(before).digest("hex");

    const result = await hostEditFile(context, {
      path: file,
      old_text: oldText,
      new_text: newText,
      expected_sha256: preSha256
    });

    const post = await readFile(file, "utf8");
    const postSha256 = createHash("sha256").update(post).digest("hex");
    expect(result.replacement_count).toBe(1);
    expect(result.pre_sha256).toBe(preSha256);
    expect(result.post_sha256).toBe(postSha256);
    expect(result.matched_spans).toHaveLength(1);
    expect(result.matched_spans_truncated).toBe(false);
    expect(result.postcondition).toMatchObject({
      verified: true,
      method: "cas-claim+full-reread-sha256",
      expected_post_sha256: postSha256
    });
    expect(post).toContain(newText);
    expect(post).not.toContain(oldText);
  });

  it("treats single replacement text as literal even when it contains dollar sequences", async () => {
    const { root, context } = await fixture();
    const file = join(root, "literal-dollar.txt");
    await writeFile(file, "alpha\n", "utf8");
    const newText = "$& $$ value";

    const result = await hostEditFile(context, {
      path: file,
      old_text: "alpha",
      new_text: newText
    });

    expect(await readFile(file, "utf8")).toBe(newText + "\n");
    expect(result.postcondition.verified).toBe(true);
  });

  it("fails closed on zero matches, duplicate default matches, and stale hashes", async () => {
    const { root, context } = await fixture();
    const file = join(root, "target.txt");
    await writeFile(file, "same\nsame\n", "utf8");

    await expect(hostEditFile(context, {
      path: file,
      old_text: "missing",
      new_text: "new"
    })).rejects.toThrow(/not found/i);
    expect(await readFile(file, "utf8")).toBe("same\nsame\n");

    await expect(hostEditFile(context, {
      path: file,
      old_text: "same",
      new_text: "new"
    })).rejects.toThrow(/occurs 2 times/i);
    expect(await readFile(file, "utf8")).toBe("same\nsame\n");

    await expect(hostEditFile(context, {
      path: file,
      old_text: "same",
      new_text: "new",
      replace_all: true,
      expected_sha256: "0".repeat(64)
    })).rejects.toThrow(/File changed/i);
    expect(await readFile(file, "utf8")).toBe("same\nsame\n");
  });

  it("does not clobber a writer that changes the file after the initial read", async () => {
    const { root, context } = await fixture();
    const file = join(root, "race.txt");
    await writeFile(file, "alpha\n", "utf8");

    await expect(hostEditFile(context, {
      path: file,
      old_text: "alpha",
      new_text: "beta"
    }, {
      beforeCommit: async () => {
        await writeFile(file, "external\n", "utf8");
      }
    })).rejects.toThrow(/changed during edit/i);

    expect(await readFile(file, "utf8")).toBe("external\n");
    expect((await readdir(root)).filter((name) => name.endsWith(".edit.bak"))).toHaveLength(0);
  });

  it("does not overwrite a writer that recreates the path during the commit claim", async () => {
    const { root, context } = await fixture();
    const file = join(root, "claim-race.txt");
    await writeFile(file, "alpha\n", "utf8");

    await expect(hostEditFile(context, {
      path: file,
      old_text: "alpha",
      new_text: "beta"
    }, {
      afterClaim: async () => {
        await writeFile(file, "contender\n", "utf8");
      }
    })).rejects.toThrow(/Concurrent writer recreated|preserved/i);

    expect(await readFile(file, "utf8")).toBe("contender\n");
    const backups = (await readdir(root)).filter((name) => name.endsWith(".edit.bak"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(root, backups[0]), "utf8")).toBe("alpha\n");
  });

  it("reports replace-all count while bounding span evidence", async () => {
    const { root, context } = await fixture();
    const file = join(root, "many.txt");
    await writeFile(file, Array.from({ length: 12 }, () => "old").join("|"), "utf8");

    const result = await hostEditFile(context, {
      path: file,
      old_text: "old",
      new_text: "new",
      replace_all: true
    });

    expect(result.replacement_count).toBe(12);
    expect(result.matched_spans).toHaveLength(8);
    expect(result.matched_spans_truncated).toBe(true);
    expect(result.postcondition.verified).toBe(true);
    expect(await readFile(file, "utf8")).not.toContain("old");
  });
});
