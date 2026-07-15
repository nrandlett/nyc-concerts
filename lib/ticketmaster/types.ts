// Type definitions for the slice of the Ticketmaster Discovery API we consume.
//
// The real API responses are HUGE (dozens of fields per object). We only type
// the fields we actually read, and mark most as optional, because Ticketmaster
// omits fields freely depending on the record. Treating everything we don't
// strictly need as optional keeps us from crashing on a missing field.

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

export type TmVenue = {
  id: string;
  name: string;
  url?: string;
  city?: { name?: string };
  state?: { name?: string; stateCode?: string };
  postalCode?: string;
  address?: { line1?: string };
  location?: { latitude?: string; longitude?: string };
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// A performer on an event. Ticketmaster calls these "attractions".
export type TmAttraction = {
  id: string;
  name: string;
  url?: string;
  // Genre info lives under classifications; we read the top-level genre name.
  classifications?: Array<{
    genre?: { name?: string };
    segment?: { name?: string };
  }>;
};

export type TmEvent = {
  id: string;
  name: string;
  url?: string;
  dates?: {
    start?: {
      // localDate is "YYYY-MM-DD"; dateTime is a full UTC ISO timestamp.
      // dateTime is absent for events with no announced start time.
      localDate?: string;
      localTime?: string;
      dateTime?: string;
    };
    status?: { code?: string }; // e.g. "onsale", "cancelled", "postponed"
  };
  priceRanges?: Array<{ min?: number; max?: number; currency?: string }>;
  // Related objects (venues, attractions) are nested under _embedded.
  _embedded?: {
    venues?: TmVenue[];
    attractions?: TmAttraction[];
  };
};

// ---------------------------------------------------------------------------
// Envelope shapes
// ---------------------------------------------------------------------------

// Ticketmaster wraps list results in a HAL-style envelope: the actual array
// lives under _embedded, and paging info under page.
export type TmPage = {
  size: number;
  totalElements: number;
  totalPages: number;
  number: number; // zero-based current page index
};

export type TmVenueSearchResponse = {
  _embedded?: { venues?: TmVenue[] };
  page?: TmPage;
};

export type TmEventSearchResponse = {
  _embedded?: { events?: TmEvent[] };
  page?: TmPage;
};
