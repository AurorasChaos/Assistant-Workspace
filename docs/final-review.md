# Final Review rule

Every workspace must end with a distinct **Final Review** before implementation authorization is requested.

A Final Review contains:

- every accepted mockup from every source round, with its interactions still usable;
- a consolidated settled-decision register, linked to each source round and question;
- the generated final specification as a `final-spec` artifact;
- contradictions, corrections or unresolved points stated explicitly;
- one final acceptance question.

Set `"kind": "final"` and list every numbered round under `sourceReviews`. Every reused mock identifies `sourceReview` and `sourceMock`; every settled decision identifies `sourceReview` and `sourceQuestion`. `npm run validate` fails when a source mock or source question is absent.

If Final Review requests a material design change, create the next numbered round and then replace/supersede the Final Review. Do not revise the accepted history silently.

Completing Final Review closes the design artifact only. The agent must then ask separately and explicitly whether to start implementation.

