Something an agent wrote that a person may act on. `vz-claim`: it must be impossible to take for a fact the system measured.

Anatomy, in order:

1. **Provenance line** (`vz-claim-by`, `label` type in `ink`): "Agent's claim", the agent's stated confidence, and the verification state as a `vz-status`: "Not verified" (the dash) until a person rules on it, then "Confirmed by Dana at 15:20" (the acknowledged mark) or "Rejected by Dana at 15:20" (the ruled-out mark). This line is part of every claim, not of the page: at 400px the page head has scrolled away.
2. **The claim** (`vz-claim-text`, `body` type): one or two sentences. Only the subject is strong (`b`); the sentence is not, because weight says "established".
3. **Evidence** (`vz-claim-evidence`): a label saying it is the query the agent ran and the range it read, the query in a `vz-query`, and the link "Open the query in Explore". Every claim has its query, including what the agent ruled out. A claim without evidence is not shown as a claim; it goes under "Could not check".
4. **Verdict**: "Confirm claim" and "Reject claim" as small default buttons, replaced in place by "Undo" once given. They record a person's judgement; they change nothing else, and the page says so.

Rules:

- The `stroke`-wide `ink-muted` rule down the left edge marks agent-written text everywhere. Nothing else in the system has a left rule. Shorter agent text outside a claim (a banner sentence, a history line) takes `vz-agent`, starts with "Agent:", and carries the same "Not verified" until a person confirms the claim it comes from.
- Agent text never appears in a `vz-stat`, a table cell of measurements, a page title or a status word without that marking.
- A chart beside a claim says whose view it is: "12:00 to 13:09, as the agent read it", with a link to see it now.
- "Ruled out" is a `vz-status` with the ruled-out mark, never the unknown dash.
- States: not verified, confirmed, rejected (text drops to `ink-secondary`; the claim stays readable), and the agent's own ruled-out.
