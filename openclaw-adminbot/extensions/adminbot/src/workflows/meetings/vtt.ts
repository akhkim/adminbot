// Reading Zoom's audio transcript (WebVTT) into something worth summarizing.
//
// Zoom writes `<recording>_audio_transcript.vtt` beside a cloud recording when audio transcription
// is on. It is the only machine-readable account of what was said that the lab can get without an
// API, and it arrives as a couple of thousand two-second cues, each repeating the speaker's name.
//
// Two things happen here, both of them for the summarizer downstream. Consecutive cues from one
// speaker are folded into a paragraph, which roughly halves the token count and turns a stream of
// fragments into text a model can actually follow. And the speaker list is extracted separately,
// because it is the only part of a transcript this system keeps: `meetings/workflow.ts` summarizes
// from the text and then drops it, so what is said in a lab meeting never lands in the database.
// Whoever spoke is retained to pre-tick the attendance roster, and nothing else is.
//
// Pure and total: a malformed cue is skipped, never thrown on. A transcript is one artifact of a
// meeting, and a meeting record is worth having with a broken one.

const TIMESTAMP = /^(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})/u;

// A cue that opens "Name: text". Bounded at 60 characters and five words because the pattern is
// otherwise happy to read the first clause of any sentence containing a colon as a speaker, and a
// hallucinated name would be shown on the attendance roster as if Zoom had reported it.
const SPEAKER = /^([^:]{1,60}):\s+(.*)$/su;

export type TranscriptCue = {
  /** Seconds from the start of the recording. */
  startSeconds: number;
  speaker?: string;
  text: string;
};

export type ParsedTranscript = {
  /** Distinct speakers, in the order they first spoke. */
  speakers: string[];
  cues: TranscriptCue[];
  /** Speaker-folded plain text, which is what the summarizer is given. */
  text: string;
  /** Length of the recording as the last cue reports it, when there is one. */
  durationSeconds?: number;
};

export function parseVtt(source: string): ParsedTranscript {
  const cues: TranscriptCue[] = [];
  const speakers: string[] = [];
  let latestEnd = 0;
  for (const block of source.replace(/\r\n/gu, "\n").split(/\n{2,}/u)) {
    const cue = parseBlock(block);
    if (!cue) {
      continue;
    }
    latestEnd = Math.max(latestEnd, cue.endSeconds);
    if (cue.speaker && !speakers.includes(cue.speaker)) {
      speakers.push(cue.speaker);
    }
    cues.push({
      startSeconds: cue.startSeconds,
      ...(cue.speaker ? { speaker: cue.speaker } : {}),
      text: cue.text,
    });
  }
  return {
    speakers,
    cues,
    text: foldBySpeaker(cues),
    ...(latestEnd > 0 ? { durationSeconds: Math.round(latestEnd) } : {}),
  };
}

function parseBlock(
  block: string,
): { startSeconds: number; endSeconds: number; speaker?: string; text: string } | undefined {
  const lines = block.split("\n").map((line) => line.trim());
  // WEBVTT headers, NOTE blocks and the bare sequence number that precedes each Zoom cue carry no
  // speech; a block with no timestamp line is one of those.
  const timingIndex = lines.findIndex((line) => TIMESTAMP.test(line));
  if (timingIndex < 0) {
    return undefined;
  }
  const timing = TIMESTAMP.exec(lines[timingIndex] ?? "");
  if (!timing) {
    return undefined;
  }
  const spoken = lines
    .slice(timingIndex + 1)
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
  if (!spoken) {
    return undefined;
  }
  const named = readSpeaker(spoken);
  return {
    startSeconds: toSeconds(timing[1], timing[2], timing[3], timing[4]),
    endSeconds: toSeconds(timing[5], timing[6], timing[7], timing[8]),
    ...(named.speaker ? { speaker: named.speaker } : {}),
    text: named.text,
  };
}

function readSpeaker(spoken: string): { speaker?: string; text: string } {
  const match = SPEAKER.exec(spoken);
  const candidate = match?.[1]?.trim();
  const rest = match?.[2]?.trim();
  if (!candidate || !rest || !isPlausibleSpeaker(candidate)) {
    return { text: spoken };
  }
  return { speaker: candidate, text: rest };
}

// Lowercase words that appear inside real names. Without these, "Ana van der Berg" would be read
// as a sentence by the capitalization rule below.
const NAME_PARTICLES = new Set(["van", "von", "de", "del", "der", "da", "di", "la", "bin", "al"]);

/**
 * Whether a pre-colon fragment is a person's name rather than the start of a sentence.
 *
 * The test that does the work is capitalization, not length: "The link is here: https://..." is
 * four words and would otherwise be accepted, and an invented speaker becomes an invented attendee
 * on the roster. Zoom display names are capitalized because people type them that way; a sentence
 * opening is not. A single bare word is exempt, since a member whose display name is just "priya"
 * is common and unambiguous.
 */
function isPlausibleSpeaker(candidate: string): boolean {
  if (candidate.includes("//") || /^\d+$/u.test(candidate)) {
    return false;
  }
  const words = candidate.split(/\s+/u);
  if (words.length > 5 || !/[a-z]/iu.test(candidate)) {
    return false;
  }
  if (words.length === 1) {
    return true;
  }
  return words.every((word) => !/^[a-z]/u.test(word) || NAME_PARTICLES.has(word.toLowerCase()));
}

function toSeconds(
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  millis: string | undefined,
): number {
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0) +
    Number(millis ?? 0) / 1000
  );
}

/**
 * Consecutive cues from one speaker, joined into a paragraph.
 *
 * Zoom cuts a cue every couple of seconds, so an unfolded transcript is thousands of lines that
 * each re-state who is talking. Folding is what makes the text small enough and coherent enough to
 * summarize; the timestamp of the first cue in each run is kept so a summary can still be traced
 * back to a point in the recording.
 */
function foldBySpeaker(cues: TranscriptCue[]): string {
  const paragraphs: string[] = [];
  let current: { speaker?: string; start: number; parts: string[] } | undefined;
  const flush = () => {
    if (!current) {
      return;
    }
    const who = current.speaker ? `${current.speaker}: ` : "";
    paragraphs.push(`[${formatClock(current.start)}] ${who}${current.parts.join(" ")}`);
  };
  for (const cue of cues) {
    if (current && current.speaker === cue.speaker) {
      current.parts.push(cue.text);
      continue;
    }
    flush();
    current = {
      ...(cue.speaker ? { speaker: cue.speaker } : {}),
      start: cue.startSeconds,
      parts: [cue.text],
    };
  }
  flush();
  return paragraphs.join("\n\n");
}

function formatClock(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
