// Requests to the PI -- Signatures, Rec Letters, Meeting Requests: three tabs, one form surface.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { isLogisticsTab } from "../../navigation.ts";
import { resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  openAdminBotLogisticsRequest,
  sendAdminBotSignedDocuments,
  setAdminBotLogisticsRequestStatus,
  submitAdminBotLogisticsRequest,
  submitAdminBotSignatureForm,
  updateAdminBotLogisticsRequest,
  withdrawAdminBotLogisticsRequest,
} from "../controllers/logistics.ts";
import {
  clearLogisticsDraft,
  clearMeetingRequestDraft,
  clearRecommendationLettersDraft,
  createFactRow,
  createSchoolRow,
  saveAdminBotLettersDraft,
  saveAdminBotLogisticsDraft,
  saveAdminBotMeetingDraft,
} from "../data/logistics-draft.ts";
import {
  describeSubmitBlock,
  filesToAttachments,
  filledFacts,
  filledMeetings,
  filledSchools,
  type LettersFormState,
  lettersRequestInput,
  type LogisticsRequestInput,
  type LogisticsRequestKind,
  type MeetingFormState,
  meetingRequestInput,
  requestToFormState,
  type SignatureFormState,
  signatureRequestInput,
} from "../data/logistics-requests.ts";
import {
  downloadDraftCopies,
  draftScope,
  draftSyncStatus,
  importLegacyDraft,
  resolveDraftConflict,
} from "../offline/draft-sync.ts";
import { type LogisticsTemplate, renderAdminBotLogistics } from "../views/logistics.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderLogisticsSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { accessRole, logisticsScope, logisticsTemplate, requestHostUpdate } = scope;
  return isLogisticsTab(state.tab)
    ? renderAdminBotLogistics({
        role: accessRole,
        mode: state.adminBotLogisticsMode,
        onModeChange: (mode) => {
          state.adminBotLogisticsMode = mode;
          state.adminBotLogisticsOpenRequestId = null;
          state.adminBotLogisticsOpenRequest = null;
          // Clearing the stamp is what asks for a re-read; the effect above does the fetch,
          // so entering the list has one path whether it was reached by this button or by a
          // reload that landed on it. Re-read on every entry rather than once: an admin may
          // have answered a request since the last look.
          state.adminBotLogisticsRequestsLoadedAt = null;
        },
        requests: {
          requests: state.adminBotLogisticsRequests,
          loading: state.adminBotLogisticsRequestsLoading,
          error: state.adminBotLogisticsRequestsError,
          open: state.adminBotLogisticsOpenRequest,
          openLoading: state.adminBotLogisticsOpenLoading,
          viewerIsAdmin: accessRole === "admin",
          viewerMemberId: state.memberId ?? null,
          onOpenRequest: (requestId) => {
            state.adminBotLogisticsStatusNote = "";
            void openAdminBotLogisticsRequest(state, requestId).finally(() =>
              requestHostUpdate?.(),
            );
          },
          onEdit: (requestId) => {
            const request = state.adminBotLogisticsOpenRequest;
            if (!request || request.id !== requestId) {
              return;
            }
            // Loaded from the request that was read in full, so the documents come back with
            // it rather than having to be picked off the member's disk again.
            const form = requestToFormState(request);
            if (form.signature) {
              state.setTab("adminbotSignatures");
              state.adminBotLogisticsSignatureFiles = form.signature.files;
              state.adminBotLogisticsDescription = form.signature.description;
              state.adminBotLogisticsAttachments = form.signature.attachments;
            } else if (form.letters) {
              state.setTab("adminbotRecLetters");
              state.adminBotLettersSchools = [...form.letters.schools];
              state.adminBotLettersFacts = [...form.letters.facts];
              state.adminBotLettersCvOverleafUrl = form.letters.cvOverleafUrl;
              state.adminBotLettersDriveFolderUrl = form.letters.driveFolderUrl;
            } else if (form.meeting) {
              state.setTab("adminbotMeetingRequests");
              state.adminBotMeetingRows = [...form.meeting.rows];
            }
            state.adminBotLogisticsEditingId = requestId;
            state.adminBotLogisticsSubmittedId = null;
            state.adminBotLogisticsCallSheetNote = null;
            state.adminBotLogisticsSubmitError = null;
            state.adminBotLogisticsMode = "make";
            state.adminBotLogisticsOpenRequest = null;
            state.adminBotLogisticsOpenRequestId = null;
          },
          onWithdraw: (requestId) => {
            void withdrawAdminBotLogisticsRequest(state, requestId).finally(() =>
              requestHostUpdate?.(),
            );
          },
          onSetStatus: (requestId, status, note) => {
            void setAdminBotLogisticsRequestStatus(state, requestId, status, note).finally(() => {
              state.adminBotLogisticsStatusNote = "";
              requestHostUpdate?.();
            });
          },
          statusNote: state.adminBotLogisticsStatusNote,
          onStatusNoteChange: (note) => {
            state.adminBotLogisticsStatusNote = note;
          },
        },
        queue: {
          options: state.adminBotLogisticsQueueOptions,
          onOptionsChange: (patch) => {
            state.adminBotLogisticsQueueOptions = {
              ...state.adminBotLogisticsQueueOptions,
              ...patch,
            };
          },
          requests: state.adminBotLogisticsRequests,
          loading: state.adminBotLogisticsRequestsLoading,
          error: state.adminBotLogisticsRequestsError,
          showSettled: state.adminBotLogisticsShowSettled,
          onShowSettledChange: (showSettled) => {
            state.adminBotLogisticsShowSettled = showSettled;
          },
          signingId: state.adminBotLogisticsSigningId,
          signedNote: state.adminBotLogisticsSignedNote,
          onSignedNoteChange: (note) => {
            state.adminBotLogisticsSignedNote = note;
          },
          onSendSigned: (requestId, files) => {
            void (async () => {
              const documents = await filesToAttachments(files);
              const sent = await sendAdminBotSignedDocuments(
                state,
                requestId,
                documents,
                state.adminBotLogisticsSignedNote,
              );
              if (sent) {
                // The note belonged to the request that just went out; leaving it in the box
                // would attach it to whichever one is signed next.
                state.adminBotLogisticsSignedNote = "";
              }
              requestHostUpdate?.();
            })();
          },
          onOpenRequest: (requestId) => {
            state.adminBotLogisticsStatusNote = "";
            void openAdminBotLogisticsRequest(state, requestId).finally(() =>
              requestHostUpdate?.(),
            );
          },
          onSetStatus: (requestId, status) => {
            void setAdminBotLogisticsRequestStatus(state, requestId, status, "").finally(() =>
              requestHostUpdate?.(),
            );
          },
        },
        template: logisticsTemplate,
        signature: {
          files: state.adminBotLogisticsSignatureFiles,
          onFilesChange: (files) => {
            state.adminBotLogisticsSignatureFiles = files;
            void saveAdminBotLogisticsDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            );
          },
          description: state.adminBotLogisticsDescription,
          onDescriptionChange: (description) => {
            state.adminBotLogisticsDescription = description;
            void saveAdminBotLogisticsDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            );
          },
          attachments: state.adminBotLogisticsAttachments,
          onAttachmentsChange: (files) => {
            state.adminBotLogisticsAttachments = files;
            void saveAdminBotLogisticsDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            );
          },
          sync: {
            ...draftSyncStatus(logisticsScope, "document-signature"),
            onImportLegacy: () => {
              void importLegacyDraft(logisticsScope, "document-signature");
            },
            onDownload: () => {
              void downloadDraftCopies(logisticsScope, "document-signature");
            },
            onResolve: (choice: "mine" | "server") => {
              void resolveDraftConflict(logisticsScope, "document-signature", choice).finally(() =>
                requestHostUpdate?.(),
              );
            },
          },
          form: state.adminBotSignatureForm,
          onForm: (patch) => {
            state.adminBotSignatureForm = { ...state.adminBotSignatureForm, ...patch };
            // Editing after a send re-arms the tab: "Sent" must not describe something older
            // than what is on screen.
            state.adminBotSignatureSubmitted = false;
            state.adminBotSignatureError = null;
            requestHostUpdate?.();
          },
          onSendForm: () => submitAdminBotSignatureForm(state).finally(() => requestHostUpdate?.()),
          sendingForm: state.adminBotSignatureSubmitting,
          formError: state.adminBotSignatureError,
          formSent: state.adminBotSignatureSubmitted,
          saving: state.adminBotLogisticsSaving,
          savedAt: state.adminBotLogisticsSavedAt,
          saveError: state.adminBotLogisticsSaveError,
          onSave: () =>
            void saveAdminBotLogisticsDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            ),
          ...adminBotLogisticsSubmitProps(state, requestHostUpdate, "documentSignature"),
        },
        meeting: {
          rows: state.adminBotMeetingRows,
          onRowsChange: (rows) => {
            state.adminBotMeetingRows = rows;
            void saveAdminBotMeetingDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            );
          },
          sync: {
            ...draftSyncStatus(logisticsScope, "book-meeting"),
            onImportLegacy: () => {
              void importLegacyDraft(logisticsScope, "book-meeting");
            },
            onDownload: () => {
              void downloadDraftCopies(logisticsScope, "book-meeting");
            },
            onResolve: (choice: "mine" | "server") => {
              void resolveDraftConflict(logisticsScope, "book-meeting", choice).finally(() =>
                requestHostUpdate?.(),
              );
            },
          },
          saving: state.adminBotMeetingSaving,
          savedAt: state.adminBotMeetingSavedAt,
          saveError: state.adminBotMeetingSaveError,
          onSave: () =>
            void saveAdminBotMeetingDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            ),
          ...adminBotLogisticsSubmitProps(state, requestHostUpdate, "bookMeeting"),
        },
        letters: {
          schools: state.adminBotLettersSchools,
          onSchoolsChange: (schools) => {
            state.adminBotLettersSchools = schools;
            void saveAdminBotLettersDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            );
          },
          facts: state.adminBotLettersFacts,
          onFactsChange: (facts) => {
            state.adminBotLettersFacts = facts;
            void saveAdminBotLettersDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            );
          },
          onOpenMyProjects: () => state.setTab("myWork"),
          cvOverleafUrl: state.adminBotLettersCvOverleafUrl,
          onCvOverleafUrlChange: (url) => {
            state.adminBotLettersCvOverleafUrl = url;
            void saveAdminBotLettersDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            );
          },
          driveFolderUrl: state.adminBotLettersDriveFolderUrl,
          onDriveFolderUrlChange: (url) => {
            state.adminBotLettersDriveFolderUrl = url;
            void saveAdminBotLettersDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            );
          },
          sync: {
            ...draftSyncStatus(logisticsScope, "recommendation-letters"),
            onImportLegacy: () => {
              void importLegacyDraft(logisticsScope, "recommendation-letters");
            },
            onDownload: () => {
              void downloadDraftCopies(logisticsScope, "recommendation-letters");
            },
            onResolve: (choice: "mine" | "server") => {
              void resolveDraftConflict(logisticsScope, "recommendation-letters", choice).finally(
                () => requestHostUpdate?.(),
              );
            },
          },
          saving: state.adminBotLettersSaving,
          savedAt: state.adminBotLettersSavedAt,
          saveError: state.adminBotLettersSaveError,
          onSave: () =>
            void saveAdminBotLettersDraft(state, adminBotLogisticsScope(state)).finally(() =>
              requestHostUpdate?.(),
            ),
          ...adminBotLogisticsSubmitProps(state, requestHostUpdate, "recommendationLetters"),
        },
      })
    : nothing;
}

