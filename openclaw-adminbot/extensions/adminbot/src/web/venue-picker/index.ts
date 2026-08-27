// The submission venue decision guide, served publicly.
//
// Asked for in the 2026-06-07 brainstorming deck: "paper submission decision flow chart will be
// highly needed ... feel free to host it on our AdminBot website, public-facing function, with no
// log-in needed", and referenced again from the commit/rebuttal section as where venue selection
// is decided. It had been living as a separate Vercel deployment, which meant the guide the
// guidebook points at could go stale or vanish without anything here noticing.
//
// Ported verbatim from that page apart from its logo: it shipped beside a `logo.png` that only
// existed in its own deployment, and this server has no static asset route, so the mark is the
// lab's name as text rather than 83KB of base64 in a source file.
//
// One string, like renderMemberMapWebUi and the deadlines board: this is a static page with its
// own inline script, so there is nothing for the server to compute. Note the escaping -- the page
// uses JS template literals of its own, so every backtick and `${` inside it is escaped to
// survive being wrapped in one here.

/** The whole guide, ready to send. No arguments: nothing on the page depends on lab state. */
export function renderVenuePickerWebUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Where to Submit — Jinesis</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* ============================================================
     Palette: warm paper ground, deep pine ink, apricot accent.
     Type: Fraunces (display, soft optical) + IBM Plex Sans (body).
     ============================================================ */
  :root {
    --ground:#FDFAF5; --surface:#FFFFFF; --sunk:#F6F1E8;
    --line:#EAE2D6; --line-soft:#F2ECE2;
    --ink:#1B2B26; --ink-soft:#5C6E67; --ink-faint:#94A29B;

    --accent:#1F5A4B;  --accent-soft:#E3F0EA;   /* pine  */
    --warm:#C46B2F;    --warm-soft:#FAEADB;     /* apricot */

    --ml:#2C5AA8;   --ml-soft:#E2EAF7;
    --nlp:#2E7A4F;  --nlp-soft:#E1F0E6;
    --css:#B0552A;  --css-soft:#FAE8DC;
    --cau:#6B4E9B;  --cau-soft:#EDE7F7;
    --gold:#946218; --gold-soft:#FAEFD9;

    --shadow:0 1px 2px rgba(60,45,25,.05), 0 2px 6px rgba(60,45,25,.05);
    --shadow-lift:0 6px 22px rgba(60,45,25,.10);
    --r:18px; --r-sm:11px;

    --display:"Fraunces", ui-serif, Georgia, serif;
    --body:"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:#101614; --surface:#19211E; --sunk:#141B18;
      --line:#28322E; --line-soft:#1F2825;
      --ink:#EDE7DC; --ink-soft:#A2B0A9; --ink-faint:#74827B;

      --accent:#74C9AE;  --accent-soft:#16302A;
      --warm:#EFA36B;    --warm-soft:#33220F;

      --ml:#7FA9E8;   --ml-soft:#18243A;
      --nlp:#6FCB94;  --nlp-soft:#132A1D;
      --css:#E79A6B; --css-soft:#331F12;
      --cau:#B49BE0;  --cau-soft:#231C33;
      --gold:#E3B569; --gold-soft:#2E2411;

      --shadow:0 1px 2px rgba(0,0,0,.3);
      --shadow-lift:0 8px 26px rgba(0,0,0,.4);
    }
  }
  :root[data-theme="dark"] {
    --ground:#101614; --surface:#19211E; --sunk:#141B18;
    --line:#28322E; --line-soft:#1F2825;
    --ink:#EDE7DC; --ink-soft:#A2B0A9; --ink-faint:#74827B;
    --accent:#74C9AE; --accent-soft:#16302A;
    --warm:#EFA36B;   --warm-soft:#33220F;
    --ml:#7FA9E8; --ml-soft:#18243A;
    --nlp:#6FCB94; --nlp-soft:#132A1D;
    --css:#E79A6B; --css-soft:#331F12;
    --cau:#B49BE0; --cau-soft:#231C33;
    --gold:#E3B569; --gold-soft:#2E2411;
    --shadow:0 1px 2px rgba(0,0,0,.3);
    --shadow-lift:0 8px 26px rgba(0,0,0,.4);
  }
  :root[data-theme="light"] {
    --ground:#FDFAF5; --surface:#FFFFFF; --sunk:#F6F1E8;
    --line:#EAE2D6; --line-soft:#F2ECE2;
    --ink:#1B2B26; --ink-soft:#5C6E67; --ink-faint:#94A29B;
    --accent:#1F5A4B; --accent-soft:#E3F0EA;
    --warm:#C46B2F;   --warm-soft:#FAEADB;
    --ml:#2C5AA8; --ml-soft:#E2EAF7;
    --nlp:#2E7A4F; --nlp-soft:#E1F0E6;
    --css:#B0552A; --css-soft:#FAE8DC;
    --cau:#6B4E9B; --cau-soft:#EDE7F7;
    --gold:#946218; --gold-soft:#FAEFD9;
    --shadow:0 1px 2px rgba(60,45,25,.05), 0 2px 6px rgba(60,45,25,.05);
    --shadow-lift:0 6px 22px rgba(60,45,25,.10);
  }

  * { box-sizing:border-box; }
  html { font-size:18px; }
  body {
    margin:0; background:var(--ground); color:var(--ink);
    font-family:var(--body); font-size:1rem; line-height:1.62;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  }
  ::selection { background:var(--accent-soft); }
  :focus-visible { outline:2.5px solid var(--accent); outline-offset:3px; border-radius:4px; }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }

  .wrap { max-width:1080px; margin:0 auto; padding:64px 32px 110px; }

  /* ---------------- header ---------------- */
  header { margin-bottom:44px; }
  .masthead { display:flex; align-items:center; gap:24px; }
  .logo {
    width:88px; height:86px; flex-shrink:0; border-radius:20px; object-fit:cover;
    box-shadow:var(--shadow-lift);
    /* the artwork is dark, so give it a matching rim rather than a hard edge */
    outline:1px solid var(--line); outline-offset:-1px;
  }
  .eyebrow {
    margin:0 0 6px; font-size:.7rem; font-weight:600; letter-spacing:.14em;
    text-transform:uppercase; color:var(--accent);
  }
  @media (max-width:620px) {
    .masthead { flex-direction:column; align-items:flex-start; gap:18px; }
  }
  h1 {
    margin:0 0 10px; font-family:var(--display);
    font-size:clamp(2.1rem, 4.4vw, 3rem); font-weight:600;
    font-variation-settings:"opsz" 96, "SOFT" 40;
    letter-spacing:-.015em; line-height:1.1; text-wrap:balance; color:var(--ink);
  }
  .lede { color:var(--ink-soft); font-size:1.0625rem; margin:0; }

  /* ---------------- upcoming deadlines ---------------- */
  .ulabel {
    display:flex; align-items:center; gap:9px;
    margin:34px 0 12px; font-size:.7rem; font-weight:700; letter-spacing:.14em;
    text-transform:uppercase; color:var(--warm);
  }
  .pulse {
    width:8px; height:8px; border-radius:50%; background:var(--warm); flex-shrink:0;
    box-shadow:0 0 0 0 color-mix(in srgb, var(--warm) 60%, transparent);
    animation:pulse 2.4s ease-out infinite;
  }
  @keyframes pulse {
    0%   { box-shadow:0 0 0 0 color-mix(in srgb, var(--warm) 55%, transparent); }
    70%  { box-shadow:0 0 0 9px color-mix(in srgb, var(--warm) 0%, transparent); }
    100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--warm) 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) { .pulse { animation:none; } }

  .ugrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); gap:16px; }
  .ucard {
    position:relative; display:flex; align-items:center; gap:20px;
    text-decoration:none; color:inherit;
    background:var(--warm-soft); border:1px solid transparent;
    border-left:4px solid var(--warm); border-radius:var(--r);
    padding:20px 24px; box-shadow:var(--shadow);
    transition:transform .18s ease, box-shadow .18s ease, background .18s ease;
  }
  a.ucard:hover {
    transform:translateY(-2px); box-shadow:var(--shadow-lift);
    background:color-mix(in srgb, var(--warm) 16%, var(--surface));
  }
  a.ucard:hover .ugo { transform:translate(2px,-2px); opacity:1; }
  a.ucard:hover .uname { text-decoration:underline; text-underline-offset:3px; }

  .ucount {
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    flex-shrink:0; min-width:64px; padding-right:20px;
    border-right:1px solid color-mix(in srgb, var(--warm) 30%, transparent);
  }
  .ucount b {
    font-family:var(--display); font-size:2.3rem; font-weight:600; line-height:1;
    font-variation-settings:"opsz" 40,"SOFT" 40;
    color:var(--warm); font-variant-numeric:tabular-nums;
  }
  .ucount span {
    font-size:.6667rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase;
    color:var(--warm); opacity:.8; margin-top:5px;
  }
  .uinfo { display:flex; flex-direction:column; gap:3px; min-width:0; flex:1; }
  .uname {
    font-family:var(--display); font-size:1.1875rem; font-weight:600;
    font-variation-settings:"opsz" 24,"SOFT" 40; letter-spacing:-.005em; color:var(--ink);
  }
  .udate { font-size:.8333rem; color:var(--ink-soft); line-height:1.45; }
  .ugo {
    position:absolute; top:14px; right:16px; font-size:.9375rem; color:var(--warm);
    opacity:.55; transition:transform .18s ease, opacity .18s ease;
  }

  /* ---------------- three axes ---------------- */
  .axes { margin-top:38px; }
  .axes-intro {
    margin:0 0 20px; font-size:1rem; color:var(--ink-soft); max-width:64ch;
  }
  .axes-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(268px,1fr)); gap:18px; }
  .axis {
    background:var(--surface); border:1px solid var(--line); border-radius:var(--r);
    padding:26px 26px 28px; box-shadow:var(--shadow);
    transition:transform .18s ease, box-shadow .18s ease;
  }
  .axis:hover { transform:translateY(-3px); box-shadow:var(--shadow-lift); }
  .axis-h { display:flex; align-items:center; gap:11px; margin-bottom:12px; }
  .axis-h svg { width:24px; height:24px; flex-shrink:0; color:var(--accent); }
  .axis-h h3 {
    margin:0; font-family:var(--display); font-size:1.1875rem; font-weight:600;
    font-variation-settings:"opsz" 24, "SOFT" 40; letter-spacing:-.005em; color:var(--ink);
  }
  .axis p { margin:0; font-size:.9688rem; color:var(--ink-soft); line-height:1.62; }

  .axis-dl { margin:0; }
  .axis-dl dt {
    font-size:.7rem; font-weight:600; letter-spacing:.1em; text-transform:uppercase;
    color:var(--accent); margin-top:18px;
  }
  .axis-dl dt:first-child { margin-top:0; }
  .axis-dl dd { margin:6px 0 0; font-size:.9375rem; color:var(--ink-soft); line-height:1.58; }
  .axis-dl b { color:var(--ink); font-weight:600; }

  /* ---------------- tabs ---------------- */
  .tabs { display:flex; gap:9px; margin:44px 0 36px; flex-wrap:wrap; }
  .tab {
    padding:11px 20px; border-radius:999px; border:1px solid var(--line);
    background:var(--surface); color:var(--ink-soft);
    font:inherit; font-size:.9375rem; font-weight:500; cursor:pointer;
    transition:.15s;
  }
  .tab:hover { border-color:var(--accent); color:var(--accent); }
  .tab.on { background:var(--accent); border-color:var(--accent); color:var(--ground); font-weight:600; }

  /* ---------------- wizard ---------------- */
  .step { margin-bottom:42px; }
  .step-n {
    display:inline-flex; align-items:center; gap:10px; font-size:.7rem; font-weight:600;
    letter-spacing:.1em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:16px;
  }
  .step-n i {
    width:22px; height:22px; border-radius:50%; background:var(--accent-soft); color:var(--accent);
    display:grid; place-items:center; font-size:.6875rem; font-style:normal; font-weight:700;
  }
  .q {
    font-family:var(--display); font-size:1.5rem; font-weight:600;
    font-variation-settings:"opsz" 36, "SOFT" 40;
    letter-spacing:-.01em; margin:0 0 20px; text-wrap:balance;
  }

  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; }
  .card {
    text-align:left; background:var(--surface); border:1.5px solid var(--line); border-radius:var(--r);
    padding:24px; cursor:pointer; font:inherit; color:var(--ink);
    transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease;
    box-shadow:var(--shadow);
  }
  .card:hover { border-color:var(--accent); transform:translateY(-3px); box-shadow:var(--shadow-lift); }
  .card.on { border-color:var(--pick); background:var(--pick-soft); }
  .card h3 {
    margin:0 0 6px; font-family:var(--display); font-size:1.125rem; font-weight:600;
    font-variation-settings:"opsz" 24,"SOFT" 40; display:flex; align-items:center; gap:10px;
  }
  .card p { margin:0; font-size:.9375rem; color:var(--ink-soft); line-height:1.55; }
  .dot { width:11px; height:11px; border-radius:50%; flex-shrink:0; }
  .card h3 .tick { margin-left:auto; color:var(--pick); font-weight:700; }
  .stamp { margin:-6px 0 18px; font-size:.8333rem; color:var(--ink-faint); }
  .away { color:var(--ink-soft); font-weight:500; }

  .chips { display:flex; flex-wrap:wrap; gap:11px; }
  .chip {
    padding:12px 22px; border-radius:999px; border:1.5px solid var(--line); background:var(--surface);
    color:var(--ink); font:inherit; font-size:.9375rem; font-weight:500; cursor:pointer; transition:.15s;
  }
  .chip:hover { border-color:var(--accent); color:var(--accent); }
  .chip.on { background:var(--accent); border-color:var(--accent); color:var(--ground); font-weight:600; }

  .refine {
    background:var(--surface); border:1px solid var(--line); border-radius:var(--r);
    padding:4px 26px; box-shadow:var(--shadow);
  }
  .qrow {
    display:grid; grid-template-columns:250px 1fr; gap:22px; align-items:center;
    padding:18px 0; border-bottom:1px solid var(--line-soft);
  }
  .qrow:last-child { border-bottom:0; }
  .qrow-q { font-size:.9688rem; font-weight:500; color:var(--ink); }
  .qrow .chips { gap:8px; }
  .qrow .chip { padding:8px 17px; font-size:.875rem; }
  @media (max-width:780px) { .qrow { grid-template-columns:1fr; gap:11px; } }
  td.v a { color:inherit; text-decoration:none; }
  td.v a:hover { color:var(--accent); text-decoration:underline; }

  /* ---------------- results ---------------- */
  .res-head { display:flex; align-items:baseline; justify-content:space-between; gap:18px; margin-bottom:20px; }
  .res-head h2 {
    margin:0; font-family:var(--display); font-size:1.5rem; font-weight:600;
    font-variation-settings:"opsz" 36,"SOFT" 40; letter-spacing:-.01em;
  }
  .reset { background:none; border:0; color:var(--accent); font:inherit; font-size:.9375rem; font-weight:500; cursor:pointer; }
  .reset:hover { text-decoration:underline; }

  .venue {
    display:flex; align-items:flex-start; gap:18px; background:var(--surface);
    border:1px solid var(--line); border-radius:var(--r); padding:24px 26px;
    margin-bottom:14px; box-shadow:var(--shadow);
  }
  .venue.primary { border-color:var(--accent); border-width:1.5px; }
  .rank {
    width:32px; height:32px; flex-shrink:0; border-radius:50%; display:grid; place-items:center;
    font-size:.875rem; font-weight:700; background:var(--sunk); color:var(--ink-faint);
    font-family:var(--display); font-variation-settings:"opsz" 14;
  }
  .venue.primary .rank { background:var(--accent); color:var(--ground); }
  .v-body { flex:1; min-width:0; }
  .v-top { display:flex; align-items:center; gap:11px; flex-wrap:wrap; margin-bottom:7px; }
  .v-name {
    font-family:var(--display); font-size:1.1875rem; font-weight:600;
    font-variation-settings:"opsz" 24,"SOFT" 40; letter-spacing:-.005em;
  }
  .badge {
    font-size:.6875rem; font-weight:600; letter-spacing:.07em; text-transform:uppercase;
    padding:4px 10px; border-radius:999px;
  }
  .badge.first  { background:var(--accent-soft); color:var(--accent); }
  .badge.arch   { background:var(--nlp-soft); color:var(--nlp); }
  .badge.nonarch{ background:var(--sunk); color:var(--ink-soft); }
  .badge.journal{ background:var(--gold-soft); color:var(--gold); }
  .v-why { font-size:.9375rem; color:var(--ink-soft); margin:0 0 10px; line-height:1.58; }
  .v-meta { display:flex; gap:20px; flex-wrap:wrap; font-size:.8438rem; color:var(--ink-faint); }
  .v-meta b { color:var(--ink); font-weight:600; }
  .v-meta a { color:var(--accent); text-decoration:none; font-weight:500; }
  .v-meta a:hover { text-decoration:underline; }
  .cap { color:var(--warm); font-weight:600; }

  .note {
    background:var(--warm-soft); border-radius:var(--r-sm); padding:16px 20px; margin:24px 0 0;
    font-size:.9375rem; color:var(--ink); line-height:1.6;
  }
  .note b { font-weight:600; }

  .reasons { display:flex; flex-wrap:wrap; gap:7px; margin:0 0 11px; }
  .reason {
    font-size:.7778rem; font-weight:500; padding:4px 11px; border-radius:999px;
    background:var(--accent-soft); color:var(--accent);
  }

  /* ---------------- all venues ---------------- */
  .vgroup { margin-bottom:38px; }
  .vgroup-h {
    margin:0 0 16px; font-family:var(--display); font-size:1.25rem; font-weight:600;
    font-variation-settings:"opsz" 28,"SOFT" 40; display:flex; align-items:center; gap:11px;
  }
  .vlist { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:16px; }
  .vcard {
    background:var(--surface); border:1px solid var(--line); border-radius:var(--r);
    padding:22px 24px; box-shadow:var(--shadow);
    transition:transform .18s ease, box-shadow .18s ease;
  }
  .vcard:hover { transform:translateY(-2px); box-shadow:var(--shadow-lift); }
  .vcard-top { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:9px; }
  .vcard-top h3 {
    margin:0; font-family:var(--display); font-size:1.125rem; font-weight:600;
    font-variation-settings:"opsz" 22,"SOFT" 40; letter-spacing:-.005em;
  }
  .vcard-top a { color:inherit; text-decoration:none; }
  .vcard-top a:hover { color:var(--accent); }
  .vcard-top .ext { font-size:.8125rem; color:var(--accent); }
  .vcard-why { margin:0 0 13px; font-size:.9375rem; color:var(--ink-soft); line-height:1.58; }
  .vcard-meta { display:flex; flex-direction:column; gap:5px; font-size:.8333rem; color:var(--ink-faint); }
  .vcard-meta b { color:var(--ink); font-weight:600; }

  .uloc { color:var(--ink-soft); }
  a.pill { text-decoration:none; transition:filter .15s; }
  a.pill:hover { filter:brightness(1.08); text-decoration:underline; }
  .pgo { opacity:.6; font-size:.8em; }

  /* ---------------- TACL drawer ---------------- */
  .tacl-open {
    margin-top:14px; padding:9px 16px; border-radius:999px;
    border:1px dashed var(--line); background:transparent; color:var(--accent);
    font:inherit; font-size:.8889rem; font-weight:600; cursor:pointer; transition:.15s;
  }
  .tacl-open:hover { border-color:var(--accent); background:var(--accent-soft); }
  .tacl-open span { transition:transform .15s; display:inline-block; }
  .tacl-open:hover span { transform:translateX(3px); }

  .tacl-drawer {
    margin-top:16px; padding:18px 20px; border-radius:var(--r-sm);
    background:var(--sunk); border:1px solid var(--line);
  }
  .tacl-h {
    display:flex; align-items:center; justify-content:space-between; gap:14px;
    font-size:.7rem; font-weight:700; letter-spacing:.1em; text-transform:uppercase;
    color:var(--ink-faint); margin-bottom:14px;
  }
  .tacl-close {
    border:0; background:none; color:var(--ink-faint); font:inherit; font-size:.6667rem;
    letter-spacing:.08em; text-transform:uppercase; cursor:pointer; text-decoration:underline;
  }
  .tacl-close:hover { color:var(--ink); }
  .tacl-q {
    display:flex; align-items:center; justify-content:space-between; gap:18px; flex-wrap:wrap;
    padding:9px 0; font-size:.9375rem;
  }
  .tacl-q .chip { padding:7px 15px; font-size:.8333rem; }
  .tacl-yes, .tacl-no {
    margin-top:12px; padding:14px 16px; border-radius:var(--r-sm); font-size:.9062rem; line-height:1.55;
  }
  .tacl-yes { background:var(--accent-soft); color:var(--ink); }
  .tacl-yes a { color:var(--accent); font-weight:600; }
  .tacl-no  { background:var(--surface); color:var(--ink-soft); border:1px solid var(--line); }

  /* ---------------- full chart ---------------- */
  .chart { display:flex; flex-direction:column; gap:20px; }
  .branch {
    background:var(--surface); border:1px solid var(--line); border-radius:var(--r);
    padding:26px 30px 28px; box-shadow:var(--shadow);
  }
  .branch > h3 {
    margin:0 0 5px; font-family:var(--display); font-size:1.3125rem; font-weight:600;
    font-variation-settings:"opsz" 30,"SOFT" 40; display:flex; align-items:center; gap:11px;
  }
  .branch > .sub { margin:0 0 22px; font-size:.9375rem; color:var(--ink-soft); }
  .node { padding-left:26px; border-left:2px solid var(--line-soft); margin-left:5px; }
  .cond { position:relative; font-size:.9688rem; font-weight:600; margin:20px 0 11px; color:var(--ink); }
  .cond::before { content:""; position:absolute; left:-27px; top:12px; width:17px; height:2px; background:var(--line-soft); }
  .cond span { color:var(--ink-soft); font-weight:400; }
  .out { display:flex; flex-wrap:wrap; gap:9px; }
  .pill {
    padding:7px 15px; border-radius:999px; font-size:.875rem; font-weight:500;
    background:var(--sunk); color:var(--ink); border:1px solid transparent;
  }
  .pill.hot { background:var(--accent); color:var(--ground); font-weight:600; }
  .pill.soft { background:transparent; color:var(--ink-soft); border:1px dashed var(--line); }

  /* ---------------- table ---------------- */
  .tablewrap {
    overflow-x:auto; background:var(--surface); border:1px solid var(--line);
    border-radius:var(--r); box-shadow:var(--shadow);
  }
  table { width:100%; border-collapse:collapse; font-size:.9375rem; min-width:660px; }
  th {
    text-align:left; padding:16px 20px; font-size:.7rem; font-weight:600; letter-spacing:.1em;
    text-transform:uppercase; color:var(--ink-faint); border-bottom:1px solid var(--line); white-space:nowrap;
  }
  td { padding:15px 20px; border-bottom:1px solid var(--line-soft); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  tr:hover td { background:var(--sunk); }
  td.v { font-weight:600; white-space:nowrap; font-family:var(--display); font-variation-settings:"opsz" 16; }
  td.w { color:var(--ink-soft); white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.n { color:var(--ink-soft); font-size:.9062rem; }
  .tag { font-size:.6875rem; font-weight:600; padding:3px 9px; border-radius:999px; white-space:nowrap; }
  .tag.ml  { background:var(--ml-soft);  color:var(--ml); }
  .tag.nlp { background:var(--nlp-soft); color:var(--nlp); }
  .tag.css { background:var(--css-soft); color:var(--css); }
  .tag.cau { background:var(--cau-soft); color:var(--cau); }
  .tag.other { background:var(--sunk); color:var(--ink-soft); }
  .hide { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="masthead">
      <span class="logo-word">Jinesis Lab</span>
      <div>
        <p class="eyebrow">Jinesis AI Research Lab</p>
        <h1>Where should I submit my project?</h1>
        <p class="lede">A guide to the venues we publish in.</p>
      </div>
    </div>

    <div id="upcoming"></div>

    <div class="axes">
      <p class="axes-intro">Three things decide this. It is worth weighing all of them together, since a venue that wins on one but loses badly on another is usually the wrong call.</p>
      <div class="axes-grid">

        <div class="axis">
          <div class="axis-h">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5.4l3.4 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <h3>Timeline</h3>
          </div>
          <p>Conferences have different deadlines, rebuttal periods, and when and where they actually take place. Choose a venue that is compatible with your own schedule.</p>
        </div>

        <div class="axis">
          <div class="axis-h">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="12" r="5.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="15" cy="12" r="5.6" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            <h3>Topic match</h3>
          </div>
          <p>Recently, the boundaries of conferences are blurring. LLM research is topic-wise applicable to almost all ML, NLP and AI conferences, but topic should still be considered. Some conferences have explicit main tracks like “Position Paper track” or “Computational Social Science track”, so have your paper and venue topic match in mind.</p>
        </div>

        <div class="axis">
          <div class="axis-h">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 21 8l-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3.5 12.5 12 17l8.5-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
            <h3>How the venue works</h3>
          </div>
          <dl class="axis-dl">
            <dt>Review process</dt>
            <dd><b>One-shot.</b> NeurIPS, ICML and ICLR run a single annual accept or reject.<br><br>
                <b>Iterative.</b> The ARR family reviews every 3 months or so, and the author then chooses whether to commit.</dd>
            <dt>Policy</dt>
            <dd>All conferences have different decision-driving policies.<br>
                For example, ICLR reviews are all public, 20 papers max per author.</dd>
          </dl>
        </div>

      </div>
    </div>

    <div class="tabs">
      <button class="tab on" id="t-guide" onclick="setTab('guide')">Guide me</button>
      <button class="tab"    id="t-chart" onclick="setTab('chart')">Full chart</button>
      <button class="tab"    id="t-all"   onclick="setTab('all')">All venues</button>
    </div>
  </header>

  <div id="guide"></div>
  <div id="chart" class="hide"></div>
  <div id="all"   class="hide"></div>
</div>

<script>
/* =================================================================
   VENUES
   \`window\` is the month a cycle typically lands in — deliberately
   coarse, because exact dates move every year.
================================================================= */
const V = {
  neurips: { tier:3, name:'NeurIPS', area:'ml', kind:'arch', window:'abstracts ~mid-May, papers ~late May', event:'6–12 Dec 2026', location:'Sydney, Australia (satellites: Atlanta, Paris)', month:5,
             process:'oneshot', tracks:['position'], recruiting:3, url:'https://neurips.cc',
             why:'The largest ML venue, and the strongest recruiting floor. Most company booths, and the recruiters who matter.' },
  icml:    { tier:3, name:'ICML', area:'ml', kind:'arch', window:'~late January', event:'Jul 2027', location:'TBA (2026 was Seoul)', month:1,
             process:'oneshot', tracks:['position'], recruiting:2, url:'https://icml.cc',
             why:'Core ML, equal standing with NeurIPS. Early-year cycle.' },
  iclr:    { tier:3, name:'ICLR', area:'ml', kind:'arch', window:'abstract 19 Sep, paper 25 Sep 2026', event:'26–30 Apr 2027', location:'Moscone Center, San Francisco', month:9, confirmed:true, deadline:'2026-09-19',
             process:'oneshot', publicReview:true, recruiting:2, cap:'max 20 submissions per author', url:'https://iclr.cc',
             why:'Open review, strong for representation learning and LLM work. Autumn cycle. Each author is capped at 20 submissions, so coordinate across the lab before everyone adds the same senior author.' },
  colm:    { tier:2, name:'COLM', area:'ml', kind:'arch', window:'~March', month:3,
             process:'oneshot', llm:true, url:'https://colmweb.org',
             why:'A dedicated language-modelling venue, and the right home for LLM-centric work.' },
  aaai:    { tier:1, name:'AAAI', area:'ml', kind:'arch', window:'abstract 21 Jul, paper 28 Jul 2026', deadline:'2026-07-28', event:'16–23 Feb 2027', location:'Montréal, Canada', month:8,
             process:'oneshot', tracks:['socialgood'], url:'https://aaai.org',
             why:'Broad AI. Has a dedicated AI for Social Good track.' },
  ijcai:   { tier:1, name:'IJCAI', area:'ml', kind:'arch', window:'~January', month:1,
             process:'oneshot', url:'https://www.ijcai.org',
             why:'Broad AI, strong internationally.' },

  arr:     { tier:4, name:'ARR', area:'nlp', kind:'arch', window:'rolling monthly cycles', rolling:true,
             process:'iterative', url:'https://aclrollingreview.org',
             why:'The front door for *ACL. Review once, then commit to a conference.' },
  acl:     { tier:4, commitment:true, name:'ACL', area:'nlp', kind:'arch', window:'commit via ARR', process:'iterative',
             tracks:['position','csstrack'], url:'https://aclanthology.org/venues/acl/',
             why:'Flagship NLP conference.' },
  emnlp:   { tier:4, commitment:true, name:'EMNLP', area:'nlp', kind:'arch', window:'ARR commitment 2 Aug 2026', deadline:'2026-08-02', event:'24–29 Oct 2026', location:'Budapest, Hungary', process:'iterative',
             tracks:['csstrack'], url:'https://aclanthology.org/venues/emnlp/',
             why:'Empirical methods, and the most common Jinesis commit target.' },
  naacl:   { tier:2, commitment:true, name:'NAACL', area:'nlp', kind:'arch', window:'ARR submission 12 Oct 2026', event:'1–5 Jun 2027', location:'San Francisco, USA', month:10, confirmed:true, deadline:'2026-10-12', process:'iterative',
             url:'https://aclanthology.org/venues/naacl/', why:'North American chapter.' },
  eacl:    { tier:2, commitment:true, name:'EACL', area:'nlp', kind:'arch', window:'commit via ARR', process:'iterative',
             url:'https://aclanthology.org/venues/eacl/', why:'European chapter.' },
  tacl:    { tier:3, name:'TACL', area:'nlp', kind:'journal', window:'1st of every month', rolling:true,
             process:'iterative', url:'https://transacl.org',
             why:'A journal. Reviewers hold a PhD or above, so review quality is markedly higher. An accepted TACL paper can still be presented at an *ACL conference as a poster or talk.' },

  www:     { tier:2, name:'WWW', area:'css', kind:'arch', window:'~October', month:10, process:'oneshot',
             url:'https://thewebconf.org', why:'Web-scale systems and social data.' },
  kdd:     { tier:2, name:'KDD', area:'css', kind:'arch', window:'~February', month:2, process:'oneshot',
             url:'https://kdd.org', why:'Data mining at scale.' },
  facct:   { tier:2, name:'FAccT', area:'css', kind:'arch', window:'~January', month:1, process:'oneshot',
             policy:true, url:'https://facctconference.org', why:'Fairness, accountability and transparency. Reaches a policy audience as well as a technical one.' },
  icwsm:   { tier:2, name:'ICWSM', area:'css', kind:'arch', window:'~January / September', month:1, process:'oneshot',
             url:'https://www.icwsm.org', why:'Web and social media.' },
  wsdm:    { tier:1, name:'WSDM', area:'css', kind:'arch', window:'~August', month:8, process:'oneshot',
             url:'https://www.wsdm-conference.org', why:'Search and data mining.' },
  cscw:    { tier:2, name:'CSCW', area:'css', kind:'arch', window:'~April / October', month:4, process:'oneshot',
             url:'https://cscw.acm.org', why:'Computer-supported cooperative work.' },
  aies:    { tier:2, name:'AIES', area:'css', kind:'arch', window:'~March', month:3, process:'oneshot',
             policy:true, url:'https://www.aies-conference.com', why:'AI, ethics and society. Strong policy readership.' },

  clear:   { tier:2, name:'CLeaR', area:'cau', kind:'arch', window:'~November', month:11, process:'oneshot', url:'',
             why:'The archival home for causal learning and reasoning.' },
  cdsm:    { tier:1, name:'Causal Data Science Meeting', area:'cau', kind:'nonarch', window:'~autumn', month:10,
             url:'https://www.causalscience.org',
             why:'Non-archival. Good for feedback without burning archival rights.' },
  mit:     { tier:1, name:'MIT Causality Meeting', area:'cau', kind:'nonarch', window:'varies', url:'',
             why:'Non-archival community meeting.' },
  wshop:   { name:'Conference workshops', area:'any', kind:'nonarch', window:'~2 months after the main deadline',
             rolling:true, url:'',
             why:'Non-archival workshops at NeurIPS, ICML and ICLR. Fast feedback, and the work stays submittable to an archival venue later.' },

  nature:  { name:'Nature (and similar journals)', area:'any', kind:'journal', window:'rolling submission',
             rolling:true, process:'iterative', broad:true, url:'https://www.nature.com',
             why:'For work whose result matters beyond the ML community. Review is long and demanding, so treat it as a separate project rather than a fallback.' },
};

const AREA_META = {
  ml:  { name:'Machine Learning', color:'var(--ml)',  soft:'var(--ml-soft)',  desc:'Core ML, deep learning, LLM capabilities' },
  nlp: { name:'NLP',              color:'var(--nlp)', soft:'var(--nlp-soft)', desc:'Language, anything that goes through ARR' },
  css: { name:'Comp. Social Science', color:'var(--css)', soft:'var(--css-soft)', desc:'Web, society, fairness, online behaviour' },
  cau: { name:'Causality',        color:'var(--cau)', soft:'var(--cau-soft)', desc:'Causal inference and discovery' },
};

/* =================================================================
   STATE
================================================================= */
let areas = new Set(), answers = {}, taclOpen = false;

/* Area-specific refinements. Shown for whichever areas are selected. */
const Q = {
  ml: [
    { key:'llm',  q:'Is the paper LLM-centric?', yes:'Yes, about language models', no:'No, general ML' },
  ],
  nlp: [
    { key:'arrstate', q:'Where are you in the ARR cycle?', opts:[
      { v:'none',    label:'Not submitted yet' },
      { v:'waiting', label:'Submitted, awaiting reviews' },
      { v:'reviews', label:'Reviews are in' },
    ]},
  ],
  cau: [
    { key:'archival', q:'Does it need to be archival?', yes:'Yes, archival', no:'No, feedback first' },
  ],
  css: [
    { key:'flavour', q:'What is the emphasis?', opts:[
      { v:'scale',    label:'Web and data at scale' },
      { v:'ethics',   label:'Fairness and ethics' },
      { v:'platform', label:'Social platforms and people' },
    ]},
  ],
};

/* Asked whatever the area. One question per decision axis. */
const SHARED = [
  { key:'ready', q:'When will the paper realistically be ready?', opts:[
    { v:'soon',  label:'Within about a month' },
    { v:'mid',   label:'Two to three months' },
    { v:'later', label:'Four months or more' },
  ]},
  { key:'travel', q:'Could you travel to present it?', opts:[
    { v:'yes',   label:'Yes, anywhere' },
    { v:'local', label:'Only if nearby' },
    { v:'no',    label:'Unlikely' },
  ]},
  { key:'audience', q:'Who most needs to read this?', opts:[
    { v:'field',  label:'The ML / NLP community' },
    { v:'policy', label:'Policy and ethics readers' },
    { v:'broad',  label:'A broad scientific audience' },
  ]},
  { key:'track', q:'Does it fit a special track?', opts:[
    { v:'position',   label:'Position paper' },
    { v:'csstrack',   label:'Comp. Social Science' },
    { v:'socialgood', label:'AI for Social Good' },
    { v:'none',       label:'No, main track' },
  ]},
  { key:'process', q:'Which review process suits it better?', opts:[
    { v:'oneshot',   label:'One-shot annual decision' },
    { v:'iterative', label:'Iterative, revise then commit' },
    { v:'either',    label:'No preference' },
  ]},
  { key:'publicrev', q:'Are public reviews acceptable?', opts:[
    { v:'yes', label:'Yes, fine' },
    { v:'no',  label:'Prefer them private' },
  ]},
  { key:'job', q:'Are you on the job market this cycle?', opts:[
    { v:'yes', label:'Yes' },
    { v:'no',  label:'No' },
  ]},
];

/* union of the selected areas' questions, in a stable order */
function allQuestions() {
  const seen = new Set(), out = [];
  for (const k of Object.keys(Q))
    if (areas.has(k)) for (const q of Q[k]) if (!seen.has(q.key)) { seen.add(q.key); out.push(q); }
  return [...out, ...SHARED];
}

/* =================================================================
   TIMELINE

   Everything below is measured against today's real date, so the
   same answers rank differently in March and in October.
================================================================= */
const TODAY = new Date();
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

/** whole months from today to a venue's typical month (0 = this month) */
function monthsAway(m) {
  if (!m) return null;
  return (m - (TODAY.getUTCMonth() + 1) + 12) % 12;
}

const TODAY_ISO = new Date(TODAY.toISOString().slice(0, 10) + 'T00:00:00Z');

/** days to a venue's exact deadline; negative once it has passed */
function daysUntil(v) {
  if (!v.deadline) return null;
  return Math.round((new Date(v.deadline + 'T00:00:00Z') - TODAY_ISO) / 864e5);
}

/** a dated deadline in the past means this cycle is over, not that it is imminent */
const isClosed = v => { const d = daysUntil(v); return d !== null && d < 0; };

/** months to the next usable cycle: a closed one rolls to next year */
function nextCycleMonths(v) {
  if (v.rolling) return 0;
  const m = monthsAway(v.month);
  if (m === null) return null;
  return isClosed(v) && m <= 1 ? m + 12 : m;
}

/** how far out the author can be ready, as a band of months */
const HORIZON = { soon:{ min:0, max:2 }, mid:{ min:2, max:5 }, later:{ min:4, max:12 } };

function awayLabel(v) {
  if (isClosed(v)) {
    const yr = Number(v.deadline.slice(0, 4));
    return v.month
      ? \`\${yr} cycle closed, next around \${MONTHS[v.month - 1]} \${yr + 1}\`
      : \`\${yr} cycle closed, next window not announced\`;
  }
  const d = daysUntil(v);
  if (d !== null) return d === 0 ? 'due today' : \`in \${d} days\`;
  // a real dated cycle beats the generic commitment note
  if (v.commitment && !v.month) return 'timed off your ARR review cycle';
  if (v.rolling && !v.month) return 'open now, rolling';
  const n = monthsAway(v.month);
  if (n === null) return null;
  if (n === 0) return 'this month';
  return \`about \${n} month\${n === 1 ? '' : 's'} away (\${MONTHS[v.month - 1]})\`;
}

/* =================================================================
   RECOMMENDATION

   Each venue is scored against the answers and today's date, then
   ranked. Every rule records why it fired, so a card can show what
   moved it rather than asking the reader to trust the order.
================================================================= */
function recommend() {
  const a = answers, notes = [];
  const note = (t, b) => notes.push({ title:t, body:b });
  const inArea = k => areas.has(k);

  /* pull in out-of-area venues when an answer clearly points at them */
  const cross = new Set();
  if (a.process === 'iterative' && !inArea('nlp')) { cross.add('arr'); cross.add('tacl'); }
  if (a.track === 'csstrack' && !inArea('css'))    { cross.add('facct'); cross.add('icwsm'); }
  if (a.audience === 'policy' && !inArea('css'))   { cross.add('facct'); cross.add('aies'); }
  if (!inArea('nlp')) cross.add('arr');   // the lab's default route, always on the table

  const pool = Object.entries(V)
    .filter(([k, v]) => areas.has(v.area) || v.area === 'any' || cross.has(k))
    .map(([k, v]) => ({ key:k, ...v, score:0, reasons:[] }));

  const hit = (v, pts, reason) => { v.score += pts; if (reason) v.reasons.push(reason); };

  for (const v of pool) {
    if (areas.has(v.area))  hit(v, 6 + (v.tier ?? 0));   // standing breaks default ties
    if (v.area === 'any')   hit(v, -2);
    if (cross.has(v.key))   hit(v, 6, 'better fit for what you asked for');

    /* --- Topic match --- */
    if (a.llm === 'yes' && v.llm)            hit(v, 6, 'built for LLM work');
    if (a.llm === 'no'  && v.llm)            hit(v, -4);
    if (a.track && a.track !== 'none' && v.tracks?.includes(a.track))
                                             hit(v, 7, 'runs that track');
    if (a.audience === 'broad'  && v.broad)  hit(v, 9, 'reaches beyond the field');
    if (a.audience === 'broad'  && !v.broad) hit(v, -3);
    if (a.audience === 'policy' && v.policy) hit(v, 7, 'strong policy readership');
    if (a.audience === 'field'  && v.broad)  hit(v, -8);

    /* --- How the venue works --- */
    if (a.process && a.process !== 'either' && v.process === a.process)
      hit(v, 4, a.process === 'oneshot' ? 'one-shot, as you preferred' : 'iterative, as you preferred');
    if (a.process && a.process !== 'either' && v.process && v.process !== a.process)
      hit(v, -3);
    if (a.publicrev === 'no' && v.publicReview) hit(v, -6, 'reviews are public');

    /* --- Timeline baseline: applies even with nothing answered, so a cycle
           that is imminent outranks one nine months out. --- */
    const nm = nextCycleMonths(v);
    if (isClosed(v))            hit(v, -8, 'this cycle has closed');
    else if (v.rolling)         hit(v, 5, 'open now, submit any time');
    else if (nm === null)       hit(v, 0);
    else if (nm <= 2)           hit(v, 4, 'deadline is near');
    else if (nm <= 5)           hit(v, 1);
    else if (nm >= 8)           hit(v, -3, 'next cycle is far off');

    if (v.key === 'arr')        hit(v, 3, "the lab's default route");

    /* --- Timeline, sharpened once readiness is known --- */
    if (a.ready) {
      const h = HORIZON[a.ready], away = nextCycleMonths(v);
      if (v.rolling)                           hit(v, a.ready === 'later' ? 2 : 4, 'you can submit any time');
      else if (away === null)                  hit(v, 0);
      else if (away >= h.min && away <= h.max) hit(v, 5, \`cycle lands \${awayLabel(v)}\`);
      else if (away < h.min)                   hit(v, -5, 'deadline lands before you are ready');
      else                                     hit(v, -3, 'next cycle is further out than you need');
    }

    /* --- ARR is two steps: submit to a cycle, then commit to a conference.
           Which venues matter depends entirely on where you already are. --- */
    if (a.arrstate === 'none') {
      if (v.key === 'arr')   hit(v, 8, 'the step you are at now');
      if (v.commitment)      hit(v, -7, 'you choose this after reviews, not now');
    }
    if (a.arrstate === 'waiting') {
      if (v.key === 'arr')   hit(v, -6, 'already submitted');
      if (v.commitment)      hit(v, 4, 'your likely commitment target');
    }
    if (a.arrstate === 'reviews') {
      if (v.key === 'arr')   hit(v, -8, 'already reviewed');
      if (v.commitment)      hit(v, 9, 'commit here now that reviews are in');
      if (v.key === 'tacl')  hit(v, 3, 'alternative if the reviews disappointed');
    }

    /* --- Jinesis specifics --- */
    if (a.job === 'yes' && v.recruiting) hit(v, v.recruiting * 2, 'heavy recruiter presence');
    if (a.strong === 'yes' && a.badarr === 'yes' && v.key === 'tacl') hit(v, 12, 'PhD-and-above reviewers');
    if (a.strong !== 'yes' && v.key === 'tacl') hit(v, -6);
    if (inArea('cau')) {
      if (a.archival === 'yes' && v.kind === 'nonarch') hit(v, -8);
      if (a.archival === 'no'  && v.kind === 'nonarch') hit(v, 6, 'keeps archival rights free');
    }
    if (inArea('css') && a.flavour) {
      const g = { scale:['www','kdd','wsdm'], ethics:['facct','aies'], platform:['icwsm','cscw'] };
      if (g[a.flavour]?.includes(v.key)) hit(v, 7, 'matches your emphasis');
    }
  }

  const list = pool.sort((x, y) => y.score - x.score).filter(v => v.score > -4).slice(0, 7);
  const top  = list[0]?.score ?? 0;
  list.forEach(v => { v.primary = v.score === top; });

  /* ---- notes: things a ranking cannot say ---- */
  if (a.ready === 'soon')
    note('Timeline is the binding constraint', 'With about a month to go, the question is which deadline you can actually make. Windows here are typical, so confirm the real date before committing.');
  if (a.travel === 'no')
    note('Check the presentation format', 'If travel is unlikely, confirm the venue allows remote or poster-only presentation. Some require an author to attend in person.');
  if (a.travel === 'local')
    note('Location is part of the timeline', 'Where a conference is held matters as much as when. Compare locations before you pick, and read the reimbursement policy early.');
  if (a.audience === 'broad')
    note('Journals run on a different clock', 'A broad-audience journal can take many months and several rounds. Plan it as its own project, and consider a conference version alongside it.');
  if (a.process === 'iterative' && inArea('ml') && !inArea('nlp'))
    note('The ML venues are one-shot', 'NeurIPS, ICML and ICLR all run a single annual accept or reject. ARR has been added above since you would rather revise before committing.');
  if (a.process === 'oneshot' && inArea('nlp'))
    note('The ARR route is iterative by design', 'ARR gives you reviews first and a commitment step after. If a single decision matters more, weigh the ML venues.');
  if (a.arrstate === 'none')
    note('Two deadlines, not one', 'ARR submission and conference commitment are separate events with separate dates. Submit to an ARR cycle first; you pick the conference later, once reviews are back.');
  if (a.arrstate === 'waiting')
    note('Line up the commitment window now', 'Each conference only accepts commitments from certain ARR cycles, and the commitment deadline can fall within days of the next ARR submission date. Check which conferences your cycle is eligible for before reviews arrive.');
  if (a.arrstate === 'reviews')
    note('Commit before the window closes', 'Reviews carry over, so the remaining decision is which conference to commit to. If the scores are weak, withdrawing and resubmitting to a later cycle is a real option.');
  if (inArea('nlp'))
    note('Live dates live in the deadline tracker', 'Windows here are typical, not current. ARR cycle and commitment dates are maintained in the lab deadline tracker at jinesis-admin.vercel.app/adminbot/deadlines, which is the authority.');
  if (a.track === 'position')
    note('Confirm the track exists this cycle', 'Position paper tracks come and go. Check it is running before you plan around it.');
  if (areas.size > 1)
    note('This paper spans areas', \`You picked \${[...areas].map(k => AREA_META[k].name).join(' and ')}. Venues from each are ranked together, so compare the top two or three rather than defaulting to the field you know best.\`);
  if (inArea('nlp') && !list.some(v => v.key === 'tacl' && v.primary))
    note('Commit rule of thumb', 'ARR reviews carry over, so submit once and commit to whichever of ACL, EMNLP, NAACL or EACL has the next workable cycle. Record the choice as commit_venue on the paper.');

  return { list, notes };
}

/* =================================================================
   TACL DRAWER

   TACL is only worth raising once ARR is already the answer, so these
   two questions hang off the ARR card instead of cluttering the main
   list for everyone.
================================================================= */
function taclDrawer() {
  if (!taclOpen) return \`<button class="tacl-open" onclick="event.preventDefault();openTacl()">
      Considering TACL instead? <span>→</span></button>\`;

  const qs = [
    { key:'strong', q:'Is this a really strong paper, 4 out of 5 in your heart?',
      opts:[{v:'yes',label:'Yes'},{v:'no',label:'Not quite'}] },
    { key:'badarr', q:'Has ARR reviewing on this line of work been unprofessional?',
      opts:[{v:'yes',label:'Yes, repeatedly'},{v:'no',label:'No'}] },
  ];
  const both = answers.strong === 'yes' && answers.badarr === 'yes';
  const answered = qs.every(q => answers[q.key]);

  return \`<div class="tacl-drawer">
    <div class="tacl-h">When TACL is the better route
      <button class="tacl-close" onclick="event.preventDefault();closeTacl()">close</button></div>
    \${qs.map(q => \`<div class="tacl-q">
      <span>\${q.q}</span>
      <span class="chips">\${q.opts.map(o =>
        \`<button class="chip \${answers[q.key]===o.v?'on':''}"
                 onclick="event.preventDefault();answer('\${q.key}','\${o.v}')">\${o.label}</button>\`).join('')}</span>
    </div>\`).join('')}
    \${!answered ? '' : both
      ? \`<div class="tacl-yes"><b>Go to TACL.</b> A strong paper plus a bad run of ARR reviewing is exactly the
         case for it: reviewers hold a PhD or above, submissions open on the 1st of every month, and an accepted
         TACL paper can still be presented at an *ACL conference as a poster or talk.
         <a href="https://transacl.org" target="_blank" rel="noopener">transacl.org ↗</a></div>\`
      : \`<div class="tacl-no"><b>Stay with ARR.</b> TACL is worth the slower journal cycle only when the paper is
         strong <em>and</em> ARR reviewing has repeatedly let it down. Otherwise submit to the next ARR cycle
         and commit as usual.</div>\`}
  </div>\`;
}
const openTacl  = () => { taclOpen = true;  renderGuide(); };
const closeTacl = () => { taclOpen = false; delete answers.strong; delete answers.badarr; renderGuide(); };

/* =================================================================
   RENDER, guide
================================================================= */
function renderGuide() {
  const el = document.getElementById('guide');

  let html = \`<div class="step">
    <div class="step-n"><i>1</i> Area &nbsp;·&nbsp; pick as many as apply</div>
    <p class="q">What is this paper mainly about?</p>
    <div class="cards">
      \${Object.entries(AREA_META).map(([k,m]) => \`
        <button class="card \${areas.has(k)?'on':''}" style="--pick:\${m.color};--pick-soft:\${m.soft}"
                aria-pressed="\${areas.has(k)}" onclick="pickArea('\${k}')">
          <h3><span class="dot" style="background:\${m.color}"></span>\${m.name}
            <span class="tick">\${areas.has(k) ? '✓' : ''}</span></h3>
          <p>\${m.desc}</p>
        </button>\`).join('')}
    </div></div>\`;

  if (areas.size) {
    const qs = allQuestions();
    const rows = qs.map(q => {
      const opts = q.opts || [{ v:'yes', label:q.yes }, { v:'no', label:q.no }];
      return \`<div class="qrow">
        <div class="qrow-q">\${q.q}</div>
        <div class="chips">\${opts.map(o =>
          \`<button class="chip \${answers[q.key]===o.v?'on':''}"
                   onclick="answer('\${q.key}','\${o.v}')">\${o.label}</button>\`).join('')}</div>
      </div>\`;
    }).join('');

    const answered = qs.filter(q => answers[q.key]).length;
    html += \`<div class="step">
      <div class="step-n"><i>2</i> Refine &nbsp;·&nbsp; \${answered} of \${qs.length} answered</div>
      <p class="q">Anything you answer sharpens the result. Skip what does not apply.</p>
      <div class="refine">\${rows}</div></div>\`;

    const { list, notes } = recommend();
    const stamp = TODAY.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
    html += \`<div class="step">
      <div class="res-head">
        <h2>Recommended venues</h2>
        <button class="reset" onclick="reset()">Start over ↺</button>
      </div>
      <p class="stamp">Ranked for today, \${stamp}. Distances counted from this month.</p>
      \${list.map((v,i) => \`
        <div class="venue \${v.primary?'primary':''}">
          <div class="rank">\${i+1}</div>
          <div class="v-body">
            <div class="v-top">
              <span class="v-name">\${v.name}</span>
              \${v.primary ? '<span class="badge first">First choice</span>' : ''}
              <span class="badge \${v.kind}">\${
                v.kind==='arch'?'Archival':v.kind==='nonarch'?'Non-archival':'Journal'}</span>
            </div>
            <p class="v-why">\${v.why}</p>
            \${v.reasons?.length ? \`<div class="reasons">\${v.reasons.map(r=>\`<span class="reason">\${r}</span>\`).join('')}</div>\` : ''}
            <div class="v-meta">
              <span>\${v.confirmed?'Deadline':'Typical window'}: <b>\${v.window}</b>\${v.confirmed?' ✓':''}</span>
              \${awayLabel(v) ? \`<span class="away">\${awayLabel(v)}</span>\` : ''}
              \${v.location ? \`<span class="uloc">📍 \${v.location}\${v.event ? \` · \${v.event}\` : ''}</span>\` : ''}
              \${v.cap?\`<span class="cap">⚑ \${v.cap}</span>\`:''}
              \${v.url?\`<a href="\${v.url}" target="_blank" rel="noopener">official site ↗</a>\`:''}
            </div>
            \${v.key === 'arr' && v.primary ? taclDrawer() : ''}
          </div>
        </div>\`).join('')}
      \${notes.map(n => \`<div class="note"><b>\${n.title}.</b> \${n.body}</div>\`).join('')}
    </div>\`;
  }
  el.innerHTML = html;
}

const pickArea = k => { areas.has(k) ? areas.delete(k) : areas.add(k); renderGuide(); };
const answer   = (k,v) => { answers[k] = (answers[k]===v ? undefined : v); renderGuide(); };
const reset    = () => { areas = new Set(); answers = {}; taclOpen = false; renderGuide(); window.scrollTo({top:0,behavior:'smooth'}); };

/* =================================================================
   RENDER — full chart
================================================================= */
function renderChart() {
  /* a pill that names a venue links to it; note-pills stay plain text */
  const P = (n, cls='') => {
    if (cls.includes('soft')) return \`<span class="pill \${cls}">\${n}</span>\`;
    const v = Object.values(V).find(x => n === x.name) ||
              Object.values(V).find(x => n.startsWith(x.name + ':') || n.startsWith(x.name + ' '));
    return v?.url
      ? \`<a class="pill \${cls}" href="\${v.url}" target="_blank" rel="noopener">\${n} <span class="pgo">↗</span></a>\`
      : \`<span class="pill \${cls}">\${n}</span>\`;
  };
  const br = (key, title, body) => \`<div class="branch">
      <h3><span class="dot" style="background:\${AREA_META[key].color}"></span>\${AREA_META[key].name}</h3>
      <p class="sub">\${title}</p><div class="node">\${body}</div></div>\`;

  document.getElementById('chart').innerHTML = \`<div class="chart">
    \${br('ml', 'Where most Jinesis papers go, alongside the ARR track.', \`
      <div class="cond">The result is strong and complete <span>→ aim for the big three, and let the next deadline decide which</span></div>
      <div class="out">\${P('NeurIPS','hot')}\${P('ICML','hot')}\${P('ICLR','hot')}</div>
      <div class="out"><span class="pill soft">ICLR caps each author at 20 submissions per cycle, so coordinate before everyone lists the same senior author</span></div>
      <div class="cond">It is also LLM-centric <span>→ add a smaller, better-matched audience</span></div>
      <div class="out">\${P('COLM','hot')}</div>
      <div class="cond">You are on the job market this cycle <span>→ weight toward reach over acceptance odds</span></div>
      <div class="out">\${P('NeurIPS','hot')}<span class="pill soft">most recruiters · 10–30k attendees</span></div>
      <div class="cond">Broader AI, or the big three did not land <span>→ still solid, less competitive</span></div>
      <div class="out">\${P('AAAI')}\${P('IJCAI')}</div>\`)}

    \${br('nlp', 'Everything goes through ARR unless you deliberately pick the journal.', \`
      <div class="cond">Default route <span>→ review once, then commit to a conference</span></div>
      <div class="out">\${P('ARR','hot')}<span class="pill soft">→</span>\${P('EMNLP')}\${P('ACL')}\${P('NAACL')}\${P('EACL')}</div>
      <div class="cond">Strong paper (4/5) <b>and</b> ARR reviewing has repeatedly disappointed <span>→ take the journal route instead</span></div>
      <div class="out">\${P('TACL','hot')}</div>
      <div class="out"><span class="pill soft">submissions on the 1st of each month · reviewers hold a PhD or above · still presentable at an *ACL conference</span></div>\`)}

    \${br('css', 'Choose by emphasis, not by prestige tier.', \`
      <div class="cond">Web and data at scale <span>→</span></div>
      <div class="out">\${P('WWW')}\${P('KDD')}\${P('WSDM')}</div>
      <div class="cond">Fairness and ethics <span>→</span></div>
      <div class="out">\${P('FAccT')}\${P('AIES')}</div>
      <div class="cond">Social platforms and the people on them <span>→</span></div>
      <div class="out">\${P('ICWSM')}\${P('CSCW')}</div>\`)}

    \${br('cau', 'Decide archival or not first, because it constrains everything downstream.', \`
      <div class="cond">It needs to be archival <span>→</span></div>
      <div class="out">\${P('CLeaR','hot')}</div>
      <div class="cond">You want feedback while keeping it submittable <span>→</span></div>
      <div class="out">\${P('Causal Data Science Meeting')}\${P('MIT Causality Meeting')}\${P('Big-conference workshops')}</div>
      <div class="out"><span class="pill soft">non-archival, so it spends none of your archival rights</span></div>\`)}

    <div class="branch">
      <h3><span class="dot" style="background:var(--faint)"></span>Occasionally</h3>
      <p class="sub">Outside the usual rotation.</p>
      <div class="node">
        <div class="cond">The work reaches beyond the ML community <span>→ plan the timeline separately</span></div>
        <div class="out">\${P('Nature and similar journals')}<span class="pill soft">months, not weeks</span></div>
      </div>
    </div>
  </div>\`;
}

/* =================================================================
   RENDER — all venues
================================================================= */
function renderAll() {
  const groups = [
    ['ml',  'Machine Learning'],
    ['nlp', 'NLP'],
    ['css', 'Computational Social Science'],
    ['cau', 'Causality'],
    ['any', 'Cross-cutting'],
  ];
  const kindLabel = k => k === 'arch' ? 'Archival' : k === 'nonarch' ? 'Non-archival' : 'Journal';

  document.getElementById('all').innerHTML = groups.map(([key, label]) => {
    const rows = Object.values(V).filter(v => v.area === key);
    if (!rows.length) return '';
    return \`<section class="vgroup">
      <h2 class="vgroup-h"><span class="dot" style="background:\${
        key === 'any' ? 'var(--ink-faint)' : AREA_META[key].color}"></span>\${label}</h2>
      <div class="vlist">
        \${rows.map(v => \`
          <article class="vcard">
            <div class="vcard-top">
              <h3>\${v.url
                ? \`<a href="\${v.url}" target="_blank" rel="noopener">\${v.name} <span class="ext">↗</span></a>\`
                : v.name}</h3>
              <span class="badge \${v.kind}">\${kindLabel(v.kind)}</span>
            </div>
            <p class="vcard-why">\${v.why}</p>
            <div class="vcard-meta">
              <span>\${v.confirmed?'Deadline':'Typical window'}: <b>\${v.window}</b>\${v.confirmed?' ✓':''}</span>
              \${v.location ? \`<span class="uloc">📍 \${v.location}\${v.event ? \` · \${v.event}\` : ''}</span>\` : ''}
              \${v.cap ? \`<span class="cap">⚑ \${v.cap}</span>\` : ''}
            </div>
          </article>\`).join('')}
      </div>
    </section>\`;
  }).join('');
}

/* =================================================================
   UPCOMING BANNER

   Only venues with a confirmed date appear here. A typical window is
   not good enough to headline, and the list re-sorts itself as dates
   pass, so it never needs editing by hand.
================================================================= */
function renderUpcoming() {
  const today = new Date(TODAY.toISOString().slice(0, 10) + 'T00:00:00Z');
  const soon = Object.values(V)
    .filter(v => v.confirmed && v.deadline)
    .map(v => ({ ...v, days: Math.round((new Date(v.deadline + 'T00:00:00Z') - today) / 864e5) }))
    .filter(v => v.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, 2);

  if (!soon.length) { document.getElementById('upcoming').innerHTML = ''; return; }

  document.getElementById('upcoming').innerHTML = \`
    <p class="ulabel"><span class="pulse"></span>Upcoming deadlines</p>
    <div class="ugrid">
      \${soon.map(v => {
        const tag = v.url ? 'a' : 'div';
        const href = v.url ? \` href="\${v.url}" target="_blank" rel="noopener"\` : '';
        return \`<\${tag} class="ucard"\${href}>
          <span class="ucount"><b>\${v.days}</b><span>\${v.days === 1 ? 'day' : 'days'}</span></span>
          <span class="uinfo">
            <span class="uname">\${v.name}</span>
            <span class="udate">\${v.window}</span>
          </span>
          \${v.url ? '<span class="ugo">↗</span>' : ''}
        </\${tag}>\`;
      }).join('')}
    </div>\`;
}

/* =================================================================
   TABS
================================================================= */
function setTab(t) {
  for (const k of ['guide','chart','all']) {
    document.getElementById(k).classList.toggle('hide', k !== t);
    document.getElementById('t-'+k).classList.toggle('on', k === t);
  }
}

renderUpcoming(); renderGuide(); renderChart(); renderAll();
</script>
</body>
</html>
`;
}
