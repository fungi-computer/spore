import { expect, test } from "bun:test";
import type { Cli } from "@fungi.computer/lantern";
import type { LocalLoginProvider } from "@fungi.computer/truffle/login";
import {
  chooseSignInDoor,
  chooseSubscription,
  subscriptionChoices,
} from "../src/sign-in-choice.js";

const chatgpt: LocalLoginProvider = {
  id: "openai",
  name: "OpenAI",
  methods: [
    { kind: "api_key", label: "OpenAI API key" },
    { kind: "subscription", label: "Sign in with ChatGPT" },
  ],
};

/** A select that records what it offered and picks the first option. */
function picker() {
  const seen: { value: unknown; label: string | undefined }[][] = [];
  const cli: Pick<Cli, "select"> = {
    select: (question) => {
      seen.push(
        question.options.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      );
      return Promise.resolve(question.options[0]?.value ?? Symbol("none"));
    },
  };
  return { seen, cli };
}

test("the subscription door names the plan the sign-in names, not its provider", async () => {
  const choices = subscriptionChoices([chatgpt]);
  expect(choices).toEqual([
    { providerId: "openai", name: "ChatGPT", label: "Sign in with ChatGPT" },
  ]);
  const { cli, seen } = picker();
  await chooseSignInDoor(cli, { allowSkip: false, subscriptions: choices });
  expect(seen[0]?.map((door) => door.label)).toEqual([
    "Use my ChatGPT subscription (recommended)",
    "Sign in to Fungi",
    "Use an API key",
  ]);
});

test("an extension's sign-in joins the door without its provenance suffix, and is chosen by provider", async () => {
  const choices = subscriptionChoices([
    chatgpt,
    {
      id: "anthropic",
      name: "Anthropic",
      methods: [
        { kind: "api_key", label: "Anthropic API key" },
        {
          kind: "subscription",
          label: "Anthropic (Claude Pro/Max) · from claude-subscription",
        },
      ],
    },
    {
      id: "fungi",
      name: "Fungi",
      methods: [{ kind: "subscription", label: "Sign in to Fungi" }],
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      methods: [{ kind: "api_key", label: "DeepSeek API key" }],
    },
  ]);
  expect(choices.map((choice) => choice.name)).toEqual([
    "ChatGPT",
    "Anthropic (Claude Pro/Max)",
  ]);
  const { cli, seen } = picker();
  await chooseSignInDoor(cli, { allowSkip: true, subscriptions: choices });
  expect(seen[0]?.[0]?.label).toBe(
    "Use my ChatGPT or Anthropic (Claude Pro/Max) subscription (recommended)",
  );
  expect(await chooseSubscription(cli, choices)).toBe("openai");
});

test("one offered subscription needs no question, and none leaves no door", async () => {
  const { cli, seen } = picker();
  expect(await chooseSubscription(cli, subscriptionChoices([chatgpt]))).toBe(
    "openai",
  );
  expect(seen).toEqual([]);
  await chooseSignInDoor(cli, { allowSkip: false, subscriptions: [] });
  expect(seen[0]?.map((door) => door.value)).toEqual(["fungi", "api_key"]);
});