export function adminBotLogisticsScope(state: AppViewState): string {
  return draftScope(resolveAdminBotBaseUrl(state.settings), state.memberId ?? "anonymous");
}

/** The three form states, in the shape the request builders and the "can this be sent" check want. */
export function adminBotSignatureForm(state: AppViewState): SignatureFormState {
  return {
    files: state.adminBotLogisticsSignatureFiles,
    description: state.adminBotLogisticsDescription,
    attachments: state.adminBotLogisticsAttachments,
  };
}

export function adminBotLettersForm(state: AppViewState): LettersFormState {
  return {
    schools: state.adminBotLettersSchools,
    facts: state.adminBotLettersFacts,
    cvOverleafUrl: state.adminBotLettersCvOverleafUrl,
    driveFolderUrl: state.adminBotLettersDriveFolderUrl,
  };
}

/** The form behind one template, in the shape the builders and the "can this be sent" check want. */
export function adminBotLogisticsForm(
  state: AppViewState,
  template: LogisticsTemplate,
): SignatureFormState | LettersFormState | MeetingFormState {
  if (template === "documentSignature") {
    return adminBotSignatureForm(state);
  }
  if (template === "recommendationLetters") {
    return adminBotLettersForm(state);
  }
  return { rows: state.adminBotMeetingRows };
}

