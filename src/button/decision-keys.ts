/** What the question card is told about the keys, from the frame's own facts. */
export type DecisionKeys = Readonly<{
  /** The card, not the composer, holds the keys. */
  hasKeys: boolean;
  /** Nothing can take a key press now: the pane is unfocused or a dialog is open. */
  paused: boolean;
  /** A press would land on the card: it holds the keys and nothing is paused. */
  active: boolean;
}>;

/**
 * Who holds the keys and whether any press can land. While paused, no key does
 * anything for either owner, so the card names none; otherwise the card names
 * the key that matters to whoever does not hold them.
 */
export function decisionKeys(
  facts: Readonly<{
    focused: boolean;
    dialogOpen: boolean;
    cardHasKeys: boolean;
  }>,
): DecisionKeys {
  const paused = !facts.focused || facts.dialogOpen;
  return {
    hasKeys: facts.cardHasKeys,
    paused,
    active: !paused && facts.cardHasKeys,
  };
}
