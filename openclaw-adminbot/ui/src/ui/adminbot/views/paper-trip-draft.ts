// The travel form's starting values, from the stored trip (if any).
//
// Split from paper-cycle.ts so the shell can seed a draft without loading the paper card itself.
/** One member's own plan for the conference this paper was accepted to. */
export type PaperTrip = {
  conference_key: string;
  member_id: string;
  intent: "going" | "undecided";
  funding: "none" | "fee_only" | "flight_only" | "full_travel";
  needs_lodging: boolean;
  arrival_on?: string;
  departure_on?: string;
  needs_visa_letter: boolean;
  notes?: string;
};

export type PaperTripDraft = {
  intent: PaperTrip["intent"];
  funding: PaperTrip["funding"];
  needs_lodging: boolean;
  needs_visa_letter: boolean;
  arrival_on: string;
  departure_on: string;
  notes: string;
};

export function paperTripDraftFrom(trip: PaperTrip | null | undefined): PaperTripDraft {
  return {
    // Undecided rather than going: a form that opens on "yes" collects agreement rather than an
    // answer, and this one books flights.
    intent: trip?.intent ?? "undecided",
    funding: trip?.funding ?? "none",
    needs_lodging: trip?.needs_lodging ?? false,
    needs_visa_letter: trip?.needs_visa_letter ?? false,
    arrival_on: trip?.arrival_on ?? "",
    departure_on: trip?.departure_on ?? "",
    notes: trip?.notes ?? "",
  };
}
