# Interactive prototype contract

A mockup called interactive must let the reviewer exercise its important flow. Decorative buttons should either work, explain the simulated outcome, or be visibly disabled.

## Annotation targets

Add stable targets to meaningful regions:

```html
<section data-review-target="invoice-summary" data-review-label="Invoice summary">
```

When annotation mode is off, the iframe behaves normally. When it is on, Assistant Workspace intercepts clicks on these targets and opens the feedback form. Mockup CSS should visibly outline targets under `.review-annotation-mode`.

## Navigate between authored screens

The review shell accepts same-origin messages:

```js
window.parent.postMessage(
  { type: "assistant-workspace:navigate", mockId: "confirmation" },
  location.origin
);
```

This keeps the sidebar, current-screen description and annotation ownership in sync. Provide a normal relative-link fallback if the mockup must also work when opened alone.

Navigation messages may also carry mock-specific context such as `section` or `mode`. After switching screens, the shell forwards that payload as an `assistant-workspace:navigation-context` message to the destination frame. The destination should use it to open the requested tab or view instead of always showing its default state.

When a Final Review connects screens from different source rounds, identify the source explicitly:

```js
window.parent.postMessage(
  {
    type: "assistant-workspace:navigate",
    sourceReview: "round-3",
    sourceMock: "invoice-trace"
  },
  location.origin
);
```

The shell then changes the outer screen selection, URL hash and annotation ownership together. Navigation messages are accepted only from the shell's own origin.

## Simulated writes

Never let a prototype silently call production services. Simulate the result in local UI, and label it clearly. Preview/confirm interactions should still enforce the intended confirmation rule so reviewers can assess the actual friction.

## Minimum interaction check

Before publishing a round, exercise:

- every primary button;
- filters and state changes;
- forward and back navigation;
- validation and confirmation gates;
- annotation mode on each screen;
- mobile or narrow viewport behavior if claimed by the round.