export const LOGISTICS_KIND: Record<LogisticsTemplate, LogisticsRequestKind> = {
  documentSignature: "document_signature",
  recommendationLetters: "recommendation_letters",
  bookMeeting: "book_meeting",
};

/** Whether there is anything on this form to lose, which is what Discard is offered for. */
export function adminBotLogisticsHasContent(
  state: AppViewState,
  template: LogisticsTemplate,
): boolean {
  if (template === "documentSignature") {
    return Boolean(
      state.adminBotLogisticsSignatureFiles.length ||
      state.adminBotLogisticsDescription.trim() ||
      state.adminBotLogisticsAttachments.length,
    );
  }
  if (template === "recommendationLetters") {
    return Boolean(
      filledSchools(state.adminBotLettersSchools).length ||
      filledFacts(state.adminBotLettersFacts).length ||
      state.adminBotLettersCvOverleafUrl.trim() ||
      state.adminBotLettersDriveFolderUrl.trim(),
    );
  }
  return filledMeetings(state.adminBotMeetingRows).length > 0;
}

/** Everything a form loses when it is discarded, or when the request it held has been filed. */
export function resetAdminBotLogisticsForm(state: AppViewState, template: LogisticsTemplate): void {
  if (template === "documentSignature") {
    state.adminBotLogisticsSignatureFiles = [];
    state.adminBotLogisticsDescription = "";
    state.adminBotLogisticsAttachments = [];
    state.adminBotLogisticsSaving = false;
    state.adminBotLogisticsSavedAt = null;
    state.adminBotLogisticsSaveError = null;
    return;
  }
  if (template === "recommendationLetters") {
    // Back to one blank row rather than none: an empty table has nothing to type in.
    state.adminBotLettersSchools = [createSchoolRow()];
    state.adminBotLettersFacts = [createFactRow()];
    state.adminBotLettersCvOverleafUrl = "";
    state.adminBotLettersDriveFolderUrl = "";
    state.adminBotLettersSaving = false;
    state.adminBotLettersSavedAt = null;
    state.adminBotLettersSaveError = null;
    return;
  }
  // Book Meeting opens empty on purpose: creating a row stamps "submitted", so a blank one would
  // claim a request nobody made.
  state.adminBotMeetingRows = [];
  state.adminBotMeetingSaving = false;
  state.adminBotMeetingSavedAt = null;
  state.adminBotMeetingSaveError = null;
}

