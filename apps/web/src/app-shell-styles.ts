import { css } from "lit";

export const appShellStyles = css`
  :host {
    --surface-0: #090d0b;
    --surface-1: #0e1511;
    --surface-2: #131c17;
    --surface-3: #18231d;
    --surface-hover: #1d2a23;
    --text-strong: #f1f6f2;
    --text: #d5ded8;
    --text-muted: #89978f;
    --text-faint: #627068;
    --border: #26332c;
    --border-strong: #34443b;
    --accent: #77e5ad;
    --accent-strong: #9af0c3;
    --accent-ink: #062417;
    --accent-soft: rgb(65 198 132 / 12%);
    --warning: #e8bd6b;
    --warning-soft: rgb(232 189 107 / 9%);
    --danger: #f28e8e;
    --shadow: 0 1.4rem 4rem rgb(0 0 0 / 32%);
    display: block;
    min-height: 100vh;
    color: var(--text);
    background: var(--surface-0);
    color-scheme: dark;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  :host([data-theme="light"]) {
    --surface-0: #f0f3ef;
    --surface-1: #f8faf7;
    --surface-2: #ffffff;
    --surface-3: #edf2ed;
    --surface-hover: #e7eee8;
    --text-strong: #152019;
    --text: #344139;
    --text-muted: #6b776f;
    --text-faint: #8a958d;
    --border: #d9e0da;
    --border-strong: #c5cfc7;
    --accent: #18724e;
    --accent-strong: #0e5b3c;
    --accent-ink: #f4fff8;
    --accent-soft: rgb(24 114 78 / 9%);
    --warning: #97671e;
    --warning-soft: rgb(151 103 30 / 8%);
    --danger: #ad3f3f;
    --shadow: 0 1.4rem 4rem rgb(38 55 43 / 12%);
    color-scheme: light;
  }

  * {
    box-sizing: border-box;
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
  }

  button,
  a {
    -webkit-tap-highlight-color: transparent;
  }

  .shell {
    display: grid;
    grid-template-columns: 17rem minmax(0, 1fr);
    min-height: 100vh;
    background:
      radial-gradient(circle at 78% -12%, var(--accent-soft), transparent 31rem),
      var(--surface-0);
  }

  .sidebar {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  }

  .brand {
    display: flex;
    gap: 0.78rem;
    align-items: center;
    height: 5rem;
    padding: 0 1.15rem;
    color: var(--text-strong);
    text-decoration: none;
  }

  .brand-mark {
    position: relative;
    display: grid;
    place-items: center;
    width: 2.45rem;
    height: 2.45rem;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
    border-radius: 0.78rem;
    color: var(--accent-ink);
    background: var(--accent);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 1.15rem;
    font-weight: 700;
    box-shadow: 0 0.55rem 1.6rem color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .brand-mark::after {
    position: absolute;
    right: -0.2rem;
    bottom: -0.45rem;
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 999px;
    background: color-mix(in srgb, white 28%, transparent);
    content: "";
  }

  .brand-copy {
    display: grid;
    min-width: 0;
  }

  .brand-name {
    font-size: 0.96rem;
    font-weight: 760;
    letter-spacing: -0.015em;
  }

  .brand-subtitle {
    margin-top: 0.12rem;
    color: var(--text-muted);
    font-size: 0.69rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .navigation {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.6rem 0.72rem 1.5rem;
    scrollbar-width: thin;
  }

  .nav-group + .nav-group {
    margin-top: 1.35rem;
  }

  .nav-group-label {
    margin: 0 0 0.45rem;
    padding: 0 0.65rem;
    color: var(--text-faint);
    font-size: 0.63rem;
    font-weight: 780;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .nav-item {
    display: grid;
    grid-template-columns: 1.65rem minmax(0, 1fr) auto;
    gap: 0.42rem;
    align-items: center;
    min-height: 2.55rem;
    margin: 0.12rem 0;
    border: 1px solid transparent;
    border-radius: 0.7rem;
    padding: 0.35rem 0.55rem;
    color: var(--text-muted);
    text-decoration: none;
    transition: 120ms ease;
    transition-property: color, border-color, background;
  }

  .nav-item:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  .nav-item[aria-current="page"] {
    border-color: color-mix(in srgb, var(--accent) 18%, var(--border));
    color: var(--text-strong);
    background: var(--accent-soft);
  }

  .nav-number {
    display: grid;
    place-items: center;
    height: 1.42rem;
    border: 1px solid var(--border);
    border-radius: 0.42rem;
    color: var(--text-faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.58rem;
  }

  .nav-item[aria-current="page"] .nav-number {
    border-color: color-mix(in srgb, var(--accent) 32%, var(--border));
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
  }

  .nav-text {
    overflow: hidden;
    font-size: 0.79rem;
    font-weight: 590;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nav-status {
    width: 0.38rem;
    height: 0.38rem;
    border: 1px solid var(--text-faint);
    border-radius: 999px;
  }

  .nav-status--live {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: 0 0 0.55rem color-mix(in srgb, var(--accent) 42%, transparent);
  }

  .sidebar-footer {
    margin: 0 0.72rem 0.78rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 0.76rem;
    color: var(--text-faint);
    background: var(--surface-2);
    font-size: 0.67rem;
    line-height: 1.45;
  }

  .sidebar-footer strong {
    display: block;
    margin-bottom: 0.2rem;
    color: var(--text-muted);
    font-size: 0.7rem;
  }

  .workspace {
    min-width: 0;
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 5rem;
    border-bottom: 1px solid var(--border);
    padding: 0 clamp(1.1rem, 3vw, 2.5rem);
    background: color-mix(in srgb, var(--surface-0) 86%, transparent);
    backdrop-filter: blur(18px);
  }

  .route-context {
    display: grid;
    gap: 0.18rem;
  }

  .route-context span {
    color: var(--text-faint);
    font-size: 0.65rem;
    font-weight: 750;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .route-context strong {
    color: var(--text-strong);
    font-size: 0.9rem;
    font-weight: 660;
  }

  .topbar-actions {
    display: flex;
    gap: 0.55rem;
    align-items: center;
  }

  .environment {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.37rem 0.65rem;
    color: var(--text-muted);
    background: var(--surface-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.62rem;
  }

  .icon-button {
    min-height: 2.15rem;
    border: 1px solid var(--border);
    border-radius: 0.62rem;
    padding: 0.42rem 0.65rem;
    color: var(--text);
    background: var(--surface-2);
    font-size: 0.69rem;
    font-weight: 680;
    cursor: pointer;
  }

  .icon-button:hover {
    border-color: var(--border-strong);
    background: var(--surface-hover);
  }

  .menu-button {
    display: none;
  }

  .content {
    width: min(86rem, 100%);
    margin: 0 auto;
    padding: clamp(1.5rem, 4vw, 3.5rem);
  }

  .page-heading {
    display: flex;
    gap: 1.2rem;
    align-items: end;
    justify-content: space-between;
    margin-bottom: 1.65rem;
  }

  .eyebrow {
    margin: 0 0 0.52rem;
    color: var(--accent);
    font-size: 0.65rem;
    font-weight: 790;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin-top: 0;
  }

  h1 {
    margin-bottom: 0.62rem;
    color: var(--text-strong);
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(2.1rem, 5vw, 4.2rem);
    font-weight: 500;
    letter-spacing: -0.045em;
    line-height: 0.98;
  }

  .page-description {
    max-width: 43rem;
    margin-bottom: 0;
    color: var(--text-muted);
    font-size: 0.92rem;
    line-height: 1.6;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    justify-content: flex-end;
  }

  .badge {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.38rem 0.64rem;
    color: var(--text-muted);
    background: var(--surface-2);
    font-size: 0.63rem;
    font-weight: 700;
    letter-spacing: 0.045em;
    text-transform: uppercase;
  }

  .badge--live {
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
    color: var(--accent-strong);
    background: var(--accent-soft);
  }

  .badge--pending {
    border-color: color-mix(in srgb, var(--warning) 28%, var(--border));
    color: var(--warning);
    background: var(--warning-soft);
  }

  .hero {
    position: relative;
    overflow: hidden;
    min-height: 21rem;
    border: 1px solid var(--border);
    border-radius: 1.3rem;
    padding: clamp(1.6rem, 4vw, 3.4rem);
    background:
      linear-gradient(125deg, var(--surface-2), color-mix(in srgb, var(--surface-2) 82%, var(--accent))),
      var(--surface-2);
    box-shadow: var(--shadow);
  }

  .hero::before,
  .hero::after {
    position: absolute;
    border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
    border-radius: 999px;
    content: "";
  }

  .hero::before {
    top: -9rem;
    right: -7rem;
    width: 24rem;
    height: 24rem;
  }

  .hero::after {
    top: -3rem;
    right: -1rem;
    width: 12rem;
    height: 12rem;
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .hero-copy {
    position: relative;
    z-index: 1;
    max-width: 49rem;
  }

  .hero h1 {
    max-width: 13ch;
    font-size: clamp(3rem, 7.2vw, 6.7rem);
  }

  .hero p:not(.eyebrow) {
    max-width: 38rem;
    margin-bottom: 1.5rem;
    color: var(--text-muted);
    font-size: 1rem;
    line-height: 1.65;
  }

  .primary-link {
    display: inline-flex;
    gap: 0.55rem;
    align-items: center;
    border-radius: 0.7rem;
    padding: 0.78rem 1rem;
    color: var(--accent-ink);
    background: var(--accent);
    font-size: 0.77rem;
    font-weight: 780;
    text-decoration: none;
  }

  .primary-link:hover {
    background: var(--accent-strong);
  }

  .overview-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.9rem;
    margin-top: 0.9rem;
  }

  .overview-card,
  .surface,
  .port-notice {
    border: 1px solid var(--border);
    border-radius: 1rem;
    background: var(--surface-2);
  }

  .overview-card {
    min-height: 10rem;
    padding: 1.15rem;
  }

  .overview-card-number {
    display: block;
    margin-bottom: 1.8rem;
    color: var(--text-faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.64rem;
  }

  .overview-card h2 {
    margin-bottom: 0.48rem;
    color: var(--text-strong);
    font-size: 0.96rem;
    font-weight: 680;
  }

  .overview-card p {
    margin-bottom: 0;
    color: var(--text-muted);
    font-size: 0.75rem;
    line-height: 1.55;
  }

  .port-notice {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.9rem;
    margin-bottom: 1rem;
    padding: 1rem;
    border-color: color-mix(in srgb, var(--warning) 23%, var(--border));
    background: var(--warning-soft);
  }

  .port-mark {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
    border-radius: 0.56rem;
    color: var(--warning);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.67rem;
    font-weight: 700;
  }

  .port-notice strong {
    display: block;
    margin-bottom: 0.2rem;
    color: var(--text-strong);
    font-size: 0.78rem;
  }

  .port-notice p {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.74rem;
    line-height: 1.55;
  }

  .surface {
    overflow: hidden;
    min-height: 20rem;
  }

  .surface-header {
    display: flex;
    gap: 1rem;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding: 0.9rem 1rem;
  }

  .surface-title {
    color: var(--text-strong);
    font-size: 0.78rem;
    font-weight: 680;
  }

  .surface-meta {
    color: var(--text-faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.61rem;
  }

  .empty-state {
    display: grid;
    place-items: center;
    min-height: 15rem;
    padding: 2rem;
    text-align: center;
  }

  .empty-state-mark {
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    margin: 0 auto 0.85rem;
    border: 1px dashed var(--border-strong);
    border-radius: 0.85rem;
    color: var(--text-faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.65rem;
  }

  .empty-state strong {
    display: block;
    margin-bottom: 0.32rem;
    color: var(--text);
    font-size: 0.8rem;
  }

  .empty-state p {
    max-width: 27rem;
    margin: 0;
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.55;
  }

  .preview-table {
    width: 100%;
    border-collapse: collapse;
  }

  .preview-table th {
    border-bottom: 1px solid var(--border);
    padding: 0.72rem 0.9rem;
    color: var(--text-faint);
    font-size: 0.62rem;
    font-weight: 700;
    text-align: left;
    text-transform: uppercase;
  }

  .preview-table td {
    padding: 0;
  }

  .preview-composer {
    display: grid;
    grid-template-columns: minmax(15rem, 0.75fr) minmax(18rem, 1.25fr);
    min-height: 18rem;
  }

  .composer-pane {
    border-right: 1px solid var(--border);
    padding: 1rem;
  }

  .composer-line,
  .timeline-line {
    height: 0.68rem;
    margin-bottom: 0.72rem;
    border-radius: 999px;
    background: var(--surface-3);
  }

  .composer-line:nth-child(2) {
    width: 76%;
  }

  .composer-line:nth-child(3) {
    width: 58%;
  }

  .preview-timeline {
    padding: 1.2rem;
  }

  .timeline-row {
    display: grid;
    grid-template-columns: minmax(7rem, 0.25fr) minmax(14rem, 1fr);
    gap: 1rem;
    align-items: center;
    min-height: 3rem;
    border-bottom: 1px solid var(--border);
  }

  .timeline-line {
    margin: 0;
  }

  .timeline-track {
    position: relative;
    height: 0.6rem;
    border-radius: 999px;
    background: var(--surface-3);
  }

  .timeline-track::after {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 18%;
    width: 34%;
    border-radius: inherit;
    background: color-mix(in srgb, var(--accent) 18%, var(--surface-3));
    content: "";
  }

  .preview-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.8rem;
    padding: 1rem;
  }

  .preview-card {
    min-height: 9rem;
    border: 1px solid var(--border);
    border-radius: 0.78rem;
    padding: 1rem;
    background: var(--surface-1);
  }

  .preview-card strong {
    display: block;
    margin-bottom: 1.2rem;
    color: var(--text-muted);
    font-size: 0.72rem;
  }

  .registration-frame {
    min-width: 0;
  }

  @media (max-width: 980px) {
    .shell {
      grid-template-columns: 14.5rem minmax(0, 1fr);
    }

    .overview-grid {
      grid-template-columns: 1fr;
    }

    .overview-card {
      min-height: 0;
    }

    .overview-card-number {
      margin-bottom: 1rem;
    }
  }

  @media (max-width: 760px) {
    .shell {
      display: block;
    }

    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(18rem, 86vw);
      box-shadow: 1rem 0 3rem rgb(0 0 0 / 38%);
      transform: translateX(-105%);
      transition: transform 180ms ease;
    }

    .sidebar[data-open="true"] {
      transform: translateX(0);
    }

    .menu-button {
      display: inline-block;
    }

    .environment {
      display: none;
    }

    .topbar {
      height: 4.3rem;
    }

    .route-context span {
      display: none;
    }

    .content {
      padding: 1.2rem;
    }

    .page-heading {
      display: block;
    }

    .badges {
      justify-content: flex-start;
      margin-top: 1rem;
    }

    .hero {
      min-height: 0;
      padding: 1.5rem;
    }

    .hero::before,
    .hero::after {
      display: none;
    }

    .preview-composer,
    .preview-cards {
      grid-template-columns: 1fr;
    }

    .composer-pane {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }

    .preview-table {
      min-width: 38rem;
    }

    .surface:has(.preview-table) {
      overflow-x: auto;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
`;
