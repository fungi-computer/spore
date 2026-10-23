/** Evidence from the actual replacement launcher and its rendered terminal. */
export function hasLiveReplacementDraft({
  invocations,
  frame,
  draft,
  sessionId,
  buildId,
}) {
  const resumes = invocations.filter(
    (entry) => entry.args[1] === "sessions" && entry.args[2] === "resume",
  );
  return (
    resumes.length === 2 &&
    resumes[1].build === buildId &&
    resumes.every((entry) => entry.args[3] === sessionId) &&
    frame.includes(draft) &&
    // TuiFrameConversation renders useStatus().viewState in the last row.
    // Parakeet cannot produce idle while its observation is connecting or
    // unavailable. This empty, unsubmitted Session must positively reach idle.
    frame.split("\n").at(-1)?.trim() === "● idle" &&
    !frame.includes("Restart to update")
  );
}
