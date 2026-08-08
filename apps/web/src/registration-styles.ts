import { css } from "lit";

export const registrationStyles = css`
  :host {
    display: block;
    color: var(--text, #d5ded8);
  }

  * {
    box-sizing: border-box;
  }

  button,
  input,
  textarea {
    font: inherit;
  }

  main {
    display: grid;
    grid-template-columns: minmax(15rem, 0.72fr) minmax(22rem, 1.28fr);
    gap: clamp(2rem, 5vw, 5rem);
    align-items: start;
  }

  .intro {
    position: sticky;
    top: 7rem;
    padding: 0.7rem 0;
  }

  .eyebrow {
    margin: 0 0 0.8rem;
    color: var(--accent, #77e5ad);
    font-size: 0.65rem;
    font-weight: 790;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  h1 {
    max-width: 11ch;
    margin: 0;
    color: var(--text-strong, #f1f6f2);
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(2.65rem, 6vw, 5.3rem);
    font-weight: 500;
    letter-spacing: -0.052em;
    line-height: 0.96;
  }

  .lede {
    max-width: 28rem;
    margin: 1.4rem 0 0;
    color: var(--text-muted, #89978f);
    font-size: 0.9rem;
    line-height: 1.65;
  }

  .card {
    overflow: hidden;
    border: 1px solid var(--border, #26332c);
    border-radius: 1.05rem;
    background: var(--surface-2, #131c17);
    box-shadow: var(--shadow, 0 1.4rem 4rem rgb(0 0 0 / 32%));
  }

  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 0.38rem;
    border-bottom: 1px solid var(--border, #26332c);
    background: var(--surface-1, #0e1511);
  }

  .tabs button {
    border: 0;
    border-radius: 0.68rem;
    padding: 0.76rem 0.55rem;
    color: var(--text-muted, #89978f);
    background: transparent;
    font-size: 0.75rem;
    font-weight: 690;
    cursor: pointer;
  }

  .tabs button:hover {
    color: var(--text, #d5ded8);
  }

  .tabs button[aria-selected="true"] {
    color: var(--text-strong, #f1f6f2);
    background: var(--surface-3, #18231d);
    box-shadow: 0 0.15rem 0.7rem rgb(0 0 0 / 12%);
  }

  form,
  .pending {
    padding: clamp(1.25rem, 3.5vw, 2.2rem);
  }

  .form-heading {
    margin: 0 0 0.38rem;
    color: var(--text-strong, #f1f6f2);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 1.65rem;
    font-weight: 500;
  }

  .form-note {
    margin: 0 0 1.5rem;
    color: var(--text-muted, #89978f);
    font-size: 0.77rem;
    line-height: 1.55;
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.92rem;
  }

  label,
  fieldset {
    display: grid;
    gap: 0.4rem;
    min-width: 0;
    margin: 0;
    color: var(--text-muted, #89978f);
    font-size: 0.68rem;
    font-weight: 710;
    letter-spacing: 0.02em;
  }

  label.full,
  fieldset.full {
    grid-column: 1 / -1;
  }

  input,
  textarea {
    width: 100%;
    border: 1px solid var(--border-strong, #34443b);
    border-radius: 0.62rem;
    padding: 0.68rem 0.72rem;
    color: var(--text-strong, #f1f6f2);
    outline: none;
    background: var(--surface-1, #0e1511);
    font-size: 0.82rem;
    font-weight: 450;
    letter-spacing: normal;
    transition: 120ms ease;
    transition-property: border-color, box-shadow, background;
  }

  input::placeholder,
  textarea::placeholder {
    color: var(--text-faint, #627068);
  }

  input:focus,
  textarea:focus {
    border-color: var(--accent, #77e5ad);
    background: var(--surface-2, #131c17);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #77e5ad) 13%, transparent);
  }

  textarea {
    min-height: 5.5rem;
    resize: vertical;
  }

  .roster {
    max-height: 14rem;
    overflow: auto;
    border: 1px solid var(--border, #26332c);
    border-radius: 0.68rem;
    background: var(--surface-1, #0e1511);
    scrollbar-width: thin;
  }

  .roster button {
    display: block;
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--border, #26332c);
    padding: 0.68rem 0.75rem;
    color: var(--text, #d5ded8);
    text-align: left;
    background: transparent;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .roster button:last-child {
    border-bottom: 0;
  }

  .roster button:hover {
    background: var(--surface-hover, #1d2a23);
  }

  .roster button[aria-selected="true"] {
    color: var(--accent-strong, #9af0c3);
    background: var(--accent-soft, rgb(65 198 132 / 12%));
    font-weight: 720;
  }

  .roster-state {
    margin: 0;
    padding: 1rem;
    color: var(--text-muted, #89978f);
    font-size: 0.75rem;
    font-weight: 450;
  }

  fieldset > span {
    color: var(--text-muted, #89978f);
    font-size: 0.69rem;
    font-weight: 520;
  }

  .error {
    grid-column: 1 / -1;
    margin: 0;
    border-left: 3px solid var(--danger, #f28e8e);
    padding: 0.62rem 0.75rem;
    color: var(--danger, #f28e8e);
    background: color-mix(in srgb, var(--danger, #f28e8e) 8%, transparent);
    font-size: 0.74rem;
    font-weight: 610;
  }

  .submit {
    grid-column: 1 / -1;
    margin-top: 0.35rem;
    border: 0;
    border-radius: 0.68rem;
    padding: 0.82rem 1rem;
    color: var(--accent-ink, #062417);
    background: var(--accent, #77e5ad);
    font-weight: 780;
    cursor: pointer;
  }

  .submit:hover:not(:disabled) {
    background: var(--accent-strong, #9af0c3);
  }

  .submit:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  .pending-mark {
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    border: 1px solid color-mix(in srgb, var(--accent, #77e5ad) 26%, var(--border, #26332c));
    border-radius: 0.8rem;
    color: var(--accent-strong, #9af0c3);
    background: var(--accent-soft, rgb(65 198 132 / 12%));
    font-size: 1.1rem;
  }

  .pending h2 {
    margin: 1.1rem 0 0.45rem;
    color: var(--text-strong, #f1f6f2);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 1.85rem;
    font-weight: 500;
  }

  .pending p {
    margin: 0;
    color: var(--text-muted, #89978f);
    font-size: 0.8rem;
    line-height: 1.65;
  }

  @media (max-width: 940px) {
    main {
      grid-template-columns: 1fr;
      gap: 1.4rem;
    }

    .intro {
      position: static;
    }

    h1 {
      max-width: 14ch;
      font-size: clamp(2.6rem, 10vw, 4.6rem);
    }
  }

  @media (max-width: 560px) {
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
