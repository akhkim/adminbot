import { css } from "lit";

export const registrationStyles = css`
  :host {
    --ink: #172219;
    --muted: #687169;
    --paper: #fbfbf7;
    --line: #dce1d8;
    --accent: #176b49;
    --accent-dark: #0e4c34;
    --accent-soft: #e8f4ec;
    --danger: #a33232;
    display: block;
    min-height: 100vh;
    color: var(--ink);
    background:
      radial-gradient(circle at 12% 18%, rgb(222 240 228 / 74%), transparent 30rem),
      linear-gradient(145deg, #f8f8f2 0%, #eef3ed 100%);
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  * {
    box-sizing: border-box;
  }

  main {
    display: grid;
    grid-template-columns: minmax(17rem, 0.8fr) minmax(20rem, 1.2fr);
    gap: clamp(2rem, 6vw, 7rem);
    align-items: start;
    width: min(72rem, calc(100% - 2rem));
    margin: 0 auto;
    padding: clamp(2rem, 7vh, 6rem) 0;
  }

  .intro {
    position: sticky;
    top: 3rem;
    padding: 1rem 0;
  }

  .eyebrow {
    margin: 0 0 1rem;
    color: var(--accent);
    font-size: 0.76rem;
    font-weight: 750;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h1 {
    max-width: 12ch;
    margin: 0;
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(2.75rem, 7vw, 5.4rem);
    font-weight: 500;
    letter-spacing: -0.055em;
    line-height: 0.96;
  }

  .lede {
    max-width: 31rem;
    margin: 1.75rem 0 0;
    color: var(--muted);
    font-size: 1.02rem;
    line-height: 1.65;
  }

  .card {
    overflow: hidden;
    border: 1px solid rgb(255 255 255 / 80%);
    border-radius: 1.35rem;
    background: rgb(251 251 247 / 92%);
    box-shadow: 0 1.5rem 4rem rgb(37 55 42 / 12%);
    backdrop-filter: blur(14px);
  }

  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 0.45rem;
    border-bottom: 1px solid var(--line);
    background: #f1f3ee;
  }

  .tabs button {
    border: 0;
    border-radius: 0.8rem;
    padding: 0.8rem 0.65rem;
    color: var(--muted);
    background: transparent;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
  }

  .tabs button[aria-selected="true"] {
    color: var(--ink);
    background: var(--paper);
    box-shadow: 0 0.15rem 0.7rem rgb(30 50 35 / 9%);
  }

  form,
  .pending {
    padding: clamp(1.35rem, 4vw, 2.4rem);
  }

  .form-heading {
    margin: 0 0 0.4rem;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 1.75rem;
    font-weight: 500;
  }

  .form-note {
    margin: 0 0 1.6rem;
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  label,
  fieldset {
    display: grid;
    gap: 0.42rem;
    min-width: 0;
    margin: 0;
    color: #344037;
    font-size: 0.78rem;
    font-weight: 720;
    letter-spacing: 0.015em;
  }

  label.full,
  fieldset.full {
    grid-column: 1 / -1;
  }

  input,
  textarea {
    width: 100%;
    border: 1px solid #cdd4cb;
    border-radius: 0.7rem;
    padding: 0.72rem 0.78rem;
    color: var(--ink);
    outline: none;
    background: white;
    font: inherit;
    font-size: 0.93rem;
    font-weight: 450;
    letter-spacing: normal;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }

  input:focus,
  textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgb(23 107 73 / 13%);
  }

  textarea {
    min-height: 6rem;
    resize: vertical;
  }

  .roster {
    max-height: 14rem;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 0.75rem;
    background: white;
  }

  .roster button {
    display: block;
    width: 100%;
    border: 0;
    border-bottom: 1px solid #edf0eb;
    padding: 0.72rem 0.8rem;
    color: var(--ink);
    text-align: left;
    background: transparent;
    cursor: pointer;
  }

  .roster button:last-child {
    border-bottom: 0;
  }

  .roster button[aria-selected="true"] {
    color: var(--accent-dark);
    background: var(--accent-soft);
    font-weight: 720;
  }

  .roster-state {
    margin: 0;
    padding: 1rem;
    color: var(--muted);
    font-size: 0.86rem;
    font-weight: 450;
  }

  .error {
    grid-column: 1 / -1;
    margin: 0;
    border-left: 3px solid var(--danger);
    padding: 0.65rem 0.8rem;
    color: var(--danger);
    background: #fff2f0;
    font-size: 0.86rem;
    font-weight: 600;
  }

  .submit {
    grid-column: 1 / -1;
    margin-top: 0.4rem;
    border: 0;
    border-radius: 0.75rem;
    padding: 0.88rem 1rem;
    color: white;
    background: var(--accent);
    font: inherit;
    font-weight: 760;
    cursor: pointer;
  }

  .submit:hover:not(:disabled) {
    background: var(--accent-dark);
  }

  .submit:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .pending-mark {
    display: grid;
    place-items: center;
    width: 3.2rem;
    height: 3.2rem;
    border-radius: 999px;
    color: var(--accent-dark);
    background: var(--accent-soft);
    font-size: 1.4rem;
  }

  .pending h2 {
    margin: 1.2rem 0 0.5rem;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 2rem;
    font-weight: 500;
  }

  .pending p {
    margin: 0;
    color: var(--muted);
    line-height: 1.6;
  }

  @media (max-width: 760px) {
    main {
      grid-template-columns: 1fr;
      gap: 1.3rem;
      padding: 1.2rem 0 2.5rem;
    }

    .intro {
      position: static;
    }

    h1 {
      max-width: 10ch;
    }

    .fields {
      grid-template-columns: 1fr;
    }

    label.full,
    fieldset.full,
    .error,
    .submit {
      grid-column: 1;
    }
  }
`;
