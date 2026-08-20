---
name: adminbot-social-posts
description: Draft and propose AdminBot social media actions. Use for drafting tweets or social posts, amplifying another researcher's work, preparing public announcements, or proposing public posting through approval-gated AdminBot actions.
---

# AdminBot Social Posts

Use this skill for social media drafting and public posting proposals.

## Drafting

1. Identify the subject, source work, audience, and tone.
2. Gather source links and evidence pointers.
3. Use `adminbot_prepare_paper_social_posts` to build the posts. It proposes
   `social_media.post_publicly`, which is the only social action a connector
   actually publishes.
4. Use `adminbot-linkedin-from-twitter` when a paper LinkedIn post should be
   generated from the PaperPublish spreadsheet `twitter_draft` column or a
   `Twitter Thread` link.
5. Use `adminbot_prepare_paper_social_posts` for paper announcements that
   should go to LinkedIn and X after approval.
6. Keep claims factual and attributable.

## Paper Announcements

For prompted papers, prefer `adminbot_prepare_paper_social_posts`. Provide a
paper id when the paper is already in AdminBot, or provide title, summary, URL,
and authors explicitly. The tool resolves author tags from the lab member list:

- `X:` or `Twitter:` for X handles.
- `LinkedIn:` for visible LinkedIn tags or profile URLs.
- `LinkedIn URN:` when the exact LinkedIn member URN is known.

If a requested author's tag is missing, tell the user which member needs to be
updated before approval. Do not guess public handles.

If the source material is a Twitter/X post or thread in the PaperPublish
spreadsheet, first use `adminbot-linkedin-from-twitter` to transform the
Twitter-style draft into LinkedIn copy. Authors may split long X posts across
thread comments, so gather the full authored thread before producing the
LinkedIn version.

## Amplifying Others' Work

When drafting praise or amplification for someone else's work:

- keep it low-friction and accurate,
- avoid implying collaboration or endorsement unless supported,
- avoid overclaiming novelty or importance,
- include the source link when available.

## Publishing

Public posting is T4. For papers, `adminbot_prepare_paper_social_posts` creates
the `social_media.post_publicly` proposal with LinkedIn text, X thread posts,
resolved tags, missing tags, and undo plan. For non-paper posts, use
`adminbot_propose_action` with `type="social_media.post_publicly"` only after the
user confirms the exact text or linked draft.
