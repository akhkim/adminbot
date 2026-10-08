// The cycle panel's two "generate a draft" paths -- the LinkedIn post and the stage-specific X
// thread. Kept out of page.ts so it stays under its file-size ratchet; both store the result as
// an ordinary draft, so the usual sign-off row takes over from there.
import type {
  XAnnouncementDetails,
  XCreditSelection,
  XThreadDraft,
} from "../../../../../extensions/adminbot/src/workflows/papers/x-draft.js";
import type { AppViewState } from "../../app-view-state.ts";
import { draftLinkedInPost, draftXPost } from "../api/papers.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";

type SaveDraft = (paperId: string, platform: string, body: string, xThread?: XThreadDraft) => void;

// The old dialog's generate path, minus the PDF picker: the service reads the paper's Drive copy.
export async function generateLinkedInDraft(
  state: AppViewState,
  paper: AdminBotPaperRecord,
  onSaveDraft: SaveDraft,
  venue: string,
  note: string,
  pdfBase64?: string,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    globalThis.alert?.("Sign in first — drafting runs against your own session.");
    return;
  }
  try {
    const result = await draftLinkedInPost(
      {
        paperId: paper.id,
        ...(pdfBase64 ? { pdfBase64 } : {}),
        ...(paper.artifacts?.arxiv_url ? { url: paper.artifacts.arxiv_url } : {}),
        ...(venue ? { venue } : {}),
        ...(note ? { note } : {}),
      },
      stored.sessionToken ?? "",
      resolveAdminBotBaseUrl(state.settings),
    );
    if (!result.ok) {
      globalThis.alert?.(result.message ?? "Could not generate the draft.");
      return;
    }
    onSaveDraft(paper.id, "linkedin", result.value.text);
  } catch (error) {
    globalThis.alert?.((error as Error).message);
  }
}

export async function generateXDraft(
  state: AppViewState,
  paper: AdminBotPaperRecord,
  onSaveDraft: SaveDraft,
  pdfBase64?: string,
  announcement?: XAnnouncementDetails,
  credits?: XCreditSelection,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    globalThis.alert?.("Sign in first.");
    return;
  }
  try {
    const result = await draftXPost(
      {
        paperId: paper.id,
        ...(announcement ? { announcement } : {}),
        ...(credits ? { credits } : {}),
        ...(pdfBase64 ? { pdfBase64 } : {}),
        ...(paper.artifacts?.arxiv_url ? { url: paper.artifacts.arxiv_url } : {}),
      },
      stored.sessionToken ?? "",
      resolveAdminBotBaseUrl(state.settings),
    );
    if (!result.ok) {
      globalThis.alert?.(result.message ?? "Could not generate the X thread.");
      return;
    }
    onSaveDraft(paper.id, "x", result.value.posts.map((post) => post.text).join("\n\n"), {
      stage: announcement?.stage ?? "arxiv",
      posts: result.value.posts,
    });
    if (result.value.issues.length) {
      globalThis.alert?.(result.value.issues.join("\n"));
    }
  } catch (error) {
    globalThis.alert?.((error as Error).message);
  }
}
