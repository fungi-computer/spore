import { isCancel, type Cli } from "@fungi.computer/lantern";
import type { LocalLoginProvider } from "@fungi.computer/truffle/login";

/** The ways a person can give their agent a model. */
export type SignInDoor = "fungi" | "subscription" | "api_key";

/** One provider whose subscription sign-in Local offers right now. */
export type SubscriptionChoice = Readonly<{
  providerId: string;
  /** The plan as the sign-in names it: "ChatGPT", not its provider "OpenAI". */
  name: string;
  /** The sign-in's own label, as its provider or extension names it. */
  label: string;
}>;

/**
 * The plan a sign-in entry names. The entry's label is what people see in
 * /login ("Sign in with ChatGPT"); an extension's provenance suffix
 * ("... · from <id>") says who supplied it, not which plan it is.
 */
function planName(label: string): string {
  return label.replace(/ · from .+$/u, "").replace(/^Sign in with /u, "");
}

/**
 * The subscription sign-ins in the login registry, so the doors follow what
 * Local actually offers: a built-in provider, or one an extension supplies.
 * Fungi's own account has its own door.
 */
export function subscriptionChoices(
  registry: readonly LocalLoginProvider[],
): readonly SubscriptionChoice[] {
  return registry.flatMap((provider) => {
    const method = provider.methods.find((one) => one.kind === "subscription");
    return provider.id === "fungi" || method === undefined
      ? []
      : [
          {
            providerId: provider.id,
            name: planName(method.label),
            label: method.label,
          },
        ];
  });
}

/** "ChatGPT", "ChatGPT or Anthropic (Claude Pro/Max)", or nothing when no subscription is offered. */
export function subscriptionNames(
  choices: readonly SubscriptionChoice[],
): string {
  return choices.map((choice) => choice.name).join(" or ");
}

/** One question for first run and bare `fungi login`. Undefined means cancelled. */
export async function chooseSignInDoor(
  cli: Pick<Cli, "select">,
  options: Readonly<{
    allowSkip: boolean;
    subscriptions: readonly SubscriptionChoice[];
  }>,
): Promise<SignInDoor | "later" | undefined> {
  const doors: { value: SignInDoor | "later"; label: string; hint?: string }[] =
    [];
  if (options.subscriptions.length > 0)
    doors.push({
      value: "subscription",
      label: `Use my ${subscriptionNames(options.subscriptions)} subscription (recommended)`,
    });
  doors.push(
    {
      value: "fungi",
      label: "Sign in to Fungi",
      hint: "Your Fungi account and Team",
    },
    { value: "api_key", label: "Use an API key" },
  );
  if (options.allowSkip) doors.push({ value: "later", label: "Skip for now" });
  const door = await cli.select({
    message: "How should Shiitake reach a model?",
    options: doors,
  });
  return isCancel(door) ? undefined : door;
}

/** Which subscription to sign in to; one offered subscription needs no question. */
export async function chooseSubscription(
  cli: Pick<Cli, "select">,
  choices: readonly SubscriptionChoice[],
): Promise<string | undefined> {
  const [only] = choices;
  if (choices.length === 1 && only !== undefined) return only.providerId;
  const provider = await cli.select({
    message: "Which subscription should Shiitake use?",
    options: choices.map((choice) => ({
      value: choice.providerId,
      label: choice.name,
      hint: choice.label,
    })),
  });
  return isCancel(provider) ? undefined : provider;
}