export async function clearAdminBotLogisticsDraft(
  template: LogisticsTemplate,
  scope: string,
): Promise<void> {
  try {
    if (template === "documentSignature") {
      await clearLogisticsDraft(scope);
    } else if (template === "recommendationLetters") {
      await clearRecommendationLettersDraft(scope);
    } else {
      await clearMeetingRequestDraft(scope);
    }
  } catch {
    // A draft that would not clear is a stale form, not lost work: the member is looking at an
    // empty one either way, and reporting a storage failure here would be noise.
  }
}

export function adminBotLogisticsRequestInput(
  state: AppViewState,
  template: LogisticsTemplate,
): Promise<LogisticsRequestInput> {
  if (template === "documentSignature") {
    // The only one that is async: the picked files are read into base64 here.
    return signatureRequestInput(adminBotSignatureForm(state));
  }
  if (template === "recommendationLetters") {
    return Promise.resolve(lettersRequestInput(adminBotLettersForm(state)));
  }
  return Promise.resolve(meetingRequestInput({ rows: state.adminBotMeetingRows }));
}

/**
 * Submit, discard and "why not" for one request template.
 *
 * Shared by all three because the three differ only in which form state they read: the button
 * behaviour -- refuse to double-send, clear the form and its draft once the service has the
 * request, leave everything untouched when it does not -- is the same request either way.
 */
