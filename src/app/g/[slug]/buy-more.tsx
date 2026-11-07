"use client";

// Turns on photo selection in the gallery grid (5.7). The grid listens for
// this event, so the sidebar can stay a server component.
export const SELECT_EVENT = "proofer:gallery-select";

export function BuyMoreButton() {
  return (
    <button type="button" className="gbuy-btn" onClick={() => window.dispatchEvent(new Event(SELECT_EVENT))}>
      Buy more downloads
    </button>
  );
}
