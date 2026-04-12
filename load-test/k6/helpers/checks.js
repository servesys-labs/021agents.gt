/**
 * Custom k6 checks for AgentOS load tests.
 */
import { check } from "k6";

/** Check a sync /run response has the expected shape. */
export function checkRunResponse(res, name) {
  return check(res, {
    [`${name}: status 200`]: (r) => r.status === 200,
    [`${name}: has output`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.output === "string";
      } catch {
        return false;
      }
    },
    [`${name}: has session_id`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.session_id === "string" && body.session_id.length > 0;
      } catch {
        return false;
      }
    },
    [`${name}: has cost_usd`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.cost_usd === "number";
      } catch {
        return false;
      }
    },
  });
}

/** Check a stream response starts with SSE content-type. */
export function checkStreamResponse(res, name) {
  return check(res, {
    [`${name}: status 200`]: (r) => r.status === 200,
    [`${name}: content-type is SSE`]: (r) =>
      (r.headers["Content-Type"] || "").includes("text/event-stream"),
  });
}

/** Check a batch submission returns 202 with batch_id. */
export function checkBatchResponse(res, name) {
  return check(res, {
    [`${name}: status 202`]: (r) => r.status === 202,
    [`${name}: has batch_id`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.batch_id === "string" && body.batch_id.length > 0;
      } catch {
        return false;
      }
    },
  });
}

/** Check a conversation create returns 201. */
export function checkConversationResponse(res, name) {
  return check(res, {
    [`${name}: status 201`]: (r) => r.status === 201,
    [`${name}: has conversation_id`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.conversation_id === "string";
      } catch {
        return false;
      }
    },
  });
}
