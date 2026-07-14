---
name: adminbot-linkedin-from-twitter
description: Generate a LinkedIn post for a paper from its Twitter/X draft or thread. Use this whenever the user asks AdminBot to turn a paper's Twitter post, X thread, twitter_draft, or spreadsheet social-post row into a LinkedIn version, especially for PaperPublish social_posts work.
---

# AdminBot LinkedIn From Twitter

Use this skill to produce a LinkedIn-ready paper announcement from the paper's
Twitter/X material. The output is a draft unless the user explicitly asks for an
approval-gated public posting proposal.

## Source Lookup

1. Identify the paper title or paper id from the user's request.
2. Read the PaperPublish spreadsheet:
   `https://docs.google.com/spreadsheets/d/1dLqwcWo-gmzQ9TOtRgoSpYguKsh-t_uG7_S-JnOcllY/edit?gid=1634319760#gid=1634319760`.
3. Use `gog` for the spreadsheet lookup when available. If only `gws` is
   available in the environment, use the same authenticated Google Sheets path.
4. Resolve gid `1634319760` to the sheet/tab name before reading rows when the
   CLI requires a tab name.
5. Match the paper by case-insensitive normalized title. Ignore punctuation,
   repeated spaces, and common title prefixes such as `paper:`. If multiple rows
   match, ask the user to choose before drafting.
6. Treat column names case-insensitively and normalize spaces, hyphens, and
   underscores. Prefer these columns:
   - paper title: `paper`, `paper_name`, `title`, or `Paper Name`
   - draft source: `twitter_draft`
   - fallback thread source: `Twitter Thread`
   - supporting links: paper PDF, arXiv, Google Drive, project, venue, authors,
     and LinkedIn draft columns when present

## Source Selection

Prefer the first usable source:

1. Non-empty `twitter_draft` cell.
2. The thread at the `Twitter Thread` link.
3. User-supplied Twitter/X text or URL.

When using a Twitter/X thread link, collect the main post plus any author thread
continuations/replies needed to complete the announcement. Authors sometimes
split a long post across comments to bypass character limits, so combine the
thread in posted order before rewriting. Do not include unrelated replies,
quote-tweets, or audience comments.

If the thread cannot be fetched because the page is blocked, private, deleted,
or requires login, tell the user exactly which source failed and ask for the
thread text unless `twitter_draft` is already available.

## LinkedIn Rewrite

Rewrite the source into a LinkedIn post, not a copied tweet:

- Lead with the paper title and the main contribution.
- Use a professional but warm lab voice.
- Keep the post factual and attributable to the source material or spreadsheet.
- Convert X/Twitter shorthand into complete sentences.
- Remove thread markers, duplicate links, excessive emoji, and reply scaffolding.
- Preserve important author credits and links.
- Include the paper/project/arXiv/Drive link if the row has one.
- Use at most three relevant hashtags, and only if they are supported by the
  paper topic.
- Do not invent performance numbers, claims of novelty, venue acceptance, or
  author affiliations.

Aim for 900-1,600 characters unless the user asks for a shorter or longer post.
Use 2-4 short paragraphs plus an optional final link or call to action.

## AdminBot Output

For draft-only requests, use `adminbot_draft_social_post` with:

- `subject`: `LinkedIn post for <paper title>`
- `sourceWork`: a concise note naming the spreadsheet row, the source column,
  and the Twitter/X thread URL when used
- `audience`: `LinkedIn research audience`
- `tone`: the selected tone or `professional, clear, and celebratory`
- `evidence`: spreadsheet URL, row identifier, source column, and thread URL

Return the LinkedIn draft text to the user with a short source note.

For publication requests, use `adminbot_prepare_paper_social_posts` with
`platforms=["linkedin"]` after the user confirms the exact LinkedIn text. Public
posting is T4 and must remain approval-gated; never post directly from this
skill.

## Response Shape

Use this shape:

```markdown
LinkedIn draft:
[post text]

Source:
- Paper: [title]
- Spreadsheet source: [twitter_draft or Twitter Thread]
- Thread: [URL or "not used"]

Approval path:
[Draft only, or the AdminBot action/proposal id if one was created]
```
