import { isCancel, type Cli } from "@fungi.computer/lantern";

/** The ways a person can give their agent a model. */
export type SignInDoor = "fungi" | "subscription" | "api_key";

/** One question for first run and bare `fungi login`. Undefined means cancelled. */
export async function chooseSignInDoor(
  cli: Pick<Cli, "select">,
  options: Readonly<{ allowSkip: boolean }>,
): Promise<SignInDoor | "later" | undefined> {
  const doors: { value: SignInDoor | "later"; label: string; hint?: string }[] =
    [
      {
        value: "subscription",
        label: "Use my Claude or ChatGPT subscription (recommended)",
      },
      {
        value: "fungi",
        label: "Sign in to Fungi",
        hint: "Your Fungi account and Team",
      },
      { value: "api_key", label: "Use an API key" },
    ];
  if (options.allowSkip) doors.push({ value: "later", label: "Skip for now" });
  const door = await cli.select({
    message: "How should Shiitake reach a model?",
    options: doors,
  });
  return isCancel(door) ? undefined : door;
}

/** The consumer plans Shiitake can use; each provider runs its own browser sign-in. */
const subscriptions = [
  { value: "anthropic", label: "Claude", hint: "Pro or Max plan" },
  { value: "openai", label: "ChatGPT", hint: "Plus or Pro plan" },
] as const;

export type SubscriptionProvider = (typeof subscriptions)[number]["value"];

export async function chooseSubscription(
  cli: Pick<Cli, "select">,
): Promise<SubscriptionProvider | undefined> {
  const provider = await cli.select({
    message: "Which subscription should Shiitake use?",
    options: [...subscriptions],
  });
  return isCancel(provider) ? undefined : provider;
}
