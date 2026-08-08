import { css } from "lit";

export const identityStyles = css`
  :host {
    display: block;
    color: var(--text, #d5ded8);
  }

  * { box-sizing: border-box; }
  button, input, textarea, select { font: inherit; }

  .identity-layout {
    display: grid;
    grid-template-columns: minmax(15rem, 0.72fr) minmax(22rem, 1.28fr);
    gap: clamp(2rem, 5vw, 5rem);
    align-items: start;
  }

  .intro { position: sticky; top: 7rem; padding: 0.7rem 0; }
  .eyebrow {
    margin: 0 0 0.8rem;
    color: var(--accent, #77e5ad);
    font-size: 0.65rem;
    font-weight: 790;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  h1 {
    max-width: 12ch;
    margin: 0;
    color: var(--text-strong, #f1f6f2);
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(2.65rem, 6vw, 5.3rem);
    font-weight: 500;
    letter-spacing: -0.052em;
    line-height: 0.96;
  }
  .lede {
    max-width: 29rem;
    margin: 1.4rem 0 0;
    color: var(--text-muted, #89978f);
    font-size: 0.9rem;
    line-height: 1.65;
  }
  .card {
    border: 1px solid var(--border, #26332c);
    border-radius: 1.05rem;
    padding: clamp(1.25rem, 3.5vw, 2.2rem);
    background: var(--surface-2, #131c17);
    box-shadow: var(--shadow, 0 1.4rem 4rem rgb(0 0 0 / 32%));
  }
  h2 {
    margin: 0 0 0.4rem;
    color: var(--text-strong, #f1f6f2);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 1.65rem;
    font-weight: 500;
  }
  .note, .meta {
    color: var(--text-muted, #89978f);
    font-size: 0.76rem;
    line-height: 1.55;
  }
  form { display: grid; gap: 1rem; margin-top: 1.5rem; }
  label {
    display: grid;
    gap: 0.4rem;
    color: var(--text-muted, #89978f);
    font-size: 0.68rem;
    font-weight: 710;
  }
  input, textarea, select {
    width: 100%;
    border: 1px solid var(--border-strong, #34443b);
    border-radius: 0.62rem;
    padding: 0.68rem 0.72rem;
    color: var(--text-strong, #f1f6f2);
    outline: none;
    background: var(--surface-1, #0e1511);
    font-size: 0.82rem;
  }
  input:focus, textarea:focus, select:focus {
    border-color: var(--accent, #77e5ad);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #77e5ad) 13%, transparent);
  }
  textarea { min-height: 5.5rem; resize: vertical; }
  .password-field { position: relative; }
  .password-field input { padding-right: 4.8rem; }
  .reveal {
    position: absolute;
    right: 0.38rem;
    bottom: 0.37rem;
    min-height: 2rem;
    border: 0;
    padding: 0 0.55rem;
    color: var(--text-muted, #89978f);
    background: transparent;
    font-size: 0.68rem;
    cursor: pointer;
  }
  .primary, .secondary, .danger {
    border-radius: 0.68rem;
    padding: 0.76rem 0.9rem;
    font-size: 0.75rem;
    font-weight: 760;
    cursor: pointer;
  }
  .primary { border: 0; color: var(--accent-ink, #062417); background: var(--accent, #77e5ad); }
  .secondary { border: 1px solid var(--border-strong, #34443b); color: var(--text, #d5ded8); background: var(--surface-3, #18231d); }
  .danger { border: 1px solid color-mix(in srgb, var(--danger, #f28e8e) 35%, var(--border)); color: var(--danger, #f28e8e); background: transparent; }
  button:disabled { opacity: 0.55; cursor: wait; }
  .error, .pending-notice {
    margin: 0;
    border-left: 3px solid var(--danger, #f28e8e);
    padding: 0.7rem 0.8rem;
    color: var(--danger, #f28e8e);
    background: color-mix(in srgb, var(--danger, #f28e8e) 8%, transparent);
    font-size: 0.74rem;
    line-height: 1.5;
  }
  .pending-notice { border-color: var(--warning, #e8bd6b); color: var(--warning, #e8bd6b); }
  .link { color: var(--accent-strong, #9af0c3); }
  .queue { display: grid; gap: 0.8rem; }
  .queue-toolbar { display: flex; gap: 0.65rem; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .queue-toolbar select { width: auto; min-width: 10rem; }
  .registration {
    border: 1px solid var(--border, #26332c);
    border-radius: 0.82rem;
    padding: 1rem;
    background: var(--surface-1, #0e1511);
  }
  .registration-head { display: flex; gap: 1rem; align-items: start; justify-content: space-between; }
  .registration h3 { margin: 0 0 0.25rem; color: var(--text-strong, #f1f6f2); font-size: 0.9rem; }
  .tag { border: 1px solid var(--border); border-radius: 999px; padding: 0.25rem 0.5rem; color: var(--text-muted); font-size: 0.61rem; text-transform: uppercase; }
  .registration-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 0.55rem; margin-top: 0.85rem; }
  .empty { padding: 3rem 1rem; color: var(--text-muted); text-align: center; font-size: 0.78rem; }

  @media (max-width: 760px) {
    .identity-layout { grid-template-columns: 1fr; }
    .intro { position: static; }
    .registration-actions { grid-template-columns: 1fr 1fr; }
    .registration-actions textarea { grid-column: 1 / -1; }
  }
`;
