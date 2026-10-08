/** Exact interview assignment approved together with the candidate's invitation. */
export type InterviewInvitation = {
  task: string;
  project: string;
  interviewer_ids: string[];
};

export function readInterviewInvitation(value: unknown): InterviewInvitation {
  const input = value as Partial<InterviewInvitation> | null;
  if (
    !input ||
    typeof input.task !== "string" ||
    !input.task.trim() ||
    input.task.length > 12000 ||
    typeof input.project !== "string" ||
    !input.project.trim() ||
    input.project.length > 200 ||
    /[\r\n]/u.test(input.project) ||
    !Array.isArray(input.interviewer_ids) ||
    input.interviewer_ids.length !== 2 ||
    new Set(input.interviewer_ids).size !== 2 ||
    !input.interviewer_ids.every((id) => typeof id === "string" && /^[UW][A-Z0-9]+$/u.test(id))
  ) {
    throw new Error(
      "Enter a project, a task (up to 12,000 characters), and two distinct interviewers with Slack accounts.",
    );
  }
  return {
    task: input.task.trim(),
    project: input.project.trim(),
    interviewer_ids: [...input.interviewer_ids],
  };
}

export const INTERVIEW_TASK_MARKER = "[[ADMINBOT_INTERVIEW_TASK]]";

export function interviewBody(_task: string): string {
  return `Hi {first_name},\n\nWe would like to invite you to complete an interview task for {project_or_context}.\n\n${INTERVIEW_TASK_MARKER}\n\nYour interviewers are {interviewer_names}. Please use your private interview Slack channel to ask questions and share your work: {slack_connect_link}\n\nBest,\n{sender_name}`;
}
