import { Context } from "../../context";

export async function handleIssueCommentCreated(event: Context<"issue_comment.created">) {
  if (event.payload.comment.user.type === "Bot") {
    console.log("Skipping bot comment");
    return;
  }

  await event.octokit.issues.createComment({
    owner: event.payload.repository.owner.login,
    repo: event.payload.repository.name,
    issue_number: event.payload.issue.number,
    body: "Hello from the worker!",
  });
}