export function adminBotLogisticsSubmitProps(
  state: AppViewState,
  requestHostUpdate: (() => void) | undefined,
  template: LogisticsTemplate,
) {
  const form = adminBotLogisticsForm(state, template);
  const kind = LOGISTICS_KIND[template];
  const blocked = state.memberId
    ? describeSubmitBlock(kind, form)
    : // Signing in is the first thing missing, and saying so beats a 401 after the upload.
      ({ reason: "signed-out" } as const);
  return {
    submitting: state.adminBotLogisticsSubmitting,
    submitError: state.adminBotLogisticsSubmitError,
    submitted: Boolean(state.adminBotLogisticsSubmittedId),
    ...(state.adminBotLogisticsCallSheetNote
      ? { submittedNote: state.adminBotLogisticsCallSheetNote }
      : {}),
    submitBlocked: blocked,
    hasContent: adminBotLogisticsHasContent(state, template),
    editing: Boolean(state.adminBotLogisticsEditingId),
    onCancelEdit: () => {
      state.adminBotLogisticsEditingId = null;
      resetAdminBotLogisticsForm(state, template);
      requestHostUpdate?.();
    },
    onSubmit: () => {
      if (blocked) {
        // Nothing to send yet. The reason is already on screen next to the button, so pressing it
        // is how a member finds out rather than a dead click.
        return;
      }
      void (async () => {
        const input = await adminBotLogisticsRequestInput(state, template);
        const editingId = state.adminBotLogisticsEditingId;
        // A correction is a PUT against the request already in the queue: sending it as a new one
        // would leave the member with two asks for the same thing and an admin deciding which is
        // current.
        const filed = editingId
          ? await updateAdminBotLogisticsRequest(state, editingId, input)
          : Boolean(
              await submitAdminBotLogisticsRequest(state, input, adminBotLogisticsScope(state)),
            );
        if (filed) {
          state.adminBotLogisticsEditingId = null;
          state.adminBotLogisticsSubmittedId = editingId ?? state.adminBotLogisticsSubmittedId;
          resetAdminBotLogisticsForm(state, template);
        }
        requestHostUpdate?.();
      })();
    },
    onDiscard: () => {
      void (async () => {
        resetAdminBotLogisticsForm(state, template);
        state.adminBotLogisticsSubmittedId = null;
        state.adminBotLogisticsCallSheetNote = null;
        state.adminBotLogisticsSubmitError = null;
        await clearAdminBotLogisticsDraft(template, adminBotLogisticsScope(state));
        requestHostUpdate?.();
      })();
    },
  };
}
