// Generated from 'Jinesis Contact_Paper list with Zhijing (4).xlsx' by scripts/adminbot-contact-roster-collect.py.
// Do not hand-edit; regenerate instead.
//
// The lab's contact list and access policy as the spreadsheet states them. This file is the
// *expectation* side of the conformance tests: where it and the service disagree, the sheet is
// what the lab decided and the service is what it actually got.
//
// Phone numbers and free-text notes are deliberately not carried here -- only the fields the
// tests assert on.

/** Collaborator subgroups the access sheet has a column for. */
export const CONTACT_SHEET_SUBGROUPS = [
  "acquaintance",
  "alumni",
  "coauthor_discussant_designer",
  "coauthor_major",
  "coauthor_minor",
  "disappearing_coauthor",
  "external_prof",
  "interviewee",
  "own_pace_advisee",
  "slightly_better_than_emails"
] as const;

export type ContactSheetAccessItem = {
  /** The sheet's own wording for the row, which is how a failure points back at a cell. */
  label: string;
  cells: Record<(typeof CONTACT_SHEET_SUBGROUPS)[number], string>;
};

/** The access matrix, in sheet row order. */
export const CONTACT_ACCESS_MATRIX: readonly ContactSheetAccessItem[] = [
  {
    "label": "onboarding email",
    "cells": {
      "slightly_better_than_emails": "yes",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "yes",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "yes",
      "external_prof": "yes",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "If their profile should be in our Back-end spreadsheet in full details",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "yes",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "In our back-end spreadsheet: we store their email, roughly tldr background (PhD, Prof, … intersecting with us for XX)",
    "cells": {
      "slightly_better_than_emails": "yes",
      "acquaintance": "yes",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "no",
      "coauthor_minor": "yes",
      "coauthor_major": "no",
      "disappearing_coauthor": "yes",
      "external_prof": "yes",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "welcome linkedin and twitter followings",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "yes",
      "alumni": "yes",
      "interviewee": "yes",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "Welcome newsletter subscriptions + all other types of followings",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "yes",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "Send emails to confirm their time plan (i.e., let them use Luke’s function and share with Zhijing on slack or email)",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "no",
      "coauthor_minor": "no",
      "coauthor_major": "no",
      "disappearing_coauthor": "yes",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "Have AdminBot portal access",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "yes",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "no",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "Trusted for lab private info",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "no",
      "coauthor_minor": "no",
      "coauthor_major": "no",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "Issue a check condition: If they do not have main slack space, Link to Jinesis free slack space for slack-guest-chat group in DCS with the interviewer and project collaborators they can chat with",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "yes",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "no",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "Join Jinesis #friends-and-collaborators… through Slack Connect",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "yes",
      "alumni": "yes",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "yes",
      "external_prof": "yes",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "Add them to #jinesis-active and #random-active both channels",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "no",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "Slack-guest-chat with Zhijing & interviewer",
    "cells": {
      "slightly_better_than_emails": "yes",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "yes",
      "own_pace_advisee": "no",
      "coauthor_minor": "no",
      "coauthor_major": "no",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "Add to #discussion-xxx for joining the discussions on this broad topic",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "Add to #proj-xxx channel so we can chat with this person on this specific project",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "no",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "Has access to our project-related google drive folder (Or create it if not exist)",
    "cells": {
      "slightly_better_than_emails": "yes",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "yes",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "Add to slack channel #meeting-xxx for the weekly themed meeting, and also Wed themed meeting’s calendar invite. (Slack + calendar)\n\nWhoever that is on our calendar invite will be repeatedly reminded to use the Google Calendar app interface with alert, and ignore calendar related emails, due to all the complex time zones and spontaneous move of meetings.",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "no",
      "coauthor_minor": "no",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "In our back-end spreadsheet, we need their Whatsapp + personal email (invariant to graduation) stored in our database (e.g., for paper resubmission)",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "yes",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "no",
      "coauthor_major": "no",
      "disappearing_coauthor": "yes",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "If newly joined (history less than 3 months), introduce More detailed google drive practice",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "no",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "compose stories for “What to Expect”. Handbook about the communication protocols",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "yes_separate",
      "own_pace_advisee": "yes_separate",
      "coauthor_minor": "yes_separate",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "Allow email triggers in the backend for “paper submission / resubmission”, “social media draft sharing”, etc.\n\nData structure: user_id + set of proj_id",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "no",
      "coauthor_minor": "no",
      "coauthor_major": "no",
      "disappearing_coauthor": "no",
      "external_prof": "yes",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "auto share with Daniel the list of our “coauthor-major” and “full members” as a constantly updating spreadsheet with only each person’s name and UToronto email (or professional email address).\n\nIn this way, we suggest Daniel to look up the users in our spreadsheet whenever he needs to decide whether to extend or to remove our user.",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "no",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "no",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  },
  {
    "label": "city-based dinner or team building invite",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "yes",
      "alumni": "yes",
      "interviewee": "yes",
      "own_pace_advisee": "yes",
      "coauthor_minor": "yes",
      "coauthor_major": "yes",
      "disappearing_coauthor": "no",
      "external_prof": "no",
      "coauthor_discussant_designer": "yes"
    }
  },
  {
    "label": "Rec letter button on their profile (allowed only for those with a major-coauthor status or own-pace-advisee for over 3 months at any historical point)",
    "cells": {
      "slightly_better_than_emails": "no",
      "acquaintance": "no",
      "alumni": "yes",
      "interviewee": "no",
      "own_pace_advisee": "yes",
      "coauthor_minor": "case_by_case",
      "coauthor_major": "yes",
      "disappearing_coauthor": "auto_decline",
      "external_prof": "no",
      "coauthor_discussant_designer": "no"
    }
  }
];

export type ContactSheetMember = {
  /** `normalizePersonName(name)` -- what a roster row is matched on. */
  key: string;
  name: string;
  sources: string[];
  fields: Record<string, string>;
};

/** Every person the lab has a contact record for, from both people sheets. */
export const CONTACT_MEMBERS: readonly ContactSheetMember[] = [
  {
    "key": "abhinav lalwani",
    "name": "Abhinav Lalwani",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "abir harrasse",
    "name": "Abir Harrasse",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-01-01",
      "location": "Tangier, Morocco (soon to be Zurich)",
      "correspondence_email": "abirharrasse@gmail.com",
      "twitter": "@AHarrasse1906",
      "calendar_email": "abirharrasse@gmail.com",
      "openreview": "~Abir_HARRASSE1",
      "github": "abirharrasse",
      "linkedin": "https://www.linkedin.com/in/abir-harrasse-a5120b20a/?locale=fr",
      "website": "https://abirharrasse.github.io/"
    }
  },
  {
    "key": "acl mentorship co organizers oana weijia martin",
    "name": "ACL Mentorship co-organizers: Oana, Weijia, Martin",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "aheli poddar",
    "name": "Aheli Poddar",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "ahelipoddar2003@gmail.com"
    }
  },
  {
    "key": "alexander",
    "name": "alexander",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "alexander@herhjemme.dk"
    }
  },
  {
    "key": "aly kassem",
    "name": "Aly Kassem",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "alykassem@cs.toronto.edu"
    }
  },
  {
    "key": "aman gokrani",
    "name": "Aman Gokrani",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Europe/Amsterdam",
      "correspondence_email": "agokrani@cs.toronto.edu"
    }
  },
  {
    "key": "amber",
    "name": "amber",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "amber@reality.design"
    }
  },
  {
    "key": "andre santos",
    "name": "Andre Santos",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "andrei muresanu",
    "name": "Andrei Muresanu",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-09-01",
      "location": "Toronto",
      "correspondence_email": "andrei.muresanu@uwaterloo.ca",
      "twitter": "@_AndreiMuresanu",
      "calendar_email": "andrei.muresanu@uwaterloo.ca",
      "openreview": "~Andrei_Ioan_Muresanu1",
      "github": "AndreiMuresanu",
      "linkedin": "https://www.linkedin.com/in/andreimuresanu/",
      "website": "https://andreimuresanu.com/"
    }
  },
  {
    "key": "andrew kim",
    "name": "Andrew Kim",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-04-01",
      "location": "Toronto",
      "correspondence_email": "andrewkihyun@gmail.com",
      "twitter": "@andrewkihyun",
      "openreview": "Andrew_Kim3",
      "github": "akhkim",
      "linkedin": "andrew-kh-kim"
    }
  },
  {
    "key": "andy liu",
    "name": "Andy Liu",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "anupam chettimada",
    "name": "Anupam Chettimada",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Toronto",
      "correspondence_email": "a.chettimada@mail.utoronto.ca",
      "twitter": "@achettimada",
      "calendar_email": "anupamchettimada67@gmail.com",
      "openreview": "~Anupam_Chettimada1",
      "github": "Anupam-Anupam",
      "linkedin": "https://www.linkedin.com/in/anupamchettimada/"
    }
  },
  {
    "key": "arian khorasani",
    "name": "Arian Khorasani",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-05-01",
      "location": "Mainly Montreal (can visit Toronto too, whenever is needed)",
      "correspondence_email": "Arian.Khorasani@umontreal.ca / Ariankhorasani1@gmail.com",
      "twitter": "https://x.com/Arian_Khorasani",
      "calendar_email": "Ariankhorasani1@gmail.com",
      "openreview": "~Arian_Khorasani1",
      "github": "https://github.com/ArianKhorasani",
      "linkedin": "https://www.linkedin.com/in/arian-khorasani96/",
      "website": "https://sites.google.com/view/ariankhorasani/home"
    }
  },
  {
    "key": "arka",
    "name": "arka",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "arka@cs.toronto.edu"
    }
  },
  {
    "key": "arkadiusz modezelewski",
    "name": "Arkadiusz Modezelewski",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "arth singh",
    "name": "Arth Singh",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-04-01",
      "location": "Mumbai, India",
      "correspondence_email": "arth.collab@gmail.com",
      "twitter": "@iarthsingh",
      "calendar_email": "arth.collab@gmail.com",
      "openreview": "~Arth_Singh1",
      "github": "arth-singh",
      "linkedin": "https://www.linkedin.com/in/arthsingh7in",
      "website": "arthsingh.com"
    }
  },
  {
    "key": "aryan amit barsainyan",
    "name": "Aryan Amit Barsainyan",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-04-01",
      "location": "Bengaluru, India",
      "correspondence_email": "aryan.barsainyan@gmail.com",
      "calendar_email": "aryan.barsainyan@gmail.com",
      "github": "ary2260",
      "linkedin": "https://www.linkedin.com/in/aryan-ab",
      "website": "in progress!"
    }
  },
  {
    "key": "atirath chunduri",
    "name": "Atirath Chunduri",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "New Jersey",
      "correspondence_email": "achundur1@stevens.edu",
      "twitter": "@atirathc",
      "calendar_email": "achundur1@stevens.edu",
      "github": "Ati06",
      "linkedin": "https://www.linkedin.com/in/atirath-ch-084073277/"
    }
  },
  {
    "key": "ayush nangia",
    "name": "Ayush Nangia",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Bangalore, India",
      "correspondence_email": "ayushnangia16@gmail.com",
      "twitter": "@vitransformer",
      "calendar_email": "ayushnangia16@gmail.com",
      "openreview": "Ayush_Nangia1",
      "github": "https://github.com/ayushnangia",
      "linkedin": "https://www.linkedin.com/in/ayush-nangia/",
      "website": "https://vitransformer.netlify.app/"
    }
  },
  {
    "key": "beckett sands",
    "name": "Beckett Sands",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Chicago",
      "correspondence_email": "Beckettsands2025@u.northwestern.edu"
    }
  },
  {
    "key": "bryan liu",
    "name": "Bryan Liu",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-10-01",
      "location": "Toronto",
      "correspondence_email": "bryanliu@cs.toronto.edu",
      "calendar_email": "bryanliu2468@gmail.com",
      "openreview": "~Bryan_Liu2",
      "github": "bryanliu08",
      "linkedin": "https://www.linkedin.com/in/bryan-liu-525237304/",
      "website": "bryanli08.github.io"
    }
  },
  {
    "key": "calum murray",
    "name": "Calum Murray",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "camilla andreozzi",
    "name": "Camilla Andreozzi",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "chaimae abouzahir",
    "name": "Chaimae Abouzahir",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Africa/Casablanca",
      "correspondence_email": "ca2627@nyu.edu"
    }
  },
  {
    "key": "changling li",
    "name": "Changling Li",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-04-01",
      "location": "Zurich",
      "correspondence_email": "xaviercll1998@gmail.com",
      "twitter": "@ChanglingXavier",
      "calendar_email": "xaviercll1998@gmail.com",
      "openreview": "Changling_Li2",
      "github": "XavierChanglingLi",
      "linkedin": "https://www.linkedin.com/in/changlingli1998/",
      "website": "https://changlingli.com/"
    }
  },
  {
    "key": "chijioke ugwuany",
    "name": "Chijioke Ugwuany",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Kigali, Rwanda",
      "correspondence_email": "cj.ugwuanyi@gmail.com",
      "twitter": "maziugwuanyi",
      "calendar_email": "cj.ugwuanyi@gmail.com",
      "openreview": "Chijioke_Ugwuanyi1",
      "github": "https://github.com/xplorer1",
      "linkedin": "https://linkedin.com/in/chijiokeugwuanyi13",
      "website": "https://xplorer1.github.io"
    }
  },
  {
    "key": "colomban duclaux",
    "name": "Colomban Duclaux",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Zurich",
      "correspondence_email": "colomban.duclaux@gmail.com",
      "calendar_email": "colomban.duclaux@gmail.com",
      "github": "ColombanD",
      "linkedin": "https://www.linkedin.com/in/colomban-duclaux-b6bba0297",
      "website": "https://github.com/ColombanD"
    }
  },
  {
    "key": "connor caserio",
    "name": "Connor Caserio",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Chicago",
      "correspondence_email": "connor.caserio@northwestern.edu"
    }
  },
  {
    "key": "damiano amatruda",
    "name": "Damiano Amatruda",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-02-01",
      "location": "Zürich",
      "correspondence_email": "damiano.amatruda@gmail.com",
      "calendar_email": "damiano.amatruda@gmail.com",
      "openreview": "Damiano_Amatruda1",
      "github": "https://github.com/damianoamatruda",
      "linkedin": "https://www.linkedin.com/in/damiano-amatruda/"
    }
  },
  {
    "key": "david guzman piedrahita",
    "name": "David Guzman Piedrahita",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "Sept 2024",
      "location": "Zurich",
      "correspondence_email": "davidguzman1120@gmail.com",
      "twitter": "davidguzman1120",
      "calendar_email": "davidguzman1120@gmail.com",
      "openreview": "~David_Guzman_Piedrahita1",
      "github": "davidguzmanp",
      "linkedin": "https://www.linkedin.com/in/davidguzman1120/",
      "website": "https://davidguzmanp.github.io/homepage/"
    }
  },
  {
    "key": "david jenny",
    "name": "David Jenny",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Los_Angeles",
      "correspondence_email": "davjenny@cs.toronto.edu"
    }
  },
  {
    "key": "dev shah",
    "name": "Dev Shah",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-02-01",
      "location": "Toronto",
      "correspondence_email": "dev.shah@utoronto.ca",
      "twitter": "https://x.com/DevShahs1",
      "calendar_email": "dev.shah@utoronto.ca",
      "github": "devshah21",
      "linkedin": "https://www.linkedin.com/in/devshah-/",
      "website": "https://devshah.ca"
    }
  },
  {
    "key": "do minh duc",
    "name": "Do Minh Duc",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-05-01",
      "location": "Daejeon, KOR",
      "correspondence_email": "duc.dm200158@gmail.com",
      "twitter": "x",
      "calendar_email": "duc.dm200158@gmail.com",
      "openreview": "~Duc_Dm1",
      "github": "https://github.com/minhducdo050702",
      "linkedin": "https://www.linkedin.com/in/duc-do-minh-9753b9373/",
      "website": "https://minhducdo050702.github.io/"
    }
  },
  {
    "key": "elaine huynh",
    "name": "Elaine Huynh",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "elaine@cs.toronto.edu"
    }
  },
  {
    "key": "emanuel tewolde",
    "name": "Emanuel Tewolde",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "etewolde@cs.toronto.edu"
    }
  },
  {
    "key": "emilia wisnios",
    "name": "Emilia Wiśnios",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-05-01",
      "location": "Warsaw, Poland; Alicante, Spain (starting November)",
      "correspondence_email": "wisniosemilia@gmail.com / emilia@goral.one (preferred for calendar invites)",
      "twitter": "https://x.com/wisnios_emilia",
      "calendar_email": "emilia@goral.one",
      "openreview": "~Emilia_Wiśnios1",
      "github": "https://github.com/emiliawisnios",
      "linkedin": "https://www.linkedin.com/in/emilia-wisnios/",
      "website": "WIP"
    }
  },
  {
    "key": "emilycang",
    "name": "emilycang2006",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "emilycang2006@gmail.com"
    }
  },
  {
    "key": "eric zhang",
    "name": "Eric Zhang",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "zhangeric89@gmail.com"
    }
  },
  {
    "key": "erivan inan",
    "name": "Erivan Inan",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-02-01",
      "location": "Paris, France",
      "correspondence_email": "einan@cs.toronto.edu",
      "twitter": "@erivan_in",
      "calendar_email": "inanerivan@gmail.com",
      "openreview": "Erivan_Inan1",
      "github": "https://github.com/erivaninan",
      "linkedin": "https://www.linkedin.com/in/erivan-inan/"
    }
  },
  {
    "key": "ettore gran",
    "name": "Ettore Gran",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-03-01",
      "location": "Zürich, Tübingen",
      "correspondence_email": "ettore@cs.toronto.edu",
      "twitter": "ettogran",
      "calendar_email": "ettoregranpro@gmail.com",
      "github": "ettorhrz",
      "linkedin": "https://www.linkedin.com/in/ettore-gran-b825421a2/",
      "website": "https://ettoregran.net/"
    }
  },
  {
    "key": "fatima zahra moudakir",
    "name": "Fatima Zahra Moudakir",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Africa/Casablanca",
      "correspondence_email": "fzmoudakir@cs.toronto.edu"
    }
  },
  {
    "key": "florent draye",
    "name": "Florent Draye",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Los_Angeles",
      "correspondence_email": "fdraye@cs.toronto.edu"
    }
  },
  {
    "key": "freni francesco",
    "name": "Freni Francesco",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "furkan",
    "name": "Furkan",
    "sources": [
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-09-01",
      "correspondence_email": "furkan.danisman@mail.utoronto.ca",
      "twitter": "https://x.com/FurkanDanismann",
      "calendar_email": "furkandanisman@gmail.com",
      "openreview": "Furkan_Danisman1",
      "github": "https://github.com/FurkanDanisman",
      "linkedin": "https://www.linkedin.com/in/furkandanisman/",
      "website": "https://furkandanisman.github.io/"
    }
  },
  {
    "key": "furkan danisman",
    "name": "Furkan Danisman",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "joined_month": "25-Sep",
      "location": "Toronto",
      "correspondence_email": "furkan.danisman@mail.utoronto.ca",
      "twitter": "https://x.com/FurkanDanismann",
      "calendar_email": "furkandanisman@gmail.com",
      "openreview": "Furkan_Danisman1",
      "github": "https://github.com/FurkanDanisman",
      "linkedin": "https://www.linkedin.com/in/furkandanisman/",
      "website": "https://furkandanisman.github.io/"
    }
  },
  {
    "key": "gizelda pereira",
    "name": "Gizelda Pereira",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "raposope@cs.toronto.edu"
    }
  },
  {
    "key": "godwin abuh faruna",
    "name": "Godwin Abuh Faruna",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "Abuja, Nigeria",
      "correspondence_email": "farunagodwin01@gmail.com",
      "twitter": "@Faruna_Real",
      "calendar_email": "farunagodwin01@gmail.com",
      "openreview": "~Godwin_Abuh_Faruna1",
      "github": "https://github.com/farunawebservices/",
      "linkedin": "https://www.linkedin.com/in/faruna-godwin-abuh-07a22213b/",
      "website": "https://www.faruna.space/"
    }
  },
  {
    "key": "gopal dev",
    "name": "Gopal Dev",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-04-01",
      "location": "Chandigarh, India",
      "correspondence_email": "gopaldev108@gmail.com",
      "calendar_email": "gopaldev108@gmail.com",
      "openreview": "Gopal_Dev1",
      "github": "gopaldev7",
      "linkedin": "https://www.linkedin.com/in/gopal-dev-1abb041b6"
    }
  },
  {
    "key": "hai son le",
    "name": "Hai Son Le",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "haisonle@cs.toronto.edu"
    }
  },
  {
    "key": "howardhsuuu",
    "name": "howardhsuuu",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Asia/Kolkata",
      "correspondence_email": "howardhsuuu@gmail.com"
    }
  },
  {
    "key": "irene strauss",
    "name": "Irene Strauss",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "istrauss@student.ethz.ch"
    }
  },
  {
    "key": "isabel dahlgren",
    "name": "Isabel Dahlgren",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-06-01",
      "location": "Zürich/Stockholm",
      "correspondence_email": "isabel.dahlgren@gmail.com",
      "twitter": "@isabeldahlgren",
      "openreview": "Isabel_Dahlgren1",
      "github": "isabeldahlgren",
      "linkedin": "isabeldahlgren",
      "website": "https://isabeldahlgren.github.io"
    }
  },
  {
    "key": "ivaxi sheth",
    "name": "Ivaxi Sheth",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "ivaxisheth17@gmail.com"
    }
  },
  {
    "key": "jacob tae emmerson",
    "name": "Jacob Tae Emmerson",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-09-01",
      "location": "Pittsburgh, PA",
      "correspondence_email": "emmerson.tae@gmail.com",
      "calendar_email": "emmerson.tae@gmail.com",
      "openreview": "7EJacob_T._Emmerson1",
      "github": "jacobemmerson",
      "linkedin": "https://www.linkedin.com/in/jtemmerson/",
      "website": "https://emmerson.dev/"
    }
  },
  {
    "key": "jean sebastien",
    "name": "Jean-Sébastien",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "calendar_email": "delineauj@gmail.com"
    }
  },
  {
    "key": "jerick shi",
    "name": "Jerick Shi",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-08-01",
      "location": "Pittsburgh, US",
      "correspondence_email": "junkais@andrew.cmu.edu",
      "twitter": "@Jerick1380",
      "calendar_email": "JerickS.1380@gmail.com",
      "openreview": "~Jerick_Shi1",
      "github": "Jerick-1380",
      "linkedin": "https://www.linkedin.com/in/jerick-shi-293773216/",
      "website": "https://jerick-1380.github.io/"
    }
  },
  {
    "key": "jiang hanyuan",
    "name": "Jiang Hanyuan",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "hy.jiang04@gmail.com"
    }
  },
  {
    "key": "jiarui liu",
    "name": "Jiarui Liu",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2023-04-01",
      "location": "Pittsburgh",
      "correspondence_email": "jiaruil5@andrew.cmu.edu",
      "twitter": "@Jiarui_Liu_",
      "calendar_email": "jiaruil5@andrew.cmu.edu",
      "openreview": "~Jiarui_Liu1",
      "github": "jiarui-liu",
      "linkedin": "https://www.linkedin.com/in/jia-rui-liu/",
      "website": "https://jiarui-liu.github.io/"
    }
  },
  {
    "key": "jinesislab",
    "name": "JinesisLab",
    "sources": [
      "MemberList"
    ],
    "fields": {
      "joined_month": "2024-12-01",
      "correspondence_email": "zjin.admin@cs.toronto.edu",
      "twitter": "@JinesisLab",
      "calendar_email": "jinesis.lab@gmail.com",
      "github": "causalnlp",
      "linkedin": "https://www.linkedin.com/company/jinesis-lab",
      "website": "https://zhijing-jin.com/"
    }
  },
  {
    "key": "joeun yook",
    "name": "Joeun Yook",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-06-01",
      "location": "Toronto",
      "correspondence_email": "joeun.yook@mail.utoronto.ca",
      "twitter": "@JoeunYk05",
      "calendar_email": "yookjoeun@gmail.com",
      "openreview": "~Joeun_Yook1",
      "github": "joeunyook",
      "linkedin": "https://www.linkedin.com/in/joeun-yook/"
    }
  },
  {
    "key": "jordan shao",
    "name": "Jordan Shao",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "Toronto, Canada",
      "correspondence_email": "jordan.shao@mail.utoronto.ca",
      "calendar_email": "mhkjordan@gmail.com",
      "github": "https://github.com/laodie666",
      "linkedin": "https://www.linkedin.com/in/jordan-shao-07b6b6371/"
    }
  },
  {
    "key": "joseph kostousov",
    "name": "Joseph Kostousov",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Los_Angeles",
      "correspondence_email": "yosya@cs.toronto.edu"
    }
  },
  {
    "key": "justus mattern",
    "name": "Justus Mattern",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "kan min yen",
    "name": "Kan Min-Yen",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "kem nguyen le",
    "name": "Kem Nguyen-Le",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "College Park, MD, US",
      "correspondence_email": "nlpa@umd.edu",
      "twitter": "kemnguyenle",
      "calendar_email": "nlpa@umd.edu",
      "openreview": "~Phuong-Anh_Nguyen-Le1",
      "github": "kemnguyenle",
      "linkedin": "https://www.linkedin.com/in/kem-nguyen-le/",
      "website": "https://kemnguyenle.github.io/"
    }
  },
  {
    "key": "kevin blin",
    "name": "Kevin Blin",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Europe/Amsterdam",
      "correspondence_email": "kevinblin@cs.toronto.edu"
    }
  },
  {
    "key": "khai le duc",
    "name": "Khai Le-Duc",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Toronto",
      "correspondence_email": "duckhai.le@mail.utoronto.ca",
      "twitter": "@_leduckhai_",
      "calendar_email": "duckhai.le@mail.utoronto.ca",
      "openreview": "~Khai_Le-Duc1",
      "github": "leduckhai",
      "linkedin": "https://www.linkedin.com/in/khaileduc/",
      "website": "https://github.com/leduckhai"
    }
  },
  {
    "key": "korinna fragkia",
    "name": "Korinna Fragkia",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "leyla yaayladere",
    "name": "Leyla Yaayladere",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Europe/Amsterdam",
      "correspondence_email": "leyla@cs.toronto.edu"
    }
  },
  {
    "key": "lillian fu",
    "name": "Lillian Fu",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "lillian.fu@uci.edu"
    }
  },
  {
    "key": "lucy muir",
    "name": "Lucy Muir",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "lucy.muir@mail.utoronto.ca"
    }
  },
  {
    "key": "luke zhang",
    "name": "Luke Zhang",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Toronto",
      "correspondence_email": "zluke7111@gmail.com",
      "calendar_email": "zluke7111@gmail.com",
      "openreview": "Luke_Zhang3",
      "github": "https://github.com/lukezhang01",
      "linkedin": "https://www.linkedin.com/in/luke-zhang123/"
    }
  },
  {
    "key": "mariana meireles",
    "name": "Mariana Meireles",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Berlin, Germany",
      "correspondence_email": "marian.meireles@gmail.com",
      "twitter": "_3l3ktr4_",
      "calendar_email": "marian.meireles@gmail.com",
      "openreview": "Mariana_Meireles3",
      "github": "marimeireles",
      "linkedin": "https://www.linkedin.com/in/mariana-meireles/",
      "website": "https://marimeireles.com/"
    }
  },
  {
    "key": "matiss apinis",
    "name": "Matiss Apinis",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "mehmet memo ozdincer",
    "name": "Mehmet (Memo) Ozdincer",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-09-01",
      "location": "Toronto, Canada",
      "correspondence_email": "memo@cs.toronto.edu",
      "twitter": "@ememoe",
      "calendar_email": "memoozdincer@gmail.com",
      "openreview": "~Mehmet_Ozdincer1",
      "github": "memo-ozdincer",
      "linkedin": "linkedin.com/in/memo-ozdincer"
    }
  },
  {
    "key": "michael regan",
    "name": "Michael Regan",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Asia/Katmandu",
      "correspondence_email": "ling575.instructor@gmail.com"
    }
  },
  {
    "key": "miu takagi",
    "name": "Miu Takagi",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Los_Angeles",
      "correspondence_email": "miutakagi@cs.toronto.edu"
    }
  },
  {
    "key": "narmeen oozeer",
    "name": "Narmeen Oozeer",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-03-01",
      "location": "Berkeley/SF",
      "correspondence_email": "narmeenfatimahoozeer@gmail.com",
      "twitter": "@Narmeen29013644",
      "calendar_email": "narmeen@withmartian.com",
      "openreview": "~Narmeen_Fatimah_Oozeer1",
      "github": "Narmeen07",
      "linkedin": "https://www.linkedin.com/in/narmeen-oozeer/",
      "website": "In progress!"
    }
  },
  {
    "key": "neemesh",
    "name": "Neemesh",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "neemesh20529@iiitd.ac.in"
    }
  },
  {
    "key": "nico daheim",
    "name": "Nico Daheim",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "nico.daheim@rwth-aachen.de"
    }
  },
  {
    "key": "nikos papanikolaou",
    "name": "Nikos Papanikolaou",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "nikos-papanikolaou@hotmail.com"
    }
  },
  {
    "key": "omar el herraoui",
    "name": "Omar El Herraoui",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Asia/Muscat",
      "correspondence_email": "omarherro@cs.toronto.edu"
    }
  },
  {
    "key": "oscar yasunaga",
    "name": "Oscar Yasunaga",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-12-01",
      "location": "Toronto, Canada",
      "correspondence_email": "oscar.yasunaga@mail.utoronto.ca",
      "twitter": "https://x.com/OscarYasun86978",
      "calendar_email": "oscar.yasunaga@mail.utoronto.ca",
      "openreview": "Oscar_S._Yasunaga1",
      "github": "https://github.com/oscaryas",
      "linkedin": "https://www.linkedin.com/in/oscaryas"
    }
  },
  {
    "key": "pepijn cobben",
    "name": "Pepijn Cobben",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-06-01",
      "location": "Zürich",
      "correspondence_email": "cobb.pep@gmail.com",
      "twitter": "https://x.com/PepijnCobben",
      "calendar_email": "cobb.pep@gmail.com",
      "openreview": "Pepijn_Cobben1",
      "github": "https://pepijncobben.github.io/",
      "linkedin": "https://www.linkedin.com/in/pepijn-cobben/",
      "website": "https://pepijncobben.github.io/"
    }
  },
  {
    "key": "prakhar gupta",
    "name": "Prakhar Gupta",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-02-01",
      "location": "Ann Arbor, MI",
      "correspondence_email": "prakharg@umich.edu",
      "calendar_email": "prakharg@umich.edu",
      "openreview": "~Prakhar_Gupta5",
      "github": "prakharg55",
      "linkedin": "https://www.linkedin.com/in/prakhar55/"
    }
  },
  {
    "key": "pranav akella",
    "name": "Pranav Akella",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "pranav.akella@gmail.com"
    }
  },
  {
    "key": "punya syon pandey",
    "name": "Punya Syon Pandey",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Europe/London",
      "correspondence_email": "ppandey@cs.toronto.edu"
    }
  },
  {
    "key": "rada mihalcea",
    "name": "Rada Mihalcea",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Europe/Athens",
      "correspondence_email": "mihalcea@umich.edu"
    }
  },
  {
    "key": "rahul shrestha",
    "name": "Rahul Shrestha",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-12-01",
      "location": "Tübingen, Germany",
      "correspondence_email": "rahulshrestha0101@gmail.com",
      "twitter": "https://x.com/rahulbshrestha",
      "calendar_email": "rahulshrestha0101@gmail.com",
      "openreview": "Rahul_Babu_Shrestha1",
      "github": "https://github.com/rahulbshrestha",
      "linkedin": "https://www.linkedin.com/in/rahulbshrestha"
    }
  },
  {
    "key": "ramaravind kommiya mothilal",
    "name": "Ramaravind Kommiya Mothilal",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "ram@cs.toronto.edu"
    }
  },
  {
    "key": "rauno arike",
    "name": "Rauno Arike",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-09-01",
      "location": "Toronto",
      "correspondence_email": "rauno.arike@gmail.com",
      "twitter": "https://x.com/RaunoArike",
      "calendar_email": "rauno.arike@gmail.com",
      "openreview": "~Rauno_Arike1",
      "github": "https://github.com/RaunoArike",
      "linkedin": "https://www.linkedin.com/in/rauno-arike/"
    }
  },
  {
    "key": "riccardo formenti",
    "name": "Riccardo Formenti",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-04-01",
      "location": "Zurich and Milan",
      "correspondence_email": "riccardo.formenti@outlook.it",
      "twitter": "@riccardoffff",
      "calendar_email": "riccardo.formenti@outlook.it",
      "openreview": "~Riccardo_Formenti1",
      "github": "RiccardoFormenti",
      "linkedin": "https://www.linkedin.com/in/riccardo-formenti/",
      "website": "Coming soon"
    }
  },
  {
    "key": "rishit dagli",
    "name": "Rishit Dagli",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Toronto, Canada",
      "correspondence_email": "rishit.dagli@mail.utoronto.ca",
      "twitter": "https://x.com/rishit_dagli",
      "calendar_email": "rishit.dagli@mail.utoronto.ca",
      "openreview": "Rishit_Dagli1",
      "github": "https://github.com/Rishit-dagli/",
      "linkedin": "https://www.linkedin.com/in/rishit-dagli",
      "website": "https://rishitdagli.com/"
    }
  },
  {
    "key": "rishitej reddy vyalla",
    "name": "Rishitej Reddy Vyalla",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-07-01",
      "location": "Delhi, India",
      "correspondence_email": "rishitej23439@iiitd.ac.in",
      "twitter": "VY_Rishi",
      "calendar_email": "rishitej23439@iiitd.ac.in",
      "openreview": "~Rishitej_Reddy_Vyalla1",
      "github": "https://github.com/vyallarishi",
      "linkedin": "https://www.linkedin.com/in/rishitej-reddy-vyalla-3b67a0289/"
    }
  },
  {
    "key": "roberto ceraolo",
    "name": "Roberto Ceraolo",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Europe/Amsterdam",
      "correspondence_email": "rceraolo@cs.toronto.edu"
    }
  },
  {
    "key": "roderick wu",
    "name": "Roderick Wu",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-08-01",
      "location": "Toronto",
      "correspondence_email": "roderick.wu@mail.utoronto.ca",
      "twitter": "RoderickWu4",
      "calendar_email": "roderickwu2003@gmail.com",
      "openreview": "~Roderick_Wu1",
      "github": "Roderick-Wu",
      "linkedin": "https://www.linkedin.com/in/roderick--wu/"
    }
  },
  {
    "key": "roger grosse",
    "name": "Roger Grosse",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Los_Angeles",
      "correspondence_email": "rgrosse@cs.toronto.edu"
    }
  },
  {
    "key": "rohan subramani",
    "name": "Rohan Subramani",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-08-01",
      "location": "Toronto (soon Berkeley)",
      "correspondence_email": "rohn.subrmni@gmail.com",
      "twitter": "@rohan_subramani",
      "calendar_email": "rohn.subrmni@gmail.com",
      "openreview": "Rohan_Subramani1",
      "github": "RohanSubramani",
      "linkedin": "Rohan's Linkedin",
      "website": "Rohan Subramani"
    }
  },
  {
    "key": "roland",
    "name": "Roland",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "ronan romano",
    "name": "Ronan Romano",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "Philadelphia PA, West Lafayette Indiana",
      "correspondence_email": "romano33@purdue.edu"
    }
  },
  {
    "key": "ryan faulkner",
    "name": "Ryan Faulkner",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-07-01",
      "location": "Toronto",
      "correspondence_email": "rfaulk@cs.toronto.edu",
      "twitter": "_rfaulk",
      "calendar_email": "ryan.art.faulkner@gmail.com",
      "openreview": "~Ryan_Faulkner2",
      "github": "rfaulkner",
      "linkedin": "https://www.linkedin.com/in/rfaulk81/",
      "website": "https://www.cs.toronto.edu/~rfaulk/"
    }
  },
  {
    "key": "samuel simko",
    "name": "Samuel Simko",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2024-09-01",
      "location": "Zurich",
      "correspondence_email": "samuel@simko.info",
      "twitter": "@SimkoSamuel",
      "calendar_email": "sam161803@gmail.com",
      "openreview": "Samuel_Simko1",
      "github": "https://github.com/samuelsimko/",
      "linkedin": "https://www.linkedin.com/in/samuelsimko/",
      "website": "samuelsimko.github.io"
    }
  },
  {
    "key": "sawal acharya",
    "name": "Sawal Acharya",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Los_Angeles",
      "correspondence_email": "sawal@cs.toronto.edu"
    }
  },
  {
    "key": "sebastian weichwald",
    "name": "Sebastian Weichwald",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "sekai tully carr",
    "name": "Sekai Tully Carr",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-07-01",
      "location": "New York",
      "correspondence_email": "sekaitullycarr@gmail.com",
      "twitter": "jammy_eggs",
      "calendar_email": "sekaitullycarr@gmail.com",
      "openreview": "~Ulysses_Sekai_Tully_Carr1",
      "github": "https://github.com/jammy-eggs",
      "linkedin": "https://www.linkedin.com/in/ulysses-tully-carr/",
      "website": "https://www.sekaitc.me/"
    }
  },
  {
    "key": "seong woo han",
    "name": "Seong Woo Han",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "New York, Zurich",
      "correspondence_email": "seonghan@engineering.upenn.edu",
      "twitter": "https://x.com/seongwoohan29",
      "calendar_email": "seongwoohan29@gmail.com",
      "openreview": "~Seong_Woo_Han1",
      "github": "https://github.com/seongwoohan",
      "linkedin": "https://www.linkedin.com/in/seong-woo-han-980b0b238/",
      "website": "https://seongwoohan.github.io/"
    }
  },
  {
    "key": "shashwat sourav",
    "name": "Shashwat Sourav",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-07-01",
      "location": "St. Louis",
      "correspondence_email": "shashwatsourav2017@gmail.com",
      "calendar_email": "shashwatsourav2017@gmail.com",
      "openreview": "~Shashwat_Sourav1",
      "github": "https://github.com/Shash12-ship",
      "linkedin": "https://www.linkedin.com/in/shashwat-sourav-a40834216/"
    }
  },
  {
    "key": "shivam arora",
    "name": "Shivam Arora",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "shivam.iiserm@gmail.com"
    }
  },
  {
    "key": "shivansh singh",
    "name": "Shivansh Singh",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "shuquan wang",
    "name": "Shuquan Wang",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "shuquan@cs.toronto.edu"
    }
  },
  {
    "key": "sirui lu",
    "name": "Sirui Lu",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "sirui.lu.phys@gmail.com"
    }
  },
  {
    "key": "soumya jain",
    "name": "Soumya Jain",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "soumya.jain8010@gmail.com"
    }
  },
  {
    "key": "steffen knoblauch",
    "name": "Steffen Knoblauch",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "suvajit majumder",
    "name": "Suvajit Majumder",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-12-01",
      "location": "Dallas, US",
      "correspondence_email": "majumder.suvajit95@gmail.com",
      "calendar_email": "majumder.suvajit95@gmail.com",
      "openreview": "Suvajit_Majumder1",
      "github": "https://github.com/suv11235",
      "linkedin": "https://www.linkedin.com/in/suvajit-majumder-a76246a4/"
    }
  },
  {
    "key": "tejas vaidya",
    "name": "Tejas Vaidya",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "terry zhang",
    "name": "Terry Zhang",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Asia/Chongqing",
      "correspondence_email": "zjingchen@cs.toronto.edu"
    }
  },
  {
    "key": "thai ha bui",
    "name": "Thai Ha Bui",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-02-01",
      "location": "Prague, CZ",
      "correspondence_email": "ha@sparkenv.com",
      "calendar_email": "ha@sparkenv.com",
      "openreview": "~Thai_Ha_Bui1",
      "github": "https://github.com/spbui00",
      "linkedin": "https://www.linkedin.com/in/thai-ha-bui/",
      "website": "https://han.sparkenv.com/"
    }
  },
  {
    "key": "thao amelia pham",
    "name": "Thao Amelia Pham",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-08-01",
      "location": "London, UK",
      "correspondence_email": "thaoameliapham@gmail.com",
      "calendar_email": "thaoameliapham@gmail.com",
      "openreview": "~Thao_Amelia_Pham1",
      "github": "thaopham03",
      "linkedin": "https://www.linkedin.com/in/thaominhtpham/",
      "website": "https://thaopham.dev/"
    }
  },
  {
    "key": "tim beyer",
    "name": "Tim Beyer",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "tim.beyer@tum.de"
    }
  },
  {
    "key": "tung yu tony wu",
    "name": "Tung-Yu (Tony) Wu",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Oxford, Taipei",
      "correspondence_email": "tony10101105@gmail.com",
      "twitter": "@TonyWu1105",
      "calendar_email": "tony10101105@gmail.com",
      "openreview": "~Tung-Yu_Wu1",
      "github": "tony10101105",
      "linkedin": "www.linkedin.com/in/tony-wu-86687b1b2"
    }
  },
  {
    "key": "udbhav chitransh",
    "name": "Udbhav Chitransh",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-05-01",
      "location": "Pune",
      "correspondence_email": "udbhavchitransh@gmail.com",
      "twitter": "https://x.com/udseaa",
      "calendar_email": "udbhavchitransh@gmail.com",
      "openreview": "~Udbhav_Chitransh2",
      "github": "https://github.com/udsea",
      "website": "WIP"
    }
  },
  {
    "key": "upasna",
    "name": "Upasna",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "van quynh thi truong",
    "name": "Van Quynh Thi Truong",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-02-01",
      "location": "Cape Town, South Africa",
      "correspondence_email": "scientistvan@gmail.com",
      "twitter": "@vantru0ng",
      "calendar_email": "scientistvan@gmail.com",
      "openreview": "Van_Quynh-Thi_Truong1",
      "github": "van-truong",
      "linkedin": "vanqtruong",
      "website": "https://www.vanquynh.com/"
    }
  },
  {
    "key": "vansh",
    "name": "vansh1401876",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Asia/Kolkata",
      "correspondence_email": "vansh1401876@gmail.com"
    }
  },
  {
    "key": "vedant palit",
    "name": "Vedant Palit",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Kharagpur, India (Soon to be Tübingen)",
      "correspondence_email": "vedantpalit10@gmail.com",
      "twitter": "@vedantpalit1008",
      "calendar_email": "vedantpalit@kgpian.iitkgp.ac.in",
      "openreview": "~Vedant_Palit1",
      "github": "vedantpalit",
      "linkedin": "https://www.linkedin.com/in/vedant-palit-b22558188/",
      "website": "https://vedantpalit.github.io/"
    }
  },
  {
    "key": "victoria oldemburgo de mello",
    "name": "Victoria Oldemburgo de Mello",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/New_York",
      "correspondence_email": "Vic.oldemburgo@gmail.com"
    }
  },
  {
    "key": "vincent wolowski",
    "name": "Vincent Wolowski",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "Zurich, Switzerland",
      "correspondence_email": "vwolowski@gmail.com",
      "calendar_email": "vwolowski@gmail.com",
      "github": "https://github.com/vinwol",
      "linkedin": "https://www.linkedin.com/in/vincent-wolowski/"
    }
  },
  {
    "key": "weixin chen",
    "name": "Weixin Chen",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "chenweixin107@gmail.com"
    }
  },
  {
    "key": "wendy de gomez",
    "name": "Wendy De Gomez",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "wilber sean v anterola",
    "name": "Wilber Sean V. Anterola",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "Providence, RI",
      "correspondence_email": "wvanterola@brown.edu",
      "calendar_email": "wvanterola@brown.edu",
      "github": "https://github.com/Wv-Anterola",
      "linkedin": "https://www.linkedin.com/in/wilberseananterola/"
    }
  },
  {
    "key": "xianlin sun",
    "name": "Xianlin Sun",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "correspondence_email": "sxl1998@connect.hku.hk"
    }
  },
  {
    "key": "xiao zhang",
    "name": "Xiao Zhang",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-09-01",
      "location": "Bay Area, CA",
      "correspondence_email": "zhxiao@cs.toronto.edu",
      "twitter": "@zhxiao03",
      "calendar_email": "zhxiao@google.com",
      "openreview": "~Xiao_Zhang58",
      "github": "Xiao215",
      "linkedin": "https://www.linkedin.com/in/xiao215",
      "website": "https://xiao215.github.io/"
    }
  },
  {
    "key": "xinge liu",
    "name": "Xinge Liu",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Toronto"
    }
  },
  {
    "key": "xuanqiang angelo huang",
    "name": "Xuanqiang Angelo Huang",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-08-01",
      "location": "Oxford from April, Zurich else",
      "correspondence_email": "hxuanqiang@ethz.ch",
      "twitter": "x_angelohuang",
      "calendar_email": "hxuanqiang@ethz.ch",
      "openreview": "~X._Angelo_Huang1",
      "github": "https://github.com/flecart/",
      "linkedin": "angelo-huang",
      "website": "https://flecart.github.io/"
    }
  },
  {
    "key": "yahang qi",
    "name": "Yahang Qi",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2024-01-01",
      "location": "Toronto",
      "correspondence_email": "yahang.qi@mail.utoronto.ca",
      "twitter": "@yahang_qi",
      "calendar_email": "qiyahang00243@gmail.com",
      "openreview": "~Yahang_Qi1",
      "github": "yahang_qi",
      "linkedin": "https://www.linkedin.com/in/yahang-qi-33935a2a6/",
      "website": "https://yahang-qi.github.io/"
    }
  },
  {
    "key": "yang yang un",
    "name": "Yang Yang (UN)",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "yang yang zhang",
    "name": "Yang Yang Zhang",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "Toronto, Canada",
      "correspondence_email": "yangyangz.zhang@mail.utoronto.ca",
      "twitter": "@yangyangzzhang",
      "calendar_email": "yangyangzhang101306@gmail.com",
      "github": "https://github.com/YYZ-CR",
      "linkedin": "https://www.linkedin.com/in/yang-yang-zhang",
      "website": "https://yangyangzhang.com"
    }
  },
  {
    "key": "yann billeter",
    "name": "Yann Billeter",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-06-01",
      "location": "Zurich, CH",
      "correspondence_email": "ybilleter@ethz.ch",
      "calendar_email": "ybilleter@ethz.ch",
      "openreview": "~Yann_Billeter1",
      "github": "https://github.com/bil-y",
      "linkedin": "https://www.linkedin.com/in/yann-billeter/",
      "website": "https://yanns.site"
    }
  },
  {
    "key": "yannick",
    "name": "Yannick",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {}
  },
  {
    "key": "yara allam",
    "name": "Yara Allam",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "Alexandria, Egypt",
      "correspondence_email": "yaraallam2018@gmail.com",
      "twitter": "yara_allam_",
      "calendar_email": "yaraallam2018@gmail.com",
      "openreview": "~Yara_Allam1",
      "github": "https://github.com/Yoriis",
      "linkedin": "Yara Allam | LinkedIn"
    }
  },
  {
    "key": "yejin son",
    "name": "Yejin Son",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Toronto",
      "correspondence_email": "sonyejin82951209@gmail.com",
      "twitter": "@ozzaney0101",
      "calendar_email": "sonyejin@student.ubc.ca",
      "openreview": "Yejin_Son3",
      "github": "ozzaney",
      "linkedin": "https://www.linkedin.com/in/yejin-son-30867b249/",
      "website": "https://ozzaney.github.io/"
    }
  },
  {
    "key": "yen shan chen lily",
    "name": "Yen-Shan Chen (Lily)",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-06-01",
      "location": "Taiwan",
      "correspondence_email": "yenshan.ntu@gmail.com",
      "calendar_email": "yenshan.ntu@gmail.com",
      "openreview": "~Yen-Shan_Chen1",
      "github": "http://github.com/yenshan0530",
      "linkedin": "www.linkedin.com/in/yen-shan-lily-chen"
    }
  },
  {
    "key": "yenshan lily chen",
    "name": "Yenshan (Lily) Chen",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Asia/Taipei",
      "correspondence_email": "lily@cs.toronto.edu"
    }
  },
  {
    "key": "yngvar schnell",
    "name": "Yngvar Schnell",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Los_Angeles",
      "correspondence_email": "ischnell@cs.toronto.edu"
    }
  },
  {
    "key": "yongjin yang",
    "name": "Yongjin Yang",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2025-09-01",
      "location": "Toronto",
      "correspondence_email": "dyyjkd@gmail.com",
      "twitter": "@_yongjinny",
      "calendar_email": "dyyjkd@gmail.com",
      "linkedin": "link",
      "website": "https://yangyongjin.github.io/"
    }
  },
  {
    "key": "yuchen zhang",
    "name": "Yuchen Zhang",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "America/Los_Angeles",
      "correspondence_email": "yuchenzhang@cs.toronto.edu"
    }
  },
  {
    "key": "yuen chen",
    "name": "Yuen Chen",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2022-10-01",
      "location": "Champaign, Illinois",
      "correspondence_email": "yuenc2@illinois.edu",
      "linkedin": "https://www.linkedin.com/in/chenyuen",
      "website": "https://chenyuen0103.github.io/"
    }
  },
  {
    "key": "yves bicker",
    "name": "Yves Bicker",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-02-01",
      "location": "Zürich",
      "correspondence_email": "yves_bicker@icloud.com, bickery@ethz.ch",
      "twitter": "@yvesbicker",
      "calendar_email": "yvesbicker90@gmail.com",
      "openreview": "~Yves_Bicker1",
      "github": "ybicke",
      "linkedin": "www.linkedin.com/in/yves-bicker"
    }
  },
  {
    "key": "zaryab akram",
    "name": "Zaryab Akram",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-01-01",
      "location": "Islamabad, Pakistan",
      "correspondence_email": "zaryabmakram@gmail.com",
      "twitter": "@zaryabmakram",
      "calendar_email": "zaryabmakram@gmail.com",
      "openreview": "Zaryab_Akram1",
      "github": "zaryabmakram",
      "linkedin": "https://www.linkedin.com/in/zaryabmakram/",
      "website": "https://zaryabmakram.github.io/"
    }
  },
  {
    "key": "zhijing jin",
    "name": "Zhijing Jin",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "1000-01",
      "location": "Zurich/Tuebingen/Toronto",
      "correspondence_email": "zjin@cs.toronto.edu",
      "twitter": "ZhijingJin",
      "calendar_email": "zhij.jin@gmail.com",
      "github": "zhijing-jin",
      "website": "https://zhijing-jin.com/"
    }
  },
  {
    "key": "zhiyang jeff chen",
    "name": "Zhiyang(Jeff) Chen",
    "sources": [
      "Full Slack Member List"
    ],
    "fields": {
      "location": "Europe/Amsterdam",
      "correspondence_email": "zhiychen@cs.toronto.edu"
    }
  },
  {
    "key": "zihao jing",
    "name": "Zihao Jing",
    "sources": [
      "Full Slack Member List",
      "MemberList"
    ],
    "fields": {
      "joined_month": "2026-03-01",
      "location": "Toronto/London",
      "correspondence_email": "zihaoj24@gmail.com",
      "twitter": "@zihao_jing",
      "calendar_email": "zihaoj24@gmail.com",
      "openreview": "~Zihao_Jing1",
      "github": "zihao-jing",
      "linkedin": "www.linkedin.com/in/zihao-jing-65b506323",
      "website": "https://zihao-jing.github.io/"
    }
  }
];
