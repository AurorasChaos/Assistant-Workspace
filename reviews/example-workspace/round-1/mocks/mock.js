const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let timer;

function toast(message) {
  const element = $("#toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => element.classList.remove("show"), 2200);
}

document.addEventListener("click", (event) => {
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    $$("[data-filter]").forEach((button) => button.classList.toggle("active", button === filter));
    $$("[data-event-state]").forEach((row) => { row.hidden = filter.dataset.filter !== "all" && row.dataset.eventState !== filter.dataset.filter; });
  }
  const eventRow = event.target.closest("[data-event]");
  if (eventRow) {
    $$("[data-event]").forEach((row) => row.classList.toggle("selected", row === eventRow));
    const title = $("#selected-title"); if (title) title.textContent = eventRow.dataset.event;
    const detail = $("#event-detail"); if (detail) detail.hidden = false;
    const empty = $("#detail-empty"); if (empty) empty.hidden = true;
  }
  const person = event.target.closest("[data-person]");
  if (person) {
    $$("[data-person]").forEach((row) => row.classList.toggle("selected", row === person));
    const selected = $("#selected-person"); if (selected) selected.textContent = person.dataset.person;
  }
  const navigate = event.target.closest("[data-navigate]");
  if (navigate) window.parent.postMessage({ type: "assistant-workspace:navigate", mockId: navigate.dataset.navigate }, location.origin);
  const action = event.target.closest("[data-message]");
  if (action) toast(action.dataset.message);
});

document.documentElement.dataset.demoReady = "true";
